// I callback DEVONO girare inline (non in background) per restare nel contesto
// AsyncLocalStorage della richiesta e attribuire correttamente i token.
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";

import { AsyncLocalStorage } from "async_hooks";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { PrismaClient } from "@prisma/client";
import { getPriceMap, FALLBACK_BASE_OUT } from "./pricing";

/**
 * Conteggio token PER-AGENTE pesato per modello.
 * - Ogni modello LangChain ha attaccato un TokenMeterHandler che, a fine chiamata,
 *   registra i token nell'accumulatore della richiesta corrente (AsyncLocalStorage).
 * - A fine run, server.ts chiama chargeAgent() per scalare i crediti dal saldo.
 *
 * I PESI riflettono il costo relativo dei modelli: Opus consuma molti più crediti
 * per token rispetto a un modello economico. Regolabili in base ai prezzi reali OpenRouter.
 */

export const MODEL_WEIGHTS: Record<string, number> = {
  "google/gemini-3.1-flash-lite": 1,
  "openai/text-embedding-3-small": 1,
  "perplexity/sonar": 5,
  "openai/gpt-5.4-mini": 10,
  "anthropic/claude-opus-4.6": 60,
  // Nuova scala (2026-08): peso = prezzo output $/M diviso il riferimento $1.5/M,
  // cioe' la stessa formula che chargeUser applica ai prezzi live.
  "openai/gpt-5.6-luna": 1, // $1.20/M out
  "openai/gpt-5.6-sol": 7, // $10/M out
  "openai/gpt-5.6-sol-pro": 7, // stesso prezzo di sol (reasoning "pro" = piu' token, non tariffa piu' alta)
  "anthropic/claude-opus-5": 17, // $25/M out
  "google/gemini-3.1-flash-image": 2, // $3/M out
};
export const DEFAULT_WEIGHT = 5;

export function weightFor(model: string): number {
  if (!model) return DEFAULT_WEIGHT;
  if (MODEL_WEIGHTS[model] !== undefined) return MODEL_WEIGHTS[model];
  // match parziale (es. provider/model:variant)
  for (const key of Object.keys(MODEL_WEIGHTS)) {
    if (model.includes(key)) return MODEL_WEIGHTS[key];
  }
  return DEFAULT_WEIGHT;
}

export interface UsageEntry {
  model: string;
  prompt: number;
  completion: number;
}
interface UsageAccumulator {
  entries: UsageEntry[];
}

export const usageStore = new AsyncLocalStorage<UsageAccumulator>();

/** Esegue fn dentro un nuovo accumulatore e ritorna le entry raccolte. */
export async function withMeter<T>(fn: () => Promise<T>): Promise<{ result: T; entries: UsageEntry[] }> {
  const acc: UsageAccumulator = { entries: [] };
  const result = await usageStore.run(acc, fn);
  return { result, entries: acc.entries };
}

/** Registra manualmente un consumo (es. embeddings via fetch diretto). */
export function recordUsage(model: string, prompt: number, completion: number) {
  const acc = usageStore.getStore();
  if (acc) acc.entries.push({ model, prompt: prompt || 0, completion: completion || 0 });
}

/** Callback handler da attaccare ai modelli LangChain (uno per modello noto). */
export class TokenMeterHandler extends BaseCallbackHandler {
  name = "token-meter";
  constructor(private model: string) {
    super();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleLLMEnd(output: any): Promise<void> {
    const u = output?.llmOutput?.tokenUsage || output?.llmOutput?.estimatedTokenUsage || {};
    const prompt = u.promptTokens ?? u.prompt_tokens ?? 0;
    const completion = u.completionTokens ?? u.completion_tokens ?? 0;
    if (prompt || completion) recordUsage(this.model, prompt, completion);
  }
}

/** Calcola i crediti pesati totali da una lista di consumi. */
export function totalCredits(entries: UsageEntry[]): number {
  return entries.reduce((sum, e) => sum + Math.ceil((e.prompt + e.completion) * weightFor(e.model)), 0);
}

/** Scrive il ledger TokenUsage e scala i crediti dal saldo dell'UTENTE (modello SaaS). */
export async function chargeUser(
  prisma: PrismaClient,
  userId: string | null | undefined,
  entries: UsageEntry[],
  source: string
): Promise<number> {
  if (!userId || entries.length === 0) return 0;

  // Peso = COSTO REALE relativo a un RIFERIMENTO FISSO ($1.5/M output).
  // NB: NON normalizzare sul "modello base" corrente: se il base è economico (es. DeepSeek
  // a $0.20/M) i modelli costosi verrebbero gonfiati (Opus 125x invece di ~17x) e il saldo
  // crollerebbe. Con riferimento fisso la scala dei crediti resta stabile e coerente coi prezzi.
  const priceMap = await getPriceMap();
  const baseOut = FALLBACK_BASE_OUT;
  const weightOf = (model: string) => (priceMap[model]?.outP || baseOut) / baseOut;

  const byModel: Record<string, { prompt: number; completion: number; credits: number }> = {};
  let total = 0;
  for (const e of entries) {
    const credits = Math.ceil((e.prompt + e.completion) * weightOf(e.model));
    total += credits;
    const m = (byModel[e.model] ||= { prompt: 0, completion: 0, credits: 0 });
    m.prompt += e.prompt;
    m.completion += e.completion;
    m.credits += credits;
  }

  try {
    for (const [model, v] of Object.entries(byModel)) {
      await prisma.tokenUsage.create({
        data: { userId, model, promptTokens: v.prompt, completionTokens: v.completion, weightedCredits: v.credits, source },
      });
    }
    await prisma.user.update({
      where: { id: userId },
      data: { tokenBalance: { decrement: total }, tokensUsed: { increment: total } },
    });
  } catch (e) {
    console.error("[TokenMeter] Errore addebito utente:", e);
  }
  return total;
}

/** Addebito FISSO all'utente (es. 10.000 token per ogni immagine generata). */
export async function chargeFlat(
  prisma: PrismaClient,
  userId: string | null | undefined,
  credits: number,
  model: string,
  source: string
): Promise<number> {
  if (!userId || !credits || credits <= 0) return 0;
  try {
    await prisma.tokenUsage.create({
      data: { userId, model, promptTokens: 0, completionTokens: 0, weightedCredits: credits, source },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { tokenBalance: { decrement: credits }, tokensUsed: { increment: credits } },
    });
  } catch (e) {
    console.error("[TokenMeter] Errore addebito fisso:", e);
  }
  return credits;
}

/** Scrive il ledger TokenUsage e scala i crediti dal saldo dell'agente. */
export async function chargeAgent(
  prisma: PrismaClient,
  agentId: string | null | undefined,
  entries: UsageEntry[],
  source: string
): Promise<number> {
  if (!agentId || entries.length === 0) return 0;

  const byModel: Record<string, { prompt: number; completion: number; credits: number }> = {};
  let total = 0;
  for (const e of entries) {
    const credits = Math.ceil((e.prompt + e.completion) * weightFor(e.model));
    total += credits;
    const m = (byModel[e.model] ||= { prompt: 0, completion: 0, credits: 0 });
    m.prompt += e.prompt;
    m.completion += e.completion;
    m.credits += credits;
  }

  try {
    for (const [model, v] of Object.entries(byModel)) {
      await prisma.tokenUsage.create({
        data: { agentId, model, promptTokens: v.prompt, completionTokens: v.completion, weightedCredits: v.credits, source },
      });
    }
    await prisma.agentInstance.update({
      where: { id: agentId },
      data: { tokenBalance: { decrement: total }, tokensUsed: { increment: total } },
    });
  } catch (e) {
    console.error("[TokenMeter] Errore addebito:", e);
  }
  return total;
}

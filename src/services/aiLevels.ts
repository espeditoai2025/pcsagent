import { PrismaClient } from "@prisma/client";

/**
 * Ladder dei "gradi di intelligenza": 3 livelli → 3 modelli.
 * Default impostati; modificabili dall'admin (Setting key "ai_models").
 * L'utente vede solo il grado (Base/Avanzato/Massimo), non il nome del modello.
 */
export const DEFAULT_LEVEL_MODELS: Record<number, string> = {
  1: "google/gemini-3.1-flash-lite", // Base — veloce/economico
  2: "openai/gpt-5.4-mini", // Avanzato
  3: "anthropic/claude-opus-4.8", // Massimo
};

export const LEVEL_LABELS: Record<number, string> = { 1: "Base", 2: "Avanzato", 3: "Massimo" };

let cache: { models: Record<number, string>; ts: number } | null = null;
const TTL = 60_000;

export async function getLevelModels(prisma: PrismaClient): Promise<Record<number, string>> {
  if (cache && Date.now() - cache.ts < TTL) return cache.models;
  const models = { ...DEFAULT_LEVEL_MODELS };
  try {
    const s = await prisma.setting.findUnique({ where: { key: "ai_models" } });
    if (s?.value) {
      const p = JSON.parse(s.value);
      if (p["1"]) models[1] = p["1"];
      if (p["2"]) models[2] = p["2"];
      if (p["3"]) models[3] = p["3"];
    }
  } catch {
    /* usa i default */
  }
  cache = { models, ts: Date.now() };
  return models;
}

export async function modelForLevel(prisma: PrismaClient, level: number | null | undefined): Promise<string> {
  const m = await getLevelModels(prisma);
  const lvl = level && m[level] ? level : 1;
  return m[lvl] || DEFAULT_LEVEL_MODELS[1];
}

/**
 * Modello dell'ORCHESTRATORE (Supervisor): scelto SEMPRE solido, a prescindere dal grado
 * che l'utente sceglie per generare. Smistare bene è critico (se sbaglia il nodo, sbaglia tutto)
 * ma costa pochissimo (output minuscolo). Override admin via Setting "router_model";
 * altrimenti usa il modello del livello "Avanzato" (configurabile in "ai_models").
 */
export const ORCHESTRATOR_DEFAULT = "openai/gpt-5.4-mini";

export async function routerModelName(prisma: PrismaClient): Promise<string> {
  try {
    const s = await prisma.setting.findUnique({ where: { key: "router_model" } });
    if (s?.value) return s.value.trim();
  } catch {
    /* usa il fallback */
  }
  try {
    const models = await getLevelModels(prisma);
    if (models[2]) return models[2]; // livello "Avanzato"
  } catch {
    /* usa il default */
  }
  return ORCHESTRATOR_DEFAULT;
}

/**
 * Modello "occhi" per LEGGERE le immagini allegate (deve essere multimodale).
 * Quando l'utente allega un'immagine, questo modello la converte in testo per il resto
 * dell'agente (così i modelli solo-testo, es. DeepSeek, continuano a funzionare).
 * Configurabile dall'admin via Setting "vision_model"; default: Gemini flash-lite (economico).
 */
export const VISION_DEFAULT = "google/gemini-3.1-flash-lite";

export async function visionModelName(prisma: PrismaClient): Promise<string> {
  try {
    const s = await prisma.setting.findUnique({ where: { key: "vision_model" } });
    if (s?.value) return s.value.trim();
  } catch {
    /* usa il default */
  }
  return VISION_DEFAULT;
}

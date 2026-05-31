import { PrismaClient } from "@prisma/client";
import parser from "cron-parser";
import { executePythonScript } from "./dockerService";
import { decryptSecret } from "../utils/crypto";
import { FACEBOOK_POST_SCRIPT } from "./socialTemplates";
import { modelForLevel } from "./aiLevels";
import { chargeUser } from "./tokenMeter";

const TICK_MS = 60_000;

// Job attualmente in esecuzione: evita che un tick successivo (ogni 60s) ri-prenda
// un job la cui esecuzione dura piu del tick e lo ripubblichi (doppione).
const running = new Set<string>();

/** Calcola il prossimo orario di esecuzione da una cron expression + timezone. */
export function computeNextRun(cronExpression: string, timezone: string, from: Date = new Date()): Date | null {
  try {
    const it = parser.parseExpression(cronExpression, { tz: timezone || "Europe/Rome", currentDate: from });
    return it.next().toDate();
  } catch (e) {
    console.error(`[Scheduler] Cron non valido "${cronExpression}":`, (e as Error).message);
    return null;
  }
}

async function runJob(prisma: PrismaClient, job: any): Promise<void> {
  const run = await prisma.scheduledJobRun.create({ data: { jobId: job.id, status: "OK" } });
  try {
    // Credenziali: prima dall'AGENTE proprietario del job, poi fallback al profilo utente (legacy).
    let credPageId: string | null | undefined;
    let credToken: string | null | undefined;
    let companyName: string | null | undefined;
    if (job.agentId) {
      const agent = await prisma.agentInstance.findUnique({
        where: { id: job.agentId },
        select: { fbPageId: true, fbAccessToken: true, name: true },
      });
      credPageId = agent?.fbPageId;
      credToken = agent?.fbAccessToken;
      companyName = agent?.name;
    }
    if (!credToken) {
      const user = await prisma.user.findUnique({
        where: { id: job.userId },
        select: { fbPageId: true, fbAccessToken: true, companyName: true },
      });
      credPageId = credPageId || user?.fbPageId;
      credToken = credToken || user?.fbAccessToken;
      companyName = companyName || user?.companyName;
    }
    // Agente social (pagina FB): fornisce pagina, branding e (se ha una connessione) il token da usare.
    let sa: { fbPageId: string; bizName: string | null; bizAddress: string | null; bizWhatsapp: string | null; bizWebsite: string | null; connection: { accessToken: string } | null } | null = null;
    if (job.socialAgentId) {
      sa = await prisma.socialAgent.findUnique({
        where: { id: job.socialAgentId },
        select: { fbPageId: true, bizName: true, bizAddress: true, bizWhatsapp: true, bizWebsite: true, connection: { select: { accessToken: true } } },
      });
    }
    // Token: prima quello della connessione dell'agente (token multipli), poi il token di default del profilo.
    const encToken = sa?.connection?.accessToken || credToken;
    // La pagina target: prima il job, poi l'agente social, infine la pagina di default.
    const pageId = job.fbPageId || sa?.fbPageId || credPageId;
    if (!pageId || !encToken) {
      throw new Error("Pagina o token Facebook non configurati.");
    }
    const token = decryptSecret(encToken);

    const env: Record<string, string> = {
      FB_PAGE_ID: pageId,
      FB_ACCESS_TOKEN: token,
      SOURCE_TYPE: job.sourceType,
      SOURCE_REF: job.sourceRef,
      ROW_INDEX: String(job.cursor || 0),
      POSTS_PER_RUN: String(job.postsPerRun || 1),
      SELECTION_MODE: job.selectionMode || "SEQUENTIAL",
      CAPTION_TEMPLATE: job.captionTemplate || "",
      AI_CAPTION: job.aiCaption ? "true" : "false",
      AI_MODEL: await modelForLevel(prisma, job.aiLevel),
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
      COMPANY_NAME: companyName || "",
      // Branding: prima il job, poi l'agente social della pagina, infine il profilo.
      BIZ_NAME: job.bizName || sa?.bizName || companyName || "",
      BIZ_ADDRESS: job.bizAddress || sa?.bizAddress || "",
      BIZ_WHATSAPP: job.bizWhatsapp || sa?.bizWhatsapp || "",
      BIZ_WEBSITE: job.bizWebsite || sa?.bizWebsite || "",
    };

    const result = await executePythonScript(FACEBOOK_POST_SCRIPT, { env, workspace: job.userId });

    // Conteggia i token della caption AI (riportati dallo script come "AI_USAGE p c model")
    const um = (result.output || "").match(/AI_USAGE (\d+) (\d+) (\S+)/);
    if (um) {
      await chargeUser(prisma, job.userId, [{ model: um[3], prompt: parseInt(um[1], 10), completion: parseInt(um[2], 10) }], "social").catch(() => {});
    }

    const out = (result.output || "").slice(0, 2000);
    const ok = result.success && out.includes("POST_OK");

    await prisma.scheduledJobRun.update({
      where: { id: run.id },
      data: {
        status: ok ? "OK" : "ERROR",
        output: out,
        error: ok ? null : (result.error || out).slice(0, 2000),
        finishedAt: new Date(),
      },
    });

    const nextCursor =
      job.selectionMode === "RANDOM"
        ? Math.floor(Math.random() * 100000)
        : (job.cursor || 0) + (job.postsPerRun || 1); // avanza di N prodotti

    await prisma.scheduledJob.update({
      where: { id: job.id },
      data: {
        lastRunAt: new Date(),
        lastStatus: ok ? "OK" : "ERROR",
        lastError: ok ? null : (result.error || out).slice(0, 500),
        cursor: nextCursor,
        nextRunAt: computeNextRun(job.cronExpression, job.timezone),
      },
    });
    console.log(`[Scheduler] Job ${job.id} (${job.name}): ${ok ? "OK" : "ERRORE"}`);
  } catch (e: any) {
    await prisma.scheduledJobRun
      .update({
        where: { id: run.id },
        data: { status: "ERROR", error: String(e.message).slice(0, 2000), finishedAt: new Date() },
      })
      .catch(() => {});
    await prisma.scheduledJob
      .update({
        where: { id: job.id },
        data: {
          lastRunAt: new Date(),
          lastStatus: "ERROR",
          lastError: String(e.message).slice(0, 500),
          nextRunAt: computeNextRun(job.cronExpression, job.timezone),
        },
      })
      .catch(() => {});
    console.error(`[Scheduler] Job ${job.id} errore:`, e.message);
  }
}

async function tick(prisma: PrismaClient): Promise<void> {
  const now = new Date();
  // 1) Job attivi senza nextRunAt: calcolalo (NON eseguire subito).
  const toInit = await prisma.scheduledJob.findMany({ where: { status: "ACTIVE", nextRunAt: null } });
  for (const j of toInit) {
    await prisma.scheduledJob
      .update({ where: { id: j.id }, data: { nextRunAt: computeNextRun(j.cronExpression, j.timezone) } })
      .catch(() => {});
  }
  // 2) Job scaduti: eseguili (in sequenza per non saturare la RAM del VPS).
  const due = await prisma.scheduledJob.findMany({
    where: { status: "ACTIVE", nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 5,
  });
  for (const j of due) {
    // Se e gia in esecuzione (run lungo che sfora il tick), salta: niente doppioni.
    if (running.has(j.id)) continue;
    running.add(j.id);
    try {
      await runJob(prisma, j);
    } finally {
      running.delete(j.id);
    }
  }
}

let started = false;
export function startScheduler(prisma: PrismaClient): void {
  if (started) return;
  started = true;
  console.log("[Scheduler] Avviato (tick ogni 60s).");
  setTimeout(() => tick(prisma).catch(console.error), 10_000);
  setInterval(() => tick(prisma).catch(console.error), TICK_MS);
}

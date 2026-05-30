import { PrismaClient } from "@prisma/client";
import parser from "cron-parser";
import { executePythonScript } from "./dockerService";
import { decryptSecret } from "../utils/crypto";
import { FACEBOOK_POST_SCRIPT } from "./socialTemplates";

const TICK_MS = 60_000;

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
    const user = await prisma.user.findUnique({
      where: { id: job.userId },
      select: { fbPageId: true, fbAccessToken: true, companyName: true },
    });
    // La pagina target e quella del job (multi-pagina); fallback alla pagina di default dell'utente.
    const pageId = job.fbPageId || user?.fbPageId;
    if (!pageId || !user?.fbAccessToken) {
      throw new Error("Pagina o token Facebook non configurati.");
    }
    const token = decryptSecret(user.fbAccessToken);

    const env: Record<string, string> = {
      FB_PAGE_ID: pageId,
      FB_ACCESS_TOKEN: token,
      SOURCE_TYPE: job.sourceType,
      SOURCE_REF: job.sourceRef,
      ROW_INDEX: String(job.cursor || 0),
      CAPTION_TEMPLATE: job.captionTemplate || "",
      AI_CAPTION: job.aiCaption ? "true" : "false",
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
      COMPANY_NAME: user.companyName || "",
    };

    const result = await executePythonScript(FACEBOOK_POST_SCRIPT, { env });
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
      job.selectionMode === "RANDOM" ? Math.floor(Math.random() * 100000) : (job.cursor || 0) + 1;

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
    await runJob(prisma, j);
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

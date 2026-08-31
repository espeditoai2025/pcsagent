import { PrismaClient } from "@prisma/client";
import parser from "cron-parser";
import { executePythonScript } from "./dockerService";
import { decryptSecret } from "../utils/crypto";
import { FACEBOOK_POST_SCRIPT, WEBSITE_SCRAPE_SCRIPT } from "./socialTemplates";
import { modelForLevel } from "./aiLevels";
import { chargeUser, chargeFlat } from "./tokenMeter";
import { scanAgentComments } from "./commentResponder";
import { friendlyError } from "./socialErrors";

const TICK_MS = 60_000;

// Job attualmente in esecuzione: evita che un tick successivo (ogni 60s) ri-prenda
// un job la cui esecuzione dura piu del tick e lo ripubblichi (doppione).
const running = new Set<string>();
// Agenti la cui scansione commenti e in corso (evita sovrapposizioni).
const replyRunning = new Set<string>();

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

async function runJob(prisma: PrismaClient, job: any, opts: { preview?: boolean } = {}): Promise<{ caption: string; image: string } | void> {
  const run = opts.preview ? null : await prisma.scheduledJobRun.create({ data: { jobId: job.id, status: "OK" } });
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
    let sa: { fbPageId: string; bizName: string | null; bizAddress: string | null; bizWhatsapp: string | null; bizWebsite: string | null; bizContext: string | null; imagePool: string[]; autoImage: boolean; connection: { accessToken: string } | null } | null = null;
    if (job.socialAgentId) {
      sa = await prisma.socialAgent.findUnique({
        where: { id: job.socialAgentId },
        select: { fbPageId: true, bizName: true, bizAddress: true, bizWhatsapp: true, bizWebsite: true, bizContext: true, imagePool: true, autoImage: true, connection: { select: { accessToken: true } } },
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
      // Immagini: pool caricato + generazione AI quando manca
      POOL_FILES: (sa?.imagePool || []).join(","),
      POOL_INDEX: String(job.cursor || 0),
      AUTO_IMAGE: sa?.autoImage ? "true" : "false",
      IMAGE_CONTEXT: sa?.bizContext || job.bizName || sa?.bizName || companyName || "",
    };

    // WEBSITE: scansiona il sito alla prima esecuzione O quando l'elenco di URL cambia,
    // salva i contenuti e poi ruota tra quelli salvati generando post sempre diversi.
    // sourceRef può contenere PIÙ URL separati da virgola/punto e virgola/spazio/a-capo (max 5).
    if (job.sourceType === "WEBSITE") {
      const normUrl = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const urls = String(job.sourceRef || "").split(/[\s,;]+/).map((u) => u.trim()).filter(Boolean).slice(0, 5);
      let items = await prisma.scrapedItem.findMany({ where: { scheduledJobId: job.id }, orderBy: { createdAt: "asc" } });
      // Le righe con content VUOTO sono SEGNAPOSTO: registrano che un URL e' gia' stato
      // scansionato anche quando non ha prodotto contenuti. Non si pubblicano mai.
      const usableOf = (rows: typeof items) => rows.filter((x) => (x.content || "").trim());

      // URL cambiati dopo l'ultima scansione? Butta la cache e ri-scansiona da zero.
      // Solo se un elenco di URL c'e' davvero: un sourceRef svuotato per errore dal pannello
      // non deve cancellare i contenuti gia' estratti.
      if (items.length > 0 && urls.length > 0) {
        const scanned = new Set(items.map((x) => normUrl(x.sourceUrl || "")));
        const wanted = new Set(urls.map(normUrl));
        const changed = [...wanted].some((u) => !scanned.has(u)) || [...scanned].some((u) => !wanted.has(u));
        if (changed) {
          await prisma.scrapedItem.deleteMany({ where: { scheduledJobId: job.id } });
          items = [];
          job.cursor = 0; // riparti dal primo contenuto del nuovo sito
        }
      }

      // Quali URL vanno (ri)scansionati: quelli senza contenuti utilizzabili. Un URL gia'
      // provato ha il suo segnaposto e NON si ritenta subito (altrimenti si ri-scansiona a
      // ogni run), ma dopo 24h si', cosi' un sito momentaneamente giu' rientra da solo.
      const RISCANSIONE_MS = 24 * 3600_000;
      const adesso = Date.now();
      const perUrl = new Map<string, { utili: number; ultimo: number; ids: string[] }>();
      for (const x of items) {
        const k = normUrl(x.sourceUrl || "");
        const e = perUrl.get(k) || { utili: 0, ultimo: 0, ids: [] };
        if ((x.content || "").trim()) e.utili++;
        e.ultimo = Math.max(e.ultimo, x.createdAt.getTime());
        e.ids.push(x.id);
        perUrl.set(k, e);
      }
      const daScansionare = urls.filter((u) => {
        const e = perUrl.get(normUrl(u));
        return !e || (e.utili === 0 && adesso - e.ultimo > RISCANSIONE_MS);
      });

      let lastOut = "";
      if (daScansionare.length > 0) {
        // Via i segnaposto scaduti dei soli URL che stiamo per ri-scansionare: i contenuti
        // degli altri URL restano dove sono.
        const vecchi = daScansionare.flatMap((u) => perUrl.get(normUrl(u))?.ids || []);
        if (vecchi.length > 0) await prisma.scrapedItem.deleteMany({ where: { id: { in: vecchi } } });
        // Le pagine si scansionano in PARALLELO: dockerService ha gia' il suo semaforo, in
        // sequenza il costo era la SOMMA dei timeout di navigazione (45s l'uno, fino a 5 URL).
        const scrapes = await Promise.all(
          daScansionare.map(async (u) => ({ u, res: await executePythonScript(WEBSITE_SCRAPE_SCRIPT, { env: { SCRAPE_URL: u }, workspace: job.userId }) }))
        );
        for (const { u, res } of scrapes) {
          lastOut = (res.output || res.error || "").slice(0, 200);
          const m = (res.output || "").match(/SCRAPE_JSON (.+)/);
          let arr: any[] = [];
          try {
            const parsed = m ? JSON.parse(m[1]) : null;
            if (Array.isArray(parsed)) arr = parsed;
          } catch { /* JSON non valido */ }
          const rows = arr
            .slice(0, 30)
            .map((x: any) => ({
              scheduledJobId: job.id,
              title: String(x.title || "").slice(0, 200) || null,
              content: String(x.content || "").slice(0, 2000),
              imageUrl: String(x.imageUrl || "").slice(0, 1000) || null,
              sourceUrl: String(x.sourceUrl || u).slice(0, 1000),
            }))
            .filter((r) => r.content.trim());
          // Segnaposto per un URL che non ha dato nulla: senza, il confronto qui sopra lo
          // vedrebbe come "URL nuovo" a OGNI esecuzione e ri-scansionerebbe tutto il sito
          // azzerando il cursore (stesso post ripubblicato all'infinito).
          if (rows.length === 0) {
            rows.push({ scheduledJobId: job.id, title: null, content: "", imageUrl: null, sourceUrl: String(u).slice(0, 1000) });
          }
          // FUORI dal catch del JSON: un errore di scrittura sul DB non e' un problema di
          // scraping e non va mascherato da "nessun contenuto trovato".
          await prisma.scrapedItem.createMany({ data: rows });
        }
        items = await prisma.scrapedItem.findMany({ where: { scheduledJobId: job.id }, orderBy: { createdAt: "asc" } });
      }

      const usable = usableOf(items);
      if (usable.length === 0) {
        throw new Error(
          daScansionare.length > 0
            ? "Scraping del sito non riuscito o nessun contenuto trovato. " + lastOut
            : "L'ultima scansione del sito non ha trovato contenuti utilizzabili; verra' ritentata entro 24 ore. Controlla che l'indirizzo sia giusto e che le pagine abbiano del testo."
        );
      }
      const it = usable[(job.cursor || 0) % usable.length];
      env.WEB_TITLE = it.title || "";
      env.WEB_CONTENT = it.content || "";
      env.WEB_IMAGE = it.imageUrl || "";
      // Conta le immagini DISTINTE e valide del sito (no logo). Se sono poche (<=1, es. solo
      // la copertina) e l'AI è attiva, lo script genera un'immagine AI diversa per ogni post.
      const isLogoUrl = (u: string) => /logo|favicon|icon|sprite|brand/i.test(u || "");
      const distinctImgs = new Set(
        usable.map((x) => (x.imageUrl || "").trim()).filter((u) => /^https?:\/\//i.test(u) && !isLogoUrl(u))
      );
      env.FEW_SITE_IMAGES = distinctImgs.size <= 1 ? "true" : "false";
    }

    if (opts.preview) env.PREVIEW = "true";
    const result = await executePythonScript(FACEBOOK_POST_SCRIPT, { env, workspace: job.userId });

    // Conteggia i token della caption AI (riportati dallo script come "AI_USAGE p c model")
    const um = (result.output || "").match(/AI_USAGE (\d+) (\d+) (\S+)/);
    if (um) {
      await chargeUser(prisma, job.userId, [{ model: um[3], prompt: parseInt(um[1], 10), completion: parseInt(um[2], 10) }], "social").catch(() => {});
    }
    // Immagini generate con l'AI dentro il post: 10.000 token ciascuna
    const aiImgs = (result.output || "").match(/^\s*IMG_AI_GENERATED\s*$/gim);
    if (aiImgs && aiImgs.length) {
      await chargeFlat(prisma, job.userId, 10000 * aiImgs.length, "google/gemini-3.1-flash-lite-image", "image").catch(() => {});
    }

    // ANTEPRIMA: non pubblica, non scrive lo stato. Restituisce caption + immagine.
    if (opts.preview) {
      const pm = (result.output || "").match(/PREVIEW_JSON (.+)/);
      if (pm) {
        try {
          const d = JSON.parse(pm[1]);
          return { caption: String(d.caption || ""), image: String(d.image || "") };
        } catch { /* json non valido */ }
      }
      // Anche l'anteprima passa dal traduttore: e' l'ultimo punto che mostrava il log grezzo.
      throw new Error("Anteprima non riuscita: " + friendlyError(result.error || result.output).slice(0, 300));
    }

    const rawOut = result.output || "";
    const out = rawOut.slice(0, 2000);
    const published = rawOut.includes("POST_OK");
    // Errore FATALE (app bloccata, token morto): puo' arrivare DOPO che qualche riga e'
    // gia' partita, quindi non basta guardare l'exit code o la presenza di POST_OK.
    const fatal = /^FB_BLOCKED[ 	]+/m.test(rawOut);
    const okCount = (rawOut.match(/^POST_OK\b/gm) || []).length;
    const doneM = rawOut.match(/^ROWS_DONE (\d+)$/m);
    // Di quante righe far avanzare il cursore. Tre situazioni diverse, NON confondibili:
    //  1) ROWS_DONE c'e' -> lo script ha finito il ciclo e dice lui quante righe ha tentato;
    //  2) NESSUN log (dockerService va in timeout a 5 min o in eccezione: ritorna output "")
    //     -> il container e' stato ucciso e non sappiamo quanti post erano gia' partiti su
    //     Facebook: si avanza di postsPerRun, perche' ripubblicare doppioni e' peggio che
    //     saltare una riga;
    //  3) log presente ma senza ROWS_DONE -> lo script e' morto prima o dentro il ciclo
    //     (preflight FB_BLOCKED, fonte dati illeggibile, OOM kill): si avanza SOLO dei post
    //     di cui c'e' la prova nel log, quindi 0 se non ne e' uscito nessuno.
    const noLog = !rawOut.trim();
    const attempted = doneM ? Math.max(0, parseInt(doneM[1], 10)) : noLog ? job.postsPerRun || 1 : okCount;
    // Batch parziale: lo script esce 0 con UNA sola riga pubblicata su tante, e senza questo
    // controllo la scheda direbbe "OK" anche con la maggior parte dei post non usciti.
    const partial = !!doneM && okCount > 0 && okCount < attempted;
    const ok = result.success && published && !fatal && !partial;

    // Gli ID dei post pubblicati vanno salvati anche se il run e' finito in errore:
    // quei post ESISTONO su Facebook e servono all'auto-risposta ai commenti.
    if (published && job.socialAgentId) {
      const ids = Array.from(rawOut.matchAll(/\(id\s+([0-9_]+)\)/g)).map((m) => m[1]);
      if (ids.length) {
        await prisma.publishedPost
          .createMany({ data: ids.map((fbPostId) => ({ socialAgentId: job.socialAgentId as string, fbPostId })), skipDuplicates: true })
          .catch(() => {});
      }
    }

    if (run) await prisma.scheduledJobRun.update({
      where: { id: run.id },
      data: {
        status: ok ? "OK" : "ERROR",
        output: out,
        error: ok ? null : (result.error || out).slice(0, 2000),
        finishedAt: new Date(),
      },
    });

    // Il cursore avanza solo delle righe REALMENTE tentate (vedi "attempted" sopra): se lo
    // script si e' fermato a meta' batch, le righe non tentate devono restare in coda.
    // WEBSITE: 1 contenuto per volta, ma su un errore FATALE (app/token: nessun contenuto
    // sarebbe potuto uscire) si resta fermi. Sugli altri errori si avanza lo stesso, altrimenti
    // un singolo contenuto che Facebook rifiuta sempre bloccherebbe il job per sempre.
    const passoWebsite = fatal ? 0 : 1;
    const nextCursor =
      job.selectionMode === "RANDOM"
        ? Math.floor(Math.random() * 100000)
        : (job.cursor || 0) + (job.sourceType === "WEBSITE" ? passoWebsite : attempted);

    await prisma.scheduledJob.update({
      where: { id: job.id },
      data: {
        lastRunAt: new Date(),
        lastStatus: ok ? "OK" : "ERROR",
        // Messaggio leggibile per la scheda; l'output grezzo resta in scheduledJobRun.error.
        lastError: ok
          ? null
          : partial && !fatal
            ? `Pubblicati solo ${okCount} post su ${attempted}: le altre righe non sono uscite (dettagli nell'ultima esecuzione).`
            : friendlyError(result.error || out).slice(0, 500),
        // NB: friendlyError non tronca piu' da solo -> qui vale davvero il limite 500.
        cursor: nextCursor,
        nextRunAt: computeNextRun(job.cronExpression, job.timezone),
      },
    });
    console.log(`[Scheduler] Job ${job.id} (${job.name}): ${ok ? "OK" : "ERRORE"}`);
  } catch (e: any) {
    if (run) {
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
            lastError: friendlyError(String(e?.message ?? e ?? "")).slice(0, 500),
            nextRunAt: computeNextRun(job.cronExpression, job.timezone),
          },
        })
        .catch(() => {});
    }
    console.error(`[Scheduler] Job ${job.id} errore:`, e.message);
    if (opts.preview) throw e; // propaga all'endpoint di anteprima
  }
}

// Esegue un job in modalita ANTEPRIMA: genera testo+immagine SENZA pubblicare.
export async function previewJob(prisma: PrismaClient, job: any): Promise<{ caption: string; image: string }> {
  const r = await runJob(prisma, job, { preview: true });
  return r || { caption: "", image: "" };
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

  // 3) Auto-risposta ai commenti per gli agenti che l'hanno attivata.
  await tickAutoReply(prisma).catch((e) => console.error("[AutoReply] tick errore:", e.message));
}

// Scansiona i commenti degli agenti con auto-risposta attiva, rispettando la frequenza scelta.
async function tickAutoReply(prisma: PrismaClient): Promise<void> {
  const now = Date.now();
  const agents = await prisma.socialAgent.findMany({ where: { autoReply: true, active: true } });
  for (const a of agents) {
    const everyMs = (a.autoReplyEveryMin || 60) * 60_000;
    const last = a.autoReplyLastScan ? new Date(a.autoReplyLastScan).getTime() : 0;
    if (now - last < everyMs) continue;
    if (replyRunning.has(a.id)) continue;
    replyRunning.add(a.id);
    try {
      await scanAgentComments(prisma, a);
    } catch (e: any) {
      console.error(`[AutoReply] errore agente ${a.id}:`, e.message);
    } finally {
      replyRunning.delete(a.id);
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

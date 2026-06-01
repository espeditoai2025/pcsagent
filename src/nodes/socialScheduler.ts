import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { computeNextRun } from "../services/scheduler";
import { modelForLevel } from "../services/aiLevels";
import { chargeUser } from "../services/tokenMeter";
import { executePythonScript } from "../services/dockerService";
import { FACEBOOK_POST_SCRIPT } from "../services/socialTemplates";
import { listFacebookPages, getTokenPermissions, getPageAccessToken, getRecentPagePosts, FacebookPage } from "../services/facebook";
import { decryptSecret } from "../utils/crypto";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

const prisma = new PrismaClient();

const jobSchema = z.object({
  intent: z
    .enum(["TEST_NOW", "SCHEDULE", "NEED_INFO", "LIST_INFO", "LIST_JOBS", "EXPORT_POSTS"])
    .describe("TEST_NOW = pubblica subito; SCHEDULE = programma ricorrenti; LIST_INFO = elenca pagine/permessi del token; LIST_JOBS = elenca le pubblicazioni PROGRAMMATE/cron e il loro stato, o spiega perché non è stato pubblicato; EXPORT_POSTS = salva gli ultimi N post di una pagina in un CSV; NEED_INFO = mancano dati"),
  count: z.number().describe("Per EXPORT_POSTS: quanti post salvare (es. 'ultimi 10 post' = 10; default 10)"),
  missingInfo: z.string().describe("Se intent=NEED_INFO, messaggio IN PRIMA PERSONA che chiede cosa manca"),
  targetPageName: z.string().describe("Nome della pagina Facebook su cui pubblicare, se indicato dall'utente; altrimenti stringa vuota"),
  name: z.string().describe("Nome breve del job (solo per SCHEDULE)"),
  cronExpression: z.string().describe("Cron a 5 campi (solo SCHEDULE). Es: ogni giorno alle 9 = '0 9 * * *'"),
  sourceType: z.enum(["GOOGLE_SHEET", "EXCEL", "CSV", "TEXT"]).describe("TEXT = post di solo testo (tipico per un test rapido); CSV/EXCEL = file caricato; GOOGLE_SHEET = link"),
  sourceRef: z.string().describe("URL Google Sheet o nome file .csv/.xlsx; vuoto se sourceType=TEXT"),
  captionTemplate: z.string().describe("Per SCHEDULE: template con {colonna}. Per TEST_NOW/TEXT: il testo del post. Vuoto = default"),
  selectionMode: z.enum(["SEQUENTIAL", "RANDOM"]),
  postsPerRun: z.number().describe("Quanti prodotti pubblicare ad ogni esecuzione (default 1, se l'utente dice es. '3 prodotti')"),
});

const pageList = (pages: { name: string }[]) => pages.map((p) => `• ${p.name}`).join("\n");

// Sorgente token: profilo (connectionId null) o una connessione aggiunta.
type Src = { connectionId: string | null; name: string; token: string };
// Pagina con il token/connessione da cui proviene.
type PageX = FacebookPage & { connectionId: string | null; connName: string; token: string };

export const socialSchedulerNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  console.log("---SOCIAL SCHEDULER NODE---");
  const userData: any = state.userData || {};
  const userId = userData.id;
  if (!userId) return { finalResult: "Errore: utente non identificato." };

  // 1) Raccoglie TUTTE le sorgenti token: profilo + connessioni multiple.
  const sources: Src[] = [];
  if (userData.fbAccessToken && String(userData.fbAccessToken).trim()) {
    try { sources.push({ connectionId: null, name: "Principale", token: decryptSecret(userData.fbAccessToken) }); } catch { /* token profilo non decifrabile */ }
  }
  try {
    const conns = await prisma.socialConnection.findMany({ where: { userId }, select: { id: true, name: true, accessToken: true } });
    for (const c of conns) { try { sources.push({ connectionId: c.id, name: c.name, token: decryptSecret(c.accessToken) }); } catch { /* skip */ } }
  } catch { /* nessuna connessione */ }

  if (sources.length === 0) {
    return {
      finalResult:
        "Mi manca l'**Access Token** di Facebook. Aprilo dal **Profilo → Agente Social**, incolla il token " +
        "(la stringa lunga che inizia con `EAA…`) e premi *Salva credenziali*. Da quel token leggerò tutte le pagine che gestisci.",
    };
  }

  // 2) Interpreta la richiesta
  const sys = `Sei l'assistente che gestisce le pubblicazioni Facebook di un'azienda.
Il token è GIÀ configurato e l'utente può amministrare PIÙ pagine.

- targetPageName: se l'utente nomina una pagina (es. "sulla pagina Pcs Store"), riportala; altrimenti vuoto.
- intent=LIST_INFO: l'utente vuole SAPERE quali pagine gestisce o quali permessi ha il token
  (es. "quali pagine posso gestire?", "che permessi ho?", "mostrami le pagine collegate", "elenco pagine").
- intent=TEST_NOW: vuole pubblicare SUBITO (es. "fai un test", "pubblica ora"). Se non indica una fonte dati usa
  sourceType=TEXT (captionTemplate = testo del post se specificato, altrimenti vuoto).
- intent=SCHEDULE: pubblicazioni RICORRENTI. Servono frequenza (cronExpression da linguaggio naturale) e fonte
  dati (GOOGLE_SHEET con URL o EXCEL con nome file). captionTemplate con segnaposto {colonna} se descritto.
- intent=EXPORT_POSTS: l'utente vuole SALVARE/ESPORTARE gli ultimi N post di una pagina in un file CSV
  (es. "salvami gli ultimi 10 post della pagina X in un csv", "esporta i post di Pcs Bus"). Metti count = N (default 10).
- intent=LIST_JOBS: l'utente chiede quali PUBBLICAZIONI PROGRAMMATE / cron / automazioni ha attive, o
  PERCHÉ non è stato pubblicato (es. "hai cron job impostati?", "che pubblicazioni hai in programma?",
  "perché non hai pubblicato oggi su Pcs Store?", "hai automazioni attive?", "quando esce il prossimo post?").
- intent=NEED_INFO: SOLO se per SCHEDULE manca la fonte dati o la frequenza.`;

  let parsed: z.infer<typeof jobSchema>;
  try {
    parsed = await routerModel.withStructuredOutput(jobSchema).invoke([new SystemMessage(sys), ...state.messages]);
  } catch (e: any) {
    return { finalResult: `Non sono riuscito a interpretare la richiesta: ${e.message}` };
  }

  if (parsed.intent === "NEED_INFO") {
    return { finalResult: parsed.missingInfo || "Mi servono ancora alcune informazioni." };
  }

  // 2.4) LIST_JOBS: quali pubblicazioni programmate ho e perché (non) pubblico
  if (parsed.intent === "LIST_JOBS") {
    const fmtDt = (d: Date | null) => (d ? new Date(d).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }) : "—");
    let jobs = await prisma.scheduledJob.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { socialAgent: { select: { name: true } } },
    });
    // Se l'utente nomina una pagina, filtra su quella
    const q = (parsed.targetPageName || "").trim().toLowerCase();
    if (q) jobs = jobs.filter((j) => (j.fbPageName || j.socialAgent?.name || "").toLowerCase().includes(q));

    if (jobs.length === 0) {
      const dove = q ? ` per la pagina "${parsed.targetPageName}"` : "";
      return {
        finalResult:
          `Al momento **non hai nessuna pubblicazione programmata attiva**${dove}: per questo non viene pubblicato nulla in automatico.\n\n` +
          `Se vuoi attivarla, dimmi cosa e quando — es. *"ogni giorno alle 9 pubblica un prodotto dal file prodotti.csv sulla pagina Pcs Store"* — e la imposto subito.`,
      };
    }
    const lines = jobs.map((j) => {
      const pagina = j.fbPageName || j.socialAgent?.name || "pagina";
      const stato = j.status === "ACTIVE" ? "🟢 attivo" : "⏸️ in pausa";
      const esito = j.lastStatus ? (j.lastStatus === "OK" ? " · ultima: ✅" : " · ultima: ❌") : "";
      return `• **${pagina}** — ${j.name}\n  ${stato} · \`${j.cronExpression}\` · prossima: ${fmtDt(j.nextRunAt)} · ultima esec.: ${fmtDt(j.lastRunAt)}${esito}`;
    });
    const attivi = jobs.filter((j) => j.status === "ACTIVE").length;
    return {
      finalResult: `📅 **Pubblicazioni programmate** (${jobs.length}, di cui ${attivi} attive):\n${lines.join("\n")}\n\nVuoi crearne una nuova, metterne una in pausa o cambiarle l'orario?`,
    };
  }

  // Elenca le pagine da TUTTE le sorgenti (profilo + connessioni), dedup per id.
  const allPages: PageX[] = [];
  const seen = new Set<string>();
  const pageErrors: string[] = [];
  for (const s of sources) {
    try {
      const ps = await listFacebookPages(s.token);
      for (const p of ps) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        allPages.push({ ...p, connectionId: s.connectionId, connName: s.name, token: s.token });
      }
    } catch (e: any) {
      pageErrors.push(`${s.name}: ${e.message}`);
    }
  }
  const multi = sources.length > 1;

  // 2.5) LIST_INFO: in linguaggio naturale — quali pagine gestisco e cosa so fare
  if (parsed.intent === "LIST_INFO") {
    if (allPages.length === 0) {
      return { finalResult: `Per ora non vedo nessuna pagina Facebook collegata. Aggiungi o controlla i token nel **Profilo → Agente Social**.` };
    }
    const pagesTxt = allPages.map((p) => `• **${p.name}**${multi ? ` _(${p.connName})_` : ""}`).join("\n");

    // Unione dei permessi di tutti i token, tradotti in azioni comprensibili.
    const granted = new Set<string>();
    const noPost: string[] = [];
    for (const s of sources) {
      try {
        const perms = await getTokenPermissions(s.token);
        perms.forEach((x) => granted.add(x));
        if (!perms.includes("pages_manage_posts")) noPost.push(s.name);
      } catch { /* best-effort */ }
    }
    // Permessi disponibili sul token MA non ancora funzioni attive dell'agente
    // (oggi l'agente sa solo PUBBLICARE; il resto è "attivabile su richiesta").
    const POSSIBLE: [string, string][] = [
      ["pages_manage_engagement", "💬 Rispondere e moderare i commenti sotto i post"],
      ["pages_messaging", "✉️ Leggere e rispondere ai messaggi su Messenger"],
      ["pages_read_user_content", "👀 Leggere commenti e recensioni"],
      ["pages_utility_messaging", "🔔 Inviare messaggi di servizio e notifiche"],
      ["read_insights", "📈 Consultare le statistiche della pagina"],
      ["pages_manage_metadata", "⚙️ Gestire impostazioni e informazioni della pagina"],
      ["pages_manage_ads", "📣 Gestire le inserzioni pubblicitarie"],
      ["catalog_management", "🛍️ Gestire il catalogo prodotti"],
    ];
    const possible = POSSIBLE.filter(([k]) => granted.has(k)).map(([, v]) => v);
    const canPublish = granted.has("pages_manage_posts") && noPost.length === 0;
    const intro = allPages.length === 1 ? "Ho accesso a **1** pagina Facebook:" : `Ho accesso a **${allPages.length}** pagine Facebook:`;

    let body = `${intro}\n${pagesTxt}\n\n**Cosa faccio già per te:**\n`;
    body += canPublish
      ? "📝 Pubblico i tuoi post (subito o programmati a calendario) e posso eliminarli."
      : `📝 Pubblicare i post${noPost.length ? ` — ma su **${noPost.join(", ")}** manca ancora il permesso (va rigenerato quel token con la gestione post).` : ""}`;
    if (possible.length) {
      body += "\n\n**Ho anche i permessi per queste cose** (funzioni che possiamo attivare quando vuoi, ma che oggi non faccio ancora in automatico):\n" + possible.join("\n");
    }
    body += "\n\nPer ora dimmi pure cosa pubblicare e quando! 😊";
    return { finalResult: body };
  }

  if (allPages.length === 0) {
    return { finalResult: `Non riesco a leggere le tue pagine Facebook.${pageErrors.length ? " (" + pageErrors.join("; ") + ")" : ""} Verifica i token in *Profilo → Agente Social*.` };
  }

  // 4) Risolvi la pagina target (tra tutte le pagine di tutti i token)
  let target: PageX | null = null;
  if (parsed.targetPageName && parsed.targetPageName.trim()) {
    const q = parsed.targetPageName.trim().toLowerCase();
    target = allPages.find((p) => p.name.toLowerCase().includes(q)) || allPages.find((p) => q.includes(p.name.toLowerCase())) || null;
    if (!target) {
      return { finalResult: `Non ho trovato la pagina "${parsed.targetPageName}" tra quelle che gestisci. Le tue pagine sono:\n${pageList(allPages)}\n\nSu quale vuoi pubblicare?` };
    }
  } else if (allPages.length === 1) {
    target = allPages[0];
  } else {
    return { finalResult: `Gestisci più pagine Facebook:\n${pageList(allPages)}\n\nSu quale vuoi pubblicare? Indicami il nome.` };
  }

  // 4.5) EXPORT_POSTS: salva gli ultimi N post della pagina in un CSV (con URL immagine)
  if (parsed.intent === "EXPORT_POSTS") {
    const n = Math.min(Math.max(Math.round(parsed.count || 10), 1), 50);
    const pageToken = await getPageAccessToken(target.token, target.id);
    if (!pageToken) return { finalResult: `Non riesco a ottenere il token della pagina **${target.name}** per leggerne i post.` };
    let posts;
    try {
      posts = await getRecentPagePosts(pageToken, target.id, n);
    } catch (e: any) {
      return { finalResult: `Non riesco a leggere i post di **${target.name}**: ${e.message}` };
    }
    if (!posts.length) return { finalResult: `Non ho trovato post con testo o immagine sulla pagina **${target.name}**.` };

    const esc = (s: string) => '"' + String(s || "").replace(/"/g, '""') + '"';
    const header = "name,description,imageUrl,data,permalink";
    const rows = posts.map((p) => {
      const firstLine = (p.message.split("\n")[0] || "").slice(0, 80);
      return [esc(firstLine), esc(p.message), esc(p.imageUrl), esc(p.createdTime), esc(p.permalink)].join(",");
    });
    const csv = [header, ...rows].join("\n");
    const safe = target.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 30) || "pagina";
    const filename = `post_${safe}_${Date.now()}.csv`;
    try {
      const dir = path.join(process.cwd(), "shared_data", userId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), csv, "utf8");
    } catch (e: any) {
      return { finalResult: `Errore nel salvare il file: ${e.message}` };
    }
    return {
      finalResult:
        `✅ Ho salvato gli ultimi **${posts.length}** post di **${target.name}** nel file \`${filename}\` (incluso l'URL dell'immagine di ogni post).\n\n` +
        `Per ripubblicarli **rielaborati ogni volta in modo diverso**, dimmi ad esempio:\n` +
        `_"pubblica ogni giorno alle 9 sulla pagina ${target.name} i contenuti dal file ${filename}"_\n\n` +
        `Terrò attiva la riscrittura AI, così ogni post viene riproposto con parole nuove (la foto resta quella originale).`,
    };
  }

  // 5) TEST IMMEDIATO
  if (parsed.intent === "TEST_NOW") {
    try {
      const useAi = parsed.sourceType !== "TEXT";
      const indirizzo = [userData.street, userData.city, userData.zipCode].filter(Boolean).join(", ");
      const env: Record<string, string> = {
        FB_PAGE_ID: target.id,
        FB_ACCESS_TOKEN: target.token,
        SOURCE_TYPE: parsed.sourceType || "TEXT",
        SOURCE_REF: parsed.sourceRef || "",
        ROW_INDEX: "0",
        POSTS_PER_RUN: "1",
        SELECTION_MODE: parsed.selectionMode || "SEQUENTIAL",
        CAPTION_TEMPLATE: parsed.captionTemplate || "",
        AI_CAPTION: useAi ? "true" : "false",
        AI_MODEL: await modelForLevel(prisma, 1),
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
        // Per il test da chat uso i dati del profilo come branding (il pannello permette override per-job)
        COMPANY_NAME: userData.companyName || "",
        BIZ_NAME: userData.companyName || "",
        BIZ_ADDRESS: indirizzo,
        BIZ_WHATSAPP: userData.phone || "",
        BIZ_WEBSITE: userData.website || "",
      };
      const result = await executePythonScript(FACEBOOK_POST_SCRIPT, { env, workspace: userId });
      const um = (result.output || "").match(/AI_USAGE (\d+) (\d+) (\S+)/);
      if (um) await chargeUser(prisma, userId, [{ model: um[3], prompt: parseInt(um[1], 10), completion: parseInt(um[2], 10) }], "social").catch(() => {});
      const out = (result.output || "").trim();
      if (result.success && out.includes("POST_OK")) {
        return { finalResult: `✅ Post di test pubblicato sulla pagina **${target.name}**!\n\nControllala per vederlo. Se è ok, dimmi come programmare le pubblicazioni automatiche (es. "ogni giorno alle 9 un prodotto dal mio Google Sheet su ${target.name}").` };
      }
      const errLine = out.split("\n").find((l) => l.startsWith("ERRORE")) || result.error || out || "errore sconosciuto";
      return { finalResult: `❌ Pubblicazione di test non riuscita sulla pagina **${target.name}**.\n\n${errLine}` };
    } catch (e: any) {
      return { finalResult: `Errore durante il test: ${e.message}` };
    }
  }

  // 6) SCHEDULE
  const nextRunAt = computeNextRun(parsed.cronExpression, "Europe/Rome");
  if (!nextRunAt) return { finalResult: `La frequenza non è valida (cron: "${parsed.cronExpression}"). Riprova specificando meglio l'orario.` };
  if (parsed.sourceType !== "TEXT" && !parsed.sourceRef) {
    return { finalResult: "Mi serve la fonte dati: incolla il link del Google Sheet o il nome del file Excel caricato." };
  }

  try {
    // Collega (o crea) l'Agente Social della pagina, cosi la pubblicazione
    // compare anche nel pannello come card della pagina.
    const sa = await prisma.socialAgent.upsert({
      where: { userId_fbPageId: { userId, fbPageId: target.id } },
      update: { connectionId: target.connectionId },
      create: { userId, connectionId: target.connectionId, fbPageId: target.id, fbPageName: target.name, name: target.name },
    });
    const job = await prisma.scheduledJob.create({
      data: {
        userId,
        socialAgentId: sa.id,
        name: parsed.name || `Pubblicazione ${target.name}`,
        platform: "FACEBOOK",
        status: "ACTIVE",
        cronExpression: parsed.cronExpression,
        timezone: "Europe/Rome",
        fbPageId: target.id,
        fbPageName: target.name,
        sourceType: parsed.sourceType,
        sourceRef: parsed.sourceRef,
        captionTemplate: parsed.captionTemplate || null,
        aiCaption: parsed.sourceType !== "TEXT",
        aiLevel: 1,
        postsPerRun: parsed.postsPerRun && parsed.postsPerRun > 0 ? Math.min(parsed.postsPerRun, 10) : 1,
        selectionMode: parsed.selectionMode || "SEQUENTIAL",
        nextRunAt,
      },
    });
    const fonte = parsed.sourceType === "GOOGLE_SHEET" ? "Google Sheet" : parsed.sourceType === "EXCEL" ? `file Excel (${parsed.sourceRef})` : "testo";
    const quando = nextRunAt.toLocaleString("it-IT", { timeZone: "Europe/Rome" });
    return {
      finalResult:
        `✅ Pubblicazione automatica programmata!\n\n` +
        `- **Pagina:** ${target.name}\n- **Job:** ${job.name}\n- **Fonte:** ${fonte}\n` +
        `- **Frequenza:** \`${parsed.cronExpression}\`\n- **Prossima esecuzione:** ${quando}\n\n` +
        `Gestisci o testa i job dalla sezione *Agente Social* del Profilo.`,
    };
  } catch (e: any) {
    console.error("Social scheduler error:", e);
    return { finalResult: `Errore nella creazione del job: ${e.message}` };
  }
};

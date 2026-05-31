import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { computeNextRun } from "../services/scheduler";
import { modelForLevel } from "../services/aiLevels";
import { chargeUser } from "../services/tokenMeter";
import { executePythonScript } from "../services/dockerService";
import { FACEBOOK_POST_SCRIPT } from "../services/socialTemplates";
import { listFacebookPages, getTokenPermissions, FacebookPage } from "../services/facebook";
import { decryptSecret } from "../utils/crypto";
import { PrismaClient } from "@prisma/client";
import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

const prisma = new PrismaClient();

const jobSchema = z.object({
  intent: z
    .enum(["TEST_NOW", "SCHEDULE", "NEED_INFO", "LIST_INFO"])
    .describe("TEST_NOW = pubblica subito; SCHEDULE = programma ricorrenti; LIST_INFO = elenca pagine/permessi del token; NEED_INFO = mancano dati"),
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

  // 2.5) LIST_INFO: quali pagine gestisce (da tutti i token) e se può pubblicare
  if (parsed.intent === "LIST_INFO") {
    if (allPages.length === 0) {
      return { finalResult: `Non riesco a leggere pagine da nessun token.${pageErrors.length ? " (" + pageErrors.join("; ") + ")" : ""} Verifica i token in *Profilo → Agente Social*.` };
    }
    const pagesTxt = allPages.map((p) => `• ${p.name}${multi ? ` — _${p.connName}_` : ""} (id ${p.id})`).join("\n");
    const noPost: string[] = [];
    for (const s of sources) {
      try { const perms = await getTokenPermissions(s.token); if (!perms.includes("pages_manage_posts")) noPost.push(s.name); } catch { /* best-effort */ }
    }
    const postLine = noPost.length === 0
      ? "✅ Posso pubblicare su tutte (permesso `pages_manage_posts` presente)."
      : `⚠️ Questi token NON possono pubblicare (manca \`pages_manage_posts\`): ${noPost.join(", ")}.`;
    return { finalResult: `📘 **Pagine che gestisci** (${allPages.length}):\n${pagesTxt}\n\n${postLine}` };
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

import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { computeNextRun } from "../services/scheduler";
import { executePythonScript } from "../services/dockerService";
import { FACEBOOK_POST_SCRIPT } from "../services/socialTemplates";
import { listFacebookPages, FacebookPage } from "../services/facebook";
import { decryptSecret } from "../utils/crypto";
import { PrismaClient } from "@prisma/client";
import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

const prisma = new PrismaClient();

const jobSchema = z.object({
  intent: z
    .enum(["TEST_NOW", "SCHEDULE", "NEED_INFO"])
    .describe("TEST_NOW = pubblica subito un post di prova; SCHEDULE = programma pubblicazioni ricorrenti; NEED_INFO = mancano dati"),
  missingInfo: z.string().describe("Se intent=NEED_INFO, messaggio IN PRIMA PERSONA che chiede cosa manca"),
  targetPageName: z.string().describe("Nome della pagina Facebook su cui pubblicare, se indicato dall'utente; altrimenti stringa vuota"),
  name: z.string().describe("Nome breve del job (solo per SCHEDULE)"),
  cronExpression: z.string().describe("Cron a 5 campi (solo SCHEDULE). Es: ogni giorno alle 9 = '0 9 * * *'"),
  sourceType: z.enum(["GOOGLE_SHEET", "EXCEL", "TEXT"]).describe("TEXT = post di solo testo (tipico per un test rapido)"),
  sourceRef: z.string().describe("URL Google Sheet o nome file .xlsx; vuoto se sourceType=TEXT"),
  captionTemplate: z.string().describe("Per SCHEDULE: template con {colonna}. Per TEST_NOW/TEXT: il testo del post. Vuoto = default"),
  selectionMode: z.enum(["SEQUENTIAL", "RANDOM"]),
});

const pageList = (pages: FacebookPage[]) => pages.map((p) => `• ${p.name}`).join("\n");

export const socialSchedulerNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  console.log("---SOCIAL SCHEDULER NODE---");
  const userData = state.userData || {};
  const userId = userData.id;
  if (!userId) return { finalResult: "Errore: utente non identificato." };

  // 1) Serve il token utente (da cui ricaviamo le pagine gestite)
  if (!userData.fbAccessToken || !String(userData.fbAccessToken).trim()) {
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

  // 3) Elenca le pagine gestite dal token
  let pages: FacebookPage[];
  try {
    pages = await listFacebookPages(decryptSecret(userData.fbAccessToken));
  } catch (e: any) {
    return { finalResult: `Non riesco a leggere le tue pagine Facebook: ${e.message}. Verifica che il token sia valido e abbia i permessi (pages_show_list, pages_manage_posts).` };
  }
  if (pages.length === 0) {
    return { finalResult: "Il token non risulta amministratore di nessuna pagina Facebook. Genera un token con i permessi `pages_show_list` e `pages_manage_posts`." };
  }

  // 4) Risolvi la pagina target
  let target: FacebookPage | null = null;
  if (parsed.targetPageName && parsed.targetPageName.trim()) {
    const q = parsed.targetPageName.trim().toLowerCase();
    target = pages.find((p) => p.name.toLowerCase().includes(q)) || pages.find((p) => q.includes(p.name.toLowerCase())) || null;
    if (!target) {
      return { finalResult: `Non ho trovato la pagina "${parsed.targetPageName}" tra quelle che gestisci. Le tue pagine sono:\n${pageList(pages)}\n\nSu quale vuoi pubblicare?` };
    }
  } else if (pages.length === 1) {
    target = pages[0];
  } else {
    return { finalResult: `Gestisci più pagine Facebook:\n${pageList(pages)}\n\nSu quale vuoi pubblicare? Indicami il nome.` };
  }

  // 5) TEST IMMEDIATO
  if (parsed.intent === "TEST_NOW") {
    try {
      const env: Record<string, string> = {
        FB_PAGE_ID: target.id,
        FB_ACCESS_TOKEN: decryptSecret(userData.fbAccessToken),
        SOURCE_TYPE: parsed.sourceType || "TEXT",
        SOURCE_REF: parsed.sourceRef || "",
        ROW_INDEX: "0",
        CAPTION_TEMPLATE: parsed.captionTemplate || "",
      };
      const result = await executePythonScript(FACEBOOK_POST_SCRIPT, { env });
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
    const job = await prisma.scheduledJob.create({
      data: {
        userId,
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

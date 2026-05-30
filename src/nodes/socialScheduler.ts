import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { computeNextRun } from "../services/scheduler";
import { executePythonScript } from "../services/dockerService";
import { FACEBOOK_POST_SCRIPT } from "../services/socialTemplates";
import { decryptSecret } from "../utils/crypto";
import { PrismaClient } from "@prisma/client";
import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

const prisma = new PrismaClient();

const jobSchema = z.object({
  intent: z
    .enum(["TEST_NOW", "SCHEDULE", "NEED_INFO"])
    .describe("TEST_NOW = pubblica subito un post di prova; SCHEDULE = programma pubblicazioni ricorrenti; NEED_INFO = mancano dati"),
  missingInfo: z.string().describe("Se intent=NEED_INFO, messaggio IN PRIMA PERSONA che chiede all'utente cosa manca"),
  name: z.string().describe("Nome breve del job (solo per SCHEDULE)"),
  cronExpression: z.string().describe("Cron a 5 campi (solo per SCHEDULE). Es: ogni giorno alle 9 = '0 9 * * *'"),
  sourceType: z.enum(["GOOGLE_SHEET", "EXCEL", "TEXT"]).describe("TEXT = post di solo testo (tipico per un test rapido)"),
  sourceRef: z.string().describe("URL Google Sheet o nome file .xlsx; stringa vuota se sourceType=TEXT"),
  captionTemplate: z.string().describe("Per SCHEDULE: template con segnaposto {colonna}. Per TEST_NOW con TEXT: il testo del post. Vuoto = testo di default"),
  selectionMode: z.enum(["SEQUENTIAL", "RANDOM"]),
});

export const socialSchedulerNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  console.log("---SOCIAL SCHEDULER NODE---");
  const userData = state.userData || {};
  const userId = userData.id;

  if (!userId) {
    return { finalResult: "Errore: utente non identificato, impossibile gestire le pubblicazioni." };
  }

  // 1) Verifica credenziali Facebook nel profilo — messaggi SPECIFICI
  const hasPage = !!(userData.fbPageId && String(userData.fbPageId).trim());
  const hasToken = !!(userData.fbAccessToken && String(userData.fbAccessToken).trim());
  if (!hasPage || !hasToken) {
    let cosa: string;
    if (!hasPage && !hasToken) cosa = "il **Page ID** e l'**Access Token**";
    else if (!hasPage) cosa = "il **Page ID** (il token risulta già salvato ✓)";
    else cosa = "l'**Access Token** (il Page ID risulta già salvato ✓)";
    return {
      finalResult:
        `Mi manca ${cosa} della tua pagina Facebook. Aprilo dal **Profilo → Agente Social**, ` +
        `inserisci il valore mancante e premi *Salva credenziali*. Poi torna qui e potremo procedere subito con un test.`,
    };
  }

  // 2) Interpreta la richiesta
  const sys = `Sei l'assistente che gestisce le pubblicazioni Facebook di un'azienda.
Le credenziali (Page ID + Token) sono GIÀ configurate: NON chiederle.

Classifica la richiesta dell'utente:
- intent=TEST_NOW: l'utente vuole pubblicare SUBITO (es. "fai un test", "pubblica ora un post", "prova a pubblicare").
  - Se non indica una fonte dati (Google Sheet/Excel), usa sourceType=TEXT. In captionTemplate metti il testo del
    post se l'utente lo ha specificato, altrimenti lascia vuoto (verrà usato un testo di prova di default).
  - Se indica un Google Sheet/Excel, usa quella fonte e pubblicherò la prima riga come test.
- intent=SCHEDULE: l'utente vuole pubblicazioni RICORRENTI. Servono frequenza + fonte dati.
  - cronExpression: converti il linguaggio naturale (es. "ogni giorno alle 9" -> "0 9 * * *").
  - sourceType GOOGLE_SHEET (con URL) o EXCEL (con nome file). captionTemplate con segnaposto {colonna} se descritto.
- intent=NEED_INFO: SOLO se per SCHEDULE manca la fonte dati o la frequenza. In missingInfo chiedi in modo specifico
  cosa manca. Per un TEST_NOW non servono info extra: un test di solo testo è sempre possibile.`;

  let parsed: z.infer<typeof jobSchema>;
  try {
    parsed = await routerModel.withStructuredOutput(jobSchema).invoke([
      new SystemMessage(sys),
      ...state.messages,
    ]);
  } catch (e: any) {
    return { finalResult: `Non sono riuscito a interpretare la richiesta: ${e.message}` };
  }

  // 3) TEST IMMEDIATO
  if (parsed.intent === "TEST_NOW") {
    try {
      const token = decryptSecret(userData.fbAccessToken);
      const env: Record<string, string> = {
        FB_PAGE_ID: String(userData.fbPageId),
        FB_ACCESS_TOKEN: token,
        SOURCE_TYPE: parsed.sourceType || "TEXT",
        SOURCE_REF: parsed.sourceRef || "",
        ROW_INDEX: "0",
        CAPTION_TEMPLATE: parsed.captionTemplate || "",
      };
      const result = await executePythonScript(FACEBOOK_POST_SCRIPT, { env });
      const out = (result.output || "").trim();
      if (result.success && out.includes("POST_OK")) {
        return {
          finalResult:
            `✅ Post di test pubblicato sulla tua pagina Facebook!\n\n` +
            `Controlla la pagina per vederlo. Se è tutto ok, dimmi pure come vuoi programmare le pubblicazioni ` +
            `automatiche (es. "ogni giorno alle 9 un prodotto dal mio Google Sheet").`,
        };
      }
      // Estrai un messaggio d'errore leggibile
      const errLine = out.split("\n").find((l) => l.startsWith("ERRORE")) || result.error || out || "errore sconosciuto";
      return {
        finalResult:
          `❌ La pubblicazione di test non è andata a buon fine.\n\n${errLine}\n\n` +
          `Verifica che il token sia un *Page Access Token* valido e con i permessi di pubblicazione, e che il Page ID sia corretto.`,
      };
    } catch (e: any) {
      return { finalResult: `Errore durante il test di pubblicazione: ${e.message}` };
    }
  }

  // 4) NEED_INFO
  if (parsed.intent === "NEED_INFO") {
    return { finalResult: parsed.missingInfo || "Mi servono ancora alcune informazioni per programmare la pubblicazione." };
  }

  // 5) SCHEDULE — crea il job ricorrente
  const nextRunAt = computeNextRun(parsed.cronExpression, "Europe/Rome");
  if (!nextRunAt) {
    return { finalResult: `La frequenza indicata non è valida (cron: "${parsed.cronExpression}"). Riprova specificando meglio l'orario.` };
  }
  if (parsed.sourceType !== "TEXT" && !parsed.sourceRef) {
    return { finalResult: "Per programmare le pubblicazioni mi serve la fonte dati: incolla il link del Google Sheet o il nome del file Excel caricato." };
  }

  try {
    const job = await prisma.scheduledJob.create({
      data: {
        userId,
        name: parsed.name || "Pubblicazione automatica",
        platform: "FACEBOOK",
        status: "ACTIVE",
        cronExpression: parsed.cronExpression,
        timezone: "Europe/Rome",
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
        `- **Job:** ${job.name}\n- **Piattaforma:** Facebook\n- **Fonte:** ${fonte}\n` +
        `- **Frequenza:** \`${parsed.cronExpression}\`\n- **Prossima esecuzione:** ${quando}\n\n` +
        `Puoi gestire, mettere in pausa o testare i job dalla sezione *Agente Social* del Profilo.`,
    };
  } catch (e: any) {
    console.error("Social scheduler error:", e);
    return { finalResult: `Errore nella creazione del job: ${e.message}` };
  }
};

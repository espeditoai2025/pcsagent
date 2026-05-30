import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { computeNextRun } from "../services/scheduler";
import { PrismaClient } from "@prisma/client";
import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

const prisma = new PrismaClient();

const jobSchema = z.object({
  ready: z.boolean().describe("true se ci sono tutte le info per creare il job di pubblicazione"),
  missingInfo: z.string().describe("Se ready=false, messaggio IN PRIMA PERSONA che chiede all'utente cosa manca"),
  name: z.string().describe("Nome breve descrittivo del job, es. 'Post prodotti giornaliero'"),
  cronExpression: z.string().describe("Cron standard a 5 campi. Es: ogni giorno alle 9 = '0 9 * * *'"),
  sourceType: z.enum(["GOOGLE_SHEET", "EXCEL"]),
  sourceRef: z.string().describe("URL del Google Sheet, oppure nome file .xlsx caricato"),
  captionTemplate: z.string().describe("Template caption con segnaposto {colonna}; stringa vuota se non specificato"),
  selectionMode: z.enum(["SEQUENTIAL", "RANDOM"]).describe("Come scegliere il prodotto ad ogni run"),
});

export const socialSchedulerNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  console.log("---SOCIAL SCHEDULER NODE---");
  const userData = state.userData || {};
  const userId = userData.id;

  if (!userId) {
    return { finalResult: "Errore: utente non identificato, impossibile configurare la pubblicazione." };
  }

  // 1) Verifica credenziali Facebook nel profilo
  if (!userData.fbPageId || !userData.fbAccessToken) {
    return {
      finalResult:
        "Per programmare le pubblicazioni su Facebook devi prima inserire **Page ID** e **Access Token** " +
        "nella sezione *Agente Social* del tuo Profilo Aziendale. Una volta salvati, torna qui e dimmi " +
        "cosa vuoi pubblicare e con quale frequenza.",
    };
  }

  const lastUserMsg = (state.messages[state.messages.length - 1]?.content as string) || "";

  const sys = `Sei l'assistente che configura job di pubblicazione automatica su Facebook.
Analizza la richiesta dell'utente ed estrai i parametri del job.

REGOLE:
- cronExpression: converti il linguaggio naturale in cron a 5 campi (min ora giorno mese giorno-settimana).
  Esempi: "ogni giorno alle 9" -> "0 9 * * *"; "lun-ven alle 8:30" -> "30 8 * * 1-5"; "ogni 3 ore" -> "0 */3 * * *".
- sourceType + sourceRef: se l'utente indica un link Google Sheet -> GOOGLE_SHEET con l'URL completo.
  Se indica un file Excel caricato -> EXCEL con il nome file.
- captionTemplate: se l'utente descrive un formato (es. "Nome - Prezzo€"), traducilo in template con segnaposto
  tipo "{nome} a {prezzo}€ - {descrizione}". Altrimenti stringa vuota.
- Se MANCA la fonte dati (nessun link Sheet ne file Excel), imposta ready=false e in missingInfo chiedi
  all'utente di fornire il link del Google Sheet o di caricare il file Excel.
- Se hai fonte + frequenza, ready=true.`;

  let parsed: z.infer<typeof jobSchema>;
  try {
    parsed = await routerModel.withStructuredOutput(jobSchema).invoke([
      new SystemMessage(sys),
      ...state.messages,
    ]);
  } catch (e: any) {
    return { finalResult: `Non sono riuscito a interpretare la richiesta di pubblicazione: ${e.message}` };
  }

  if (!parsed.ready) {
    return { finalResult: parsed.missingInfo || "Mi servono ancora alcune informazioni per programmare la pubblicazione." };
  }

  // 2) Valida la cron expression
  const nextRunAt = computeNextRun(parsed.cronExpression, "Europe/Rome");
  if (!nextRunAt) {
    return { finalResult: `La frequenza indicata non è valida (cron: "${parsed.cronExpression}"). Riprova specificando meglio l'orario.` };
  }

  // 3) Crea il job
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

    const fonte = parsed.sourceType === "GOOGLE_SHEET" ? "Google Sheet" : `file Excel (${parsed.sourceRef})`;
    const quando = nextRunAt.toLocaleString("it-IT", { timeZone: "Europe/Rome" });
    return {
      finalResult:
        `✅ Pubblicazione automatica programmata!\n\n` +
        `- **Job:** ${job.name}\n` +
        `- **Piattaforma:** Facebook\n` +
        `- **Fonte:** ${fonte}\n` +
        `- **Frequenza:** \`${parsed.cronExpression}\`\n` +
        `- **Prossima esecuzione:** ${quando}\n\n` +
        `Puoi gestire, mettere in pausa o testare i job dalla sezione *Agente Social* del Profilo.`,
    };
  } catch (e: any) {
    console.error("Social scheduler error:", e);
    return { finalResult: `Errore nella creazione del job di pubblicazione: ${e.message}` };
  }
};

import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

const routerSchema = z.object({
  next: z.enum(["coder", "searcher", "image_gen", "retriever", "pdf_maker", "finish"]),
  instructions: z.string().describe("Istruzioni dettagliate e specifiche per il nodo successivo"),
});

export const supervisorNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const systemPrompt = `Sei il Supervisor di un Agente AI autonomo. Analizza la richiesta dell'utente e scegli lo strumento corretto.

=== STRUMENTI DISPONIBILI ===

🐍 'coder' — STRUMENTO PRINCIPALE. Esegue Python in un container Docker con accesso internet completo.
   USA per:
   - Qualsiasi automazione, calcolo, elaborazione dati
   - Analisi di file (CSV, Excel, PDF) e generazione di report dati
   - Scraping web, chiamate API, download file
   - PDF con grafici, calcoli complessi o elaborazione dati
   - Qualsiasi task che richiede logica Python
   USA 'coder' per documenti SOLO se l'utente chiede esplicitamente grafici, calcoli su dati o elaborazioni complesse.

📄 'pdf_maker' — Generatore documenti aziendali con carta intestata. USA per:
   - Preventivi, fatture, offerte, contratti, report — anche con prodotti specifici e prezzi già forniti
   - Qualsiasi documento dove i dati sono già presenti nel messaggio dell'utente
   USA 'coder' invece di pdf_maker SOLO se l'utente chiede ESPLICITAMENTE di includere foto/immagini del prodotto nel PDF (il coder scarica e incorpora l'immagine in modo affidabile).

🔍 'searcher' — Ricerca web in tempo reale.
   USA per: notizie recenti, prezzi attuali, informazioni aggiornate non presenti nel training.

🖼️ 'image_gen' — Generazione immagini AI.
   USA per: creare immagini, illustrazioni, loghi, mockup da testo.

📚 'retriever' — Ricerca nei documenti caricati dall'utente.
   USA per: "nel documento che ti ho mandato...", "nel PDF/CSV/file che ho allegato..."

💬 'finish' — Risposta diretta senza tool.
   USA SOLO per: saluti, domande generali di conversazione, domande a cui puoi rispondere direttamente.
   IMPORTANTE: quando usi 'finish', il campo 'instructions' contiene ESATTAMENTE il testo che verrà mostrato all'utente.
   Scrivi la risposta IN PRIMA PERSONA, come se tu fossi l'assistente che parla direttamente all'utente.
   NON scrivere meta-istruzioni come "Rispondi all'utente spiegando che..." — scrivi direttamente "Non ho accesso..."
   Esempio SBAGLIATO: "Rispondi all'utente dicendo che non ho memoria"
   Esempio CORRETTO: "Non ho memoria delle conversazioni passate. In questa sessione so solo quello che mi hai detto finora."

=== REGOLA FONDAMENTALE ===
NON dire mai "non posso farlo". Se la richiesta è complessa, usa 'coder' — il container Python può fare quasi tutto.
Per gli altri nodi (coder, pdf_maker, ecc.), le 'instructions' spiegano cosa il nodo deve fare.

Rispondi SOLO in JSON valido:
{ "next": "...", "instructions": "..." }`;

  const messages = [
    new SystemMessage(systemPrompt),
    ...state.messages,
  ];

  const response = await routerModel.withStructuredOutput(routerSchema).invoke(messages);

  return {
    messages: [new SystemMessage(`Supervisor Decision: ROUTE TO ${response.next}\nInstructions: ${response.instructions}`)],
  };
};

export const routerEdge = (state: AgentState): string => {
  const lastMessage = state.messages[state.messages.length - 1];
  const content = lastMessage.content as string;

  if (content.includes("ROUTE TO coder")) return "coder";
  if (content.includes("ROUTE TO searcher")) return "searcher";
  if (content.includes("ROUTE TO image_gen")) return "image_gen";
  if (content.includes("ROUTE TO retriever")) return "retriever";
  if (content.includes("ROUTE TO pdf_maker")) return "pdf_maker";

  return "finish";
};

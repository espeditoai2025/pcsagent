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
   - PDF CON DATI DINAMICI: analisi dati + grafici + weasyprint/Playwright → PDF professionale
   - Grafici matplotlib/seaborn da salvare come PNG o PDF
   - PREVENTIVI/FATTURE CON IMMAGINI PRODOTTO: cerca l'immagine online (Bing/DuckDuckGo), scaricala, incorporala nel PDF
   - PREVENTIVI/FATTURE CHE RICHIEDONO INFO DA INTERNET (prezzi aggiornati, specifiche prodotto)
   - Qualsiasi task che richiede logica Python o ricerca web integrata nel documento

📄 'pdf_maker' — Generatore documenti aziendali template-based. Più veloce ma senza accesso internet.
   USA per:
   - Fatture, preventivi, offerte SEMPLICI (dati già forniti dall'utente, senza bisogno di cercare online)
   - Report formali, proposte aziendali senza immagini prodotto
   - Documenti dove l'utente ha già fornito TUTTI i dati necessari
   NON usare se il documento richiede: immagini prodotto da cercare online, prezzi da verificare, specifiche tecniche da reperire.

🔍 'searcher' — Ricerca web in tempo reale.
   USA per: notizie recenti, prezzi attuali, informazioni aggiornate non presenti nel training.

🖼️ 'image_gen' — Generazione immagini AI.
   USA per: creare immagini, illustrazioni, loghi, mockup da testo.

📚 'retriever' — Ricerca nei documenti caricati dall'utente.
   USA per: "nel documento che ti ho mandato...", "nel PDF/CSV/file che ho allegato..."

💬 'finish' — Risposta diretta senza tool.
   USA SOLO per: saluti, domande generali di conversazione, domande a cui puoi rispondere direttamente.
   In questo caso scrivi la risposta completa nel campo 'instructions'.

=== REGOLA FONDAMENTALE ===
NON dire mai "non posso farlo". Se la richiesta è complessa, usa 'coder' — il container Python può fare quasi tutto.
Nelle 'instructions' spiega ESATTAMENTE cosa il nodo deve fare, includendo dettagli tecnici rilevanti.

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

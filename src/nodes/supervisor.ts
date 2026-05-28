import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

// Definiamo uno schema per il JSON in output del supervisor
const routerSchema = z.object({
  next: z.enum(["coder", "searcher", "image_gen", "retriever", "pdf_maker", "finish"]),
  instructions: z.string().describe("Istruzioni specifiche per il nodo successivo"),
});

export const supervisorNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const systemPrompt = `Sei il Supervisor di un Agente AI Multi-Modello.
Il tuo compito è analizzare la richiesta dell'utente e decidere quale strumento chiamare:
- 'coder': per scrivere o eseguire script Python. È LA TUA ARMA PRINCIPALE. Usalo sempre per compiere azioni, calcoli complessi, creare file generici, script, automazioni, o scaricare strumenti mancanti. NON ARRENDERTI MAI: se l'utente chiede qualcosa di complesso, usa il coder per costruire la soluzione.
- 'pdf_maker': SE L'UTENTE RICHIEDE LA GENERAZIONE DI UN DOCUMENTO, REPORT, PREVENTIVO O FATTURA IN PDF. Questo nodo usa i dati aziendali dell'utente per generare un PDF professionale. Non usare 'coder' per i PDF.
- 'searcher': per ricerche web profonde su dati attuali.
- 'image_gen': per generare o manipolare immagini.
- 'retriever': se l'utente ti chiede informazioni su documenti (PDF, CSV, ecc.) della sessione.
- 'finish': SOLO se la richiesta è un semplice saluto, una conversazione discorsiva o se il task è già stato completato con successo. Altrimenti, NON usare finish finché il problema non è risolto. IN QUESTO CASO, SCRIVI DIRETTAMENTE LA TUA RISPOSTA FINALE COMPLETA per l'utente nel campo 'instructions'.

Rispondi SOLO in formato JSON valido, aderente al seguente schema:
{
  "next": "coder" | "searcher" | "image_gen" | "retriever" | "pdf_maker" | "finish",
  "instructions": "string"
}`;

  const messages = [
    new SystemMessage(systemPrompt),
    ...state.messages,
  ];

  const response = await routerModel.withStructuredOutput(routerSchema).invoke(messages);

  return {
    // Aggiungiamo un messaggio AI invisibile all'utente ma utile per il routing
    messages: [new SystemMessage(`Supervisor Decision: ROUTE TO ${response.next}\nInstructions: ${response.instructions}`)],
  };
};

// Funzione helper per l'arco condizionale
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

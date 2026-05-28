import { AgentState } from "../state";
import { routerModel } from "../services/llm";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

// Definiamo uno schema per il JSON in output del supervisor
const routerSchema = z.object({
  next: z.enum(["coder", "searcher", "image_gen", "finish"]),
  instructions: z.string().describe("Istruzioni specifiche per il nodo successivo"),
});

export const supervisorNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const systemPrompt = `Sei il Supervisor di un Agente AI Multi-Modello.
Il tuo compito è analizzare la richiesta dell'utente e decidere quale strumento chiamare:
- 'coder': per scrivere o eseguire script Python (es. scraping, data analysis, PDF generation).
- 'searcher': per ricerche web profonde su dati attuali.
- 'image_gen': per generare o manipolare immagini.
- 'finish': se la richiesta è già stata soddisfatta o necessita di una semplice risposta testuale.

Rispondi SOLO in formato JSON valido, aderente al seguente schema:
{
  "next": "coder" | "searcher" | "image_gen" | "finish",
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
  
  return "finish";
};

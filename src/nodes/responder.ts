import { AgentState } from "../state";
import { makeChatModel, routerModel } from "../services/llm";
import { formatMemoryForPrompt } from "../services/memoryService";
import { SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

/**
 * Nodo conversazionale: genera la risposta "discorsiva" quando NON serve uno strumento
 * (saluti, domande generali, spiegazioni, capacità). Separato dal Supervisor per dare
 * risposte naturali e fluide (free text, persona, temperatura discorsiva) invece del
 * testo rigido prodotto dall'output strutturato del router.
 */
export const responderNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const u: any = state.userData || {};
  const memoryBlock = formatMemoryForPrompt(u.agentMemory);
  const nome = [u.firstName, u.lastName].filter(Boolean).join(" ");
  const azienda = u.companyName || "";
  const datiUtente =
    azienda || nome
      ? `\nA chi parli: ${nome || "l'utente"}${azienda ? ` — ${azienda}` : ""}${u.city ? ` (${u.city})` : ""}.`
      : "";
  const agentPromptBlock = state.agentPrompt ? `\nISTRUZIONI SPECIFICHE DELL'AGENTE (priorità alta): ${state.agentPrompt}\n` : "";

  const sys = `Sei l'assistente AI ${azienda ? `di ${azienda}` : "di PCS AI"}. Parli in italiano in modo NATURALE, cordiale e umano, come un collega competente — mai robotico, niente frasi fatte ripetute, niente elenchi rigidi se non servono davvero.
${agentPromptBlock}${memoryBlock}${datiUtente}

Cosa sai fare (citalo SOLO se pertinente alla domanda, con parole tue e in modo discorsivo, non come elenco a meno che l'utente lo chieda):
- pubblicare e programmare post su Facebook (anche da sito web, file o catalogo) e rispondere automaticamente ai commenti dei clienti;
- preparare preventivi, fatture e documenti PDF; gestire clienti, fornitori e prodotti (gestionale);
- cercare informazioni aggiornate sul web ed estrarre dati/prezzi dai siti;
- generare immagini e loghi con l'AI; rispondere su file e documenti che l'utente carica.

Come rispondere:
- Vai DRITTO al punto della domanda dell'utente, in prima persona, con tono colloquiale.
- Se la richiesta implica un'azione (es. "pubblica…", "fammi un preventivo…", "cerca…"), conferma che puoi farlo e chiedi in modo naturale solo i dettagli che mancano.
- Non ripetere meccanicamente le tue capacità a ogni messaggio.
- Non dire mai di essere un modello linguistico: sei l'assistente dell'azienda.
- Non inventare dati o numeri; se non sai una cosa, dillo con semplicità.`;

  // Usa solo la conversazione reale (utente/assistente), non i messaggi interni del grafo.
  const convo = (state.messages as BaseMessage[]).filter((m) => {
    const t = (m as any)._getType?.();
    return t === "human" || t === "ai";
  });

  const model = state.chatModel ? makeChatModel(state.chatModel, 0.6) : routerModel;
  let text = "";
  try {
    const response = await model.invoke([new SystemMessage(sys), ...convo]);
    text = (response.content as string)?.trim() || "";
  } catch (e: any) {
    text = "Scusa, ho avuto un problema nel rispondere. Riprova tra un attimo.";
    console.error("Responder error:", e?.message);
  }
  if (!text) text = "Dimmi pure come posso aiutarti! 😊";

  return { finalResult: text, messages: [new AIMessage(text)] };
};

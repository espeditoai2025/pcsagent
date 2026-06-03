import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

// Definizione rigorosa dello stato dell'Agente
export const AgentStateAnnotation = Annotation.Root({
  // Cronologia dei messaggi scambiati tra utente e modelli
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  // Ultimo codice Python generato
  pythonCode: Annotation<string | null>({
    reducer: (left, right) => right ?? left,
    default: () => null,
  }),
  // Errore catturato durante l'esecuzione di Docker
  executionError: Annotation<string | null>({
    reducer: (left, right) => right, // overwrite or clear
    default: () => null,
  }),
  // Contatore dei tentativi (per prevenire loop infiniti)
  iterations: Annotation<number>({
    reducer: (left, right) => left + right,
    default: () => 0,
  }),
  // Risultato finale (es. testo generato, o path del file generato)
  finalResult: Annotation<string | null>({
    reducer: (left, right) => right ?? left,
    default: () => null,
  }),
  // Dati utente (profilo, logo, azienda)
  userData: Annotation<any | null>({
    reducer: (left, right) => right ?? left,
    default: () => null,
  }),
  // Prompt/personalità specifica dell'agente (configurata dall'admin)
  agentPrompt: Annotation<string | null>({
    reducer: (left, right) => right ?? left,
    default: () => null,
  }),
  // Modello AI da usare per la chat (risolto dal grado di intelligenza dell'utente)
  chatModel: Annotation<string | null>({
    reducer: (left, right) => right ?? left,
    default: () => null,
  }),
  // Modello dell'ORCHESTRATORE (Supervisor): fissato a un modello solido, indipendente
  // dal grado scelto per generare → routing affidabile anche quando l'utente è su "Base".
  routerModel: Annotation<string | null>({
    reducer: (left, right) => right ?? left,
    default: () => null,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentStateAnnotation } from "./state";
import { supervisorNode, routerEdge } from "./nodes/supervisor";
import { coderNode } from "./nodes/coder";
import { executorNode, checkErrorEdge } from "./nodes/executor";
import { searcherNode } from "./nodes/searcher";
import { imageGenNode } from "./nodes/imageGen";
import { retrieverNode } from "./nodes/retriever";

// Costruzione del grafo
const builder = new StateGraph(AgentStateAnnotation)
  .addNode("supervisor", supervisorNode)
  .addNode("coder", coderNode)
  .addNode("executor", executorNode)
  .addNode("searcher", searcherNode)
  .addNode("image_gen", imageGenNode)
  .addNode("retriever", retrieverNode);

// Definizione del flusso
builder.addEdge(START, "supervisor");

// Il Supervisor decide la prossima mossa
builder.addConditionalEdges("supervisor", routerEdge, {
  coder: "coder",
  searcher: "searcher",
  image_gen: "image_gen",
  retriever: "retriever",
  finish: END,
});

// Il Coder Node passa sempre il codice all'Executor Node
builder.addEdge("coder", "executor");

// L'Executor Node usa un arco condizionale per il Self-Healing
builder.addConditionalEdges("executor", checkErrorEdge, {
  coder: "coder", // Se c'è errore e < 3 iterazioni
  finish: END,    // Se successo, o fallimento dopo 3 iterazioni
});

// Searcher, Image Gen e Retriever finiscono dopo l'esecuzione
builder.addEdge("searcher", END);
builder.addEdge("image_gen", END);
builder.addEdge("retriever", END);

// Compilazione del Grafo
export const agentGraph = builder.compile();

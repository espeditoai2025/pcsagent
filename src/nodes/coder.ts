import { AgentState } from "../state";
import { coderModel } from "../services/llm";
import { SystemMessage } from "@langchain/core/messages";

export const coderNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  let prompt = `Sei un esperto sviluppatore Python. Devi scrivere uno script Python che risolva la richiesta dell'utente.
Regole fondamentali:
1. L'ambiente è un container Docker minimale basato su python:3.11-slim.
2. Hai accesso a Internet. Se ti servono librerie esterne (es. requests, bs4, matplotlib, reportlab, pandas), **DEVI INSTALLARLE** all'inizio dello script usando subprocess:
   \`\`\`python
   import subprocess, sys
   subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "reportlab"])
   \`\`\`
3. I file generati (es. PDF, immagini, CSV) DEVONO essere salvati in \`/app/data/\`.
4. Ritorna SOLO il codice Python. Non aggiungere blocchi Markdown \`\`\`python o spiegazioni testuali. Il tuo output sarà eseguito direttamente.`;

  if (state.executionError) {
    prompt += `\n\nATTENZIONE: La precedente esecuzione ha generato questo errore:\n${state.executionError}\n
Per favore, analizza l'errore e correggi il codice. Questo è il tentativo numero ${state.iterations + 1}.`;
  } else {
    // Aggiungi le istruzioni del supervisor
    const lastMsg = state.messages[state.messages.length - 1].content as string;
    prompt += `\n\nIstruzioni specifiche per questo task:\n${lastMsg}`;
  }

  const messages = [
    new SystemMessage(prompt),
    ...state.messages,
  ];

  if (state.pythonCode && state.executionError) {
    // Includi il codice precedente se stiamo facendo self-healing
    messages.push(new SystemMessage(`Codice precedente:\n${state.pythonCode}`));
  }

  const response = await coderModel.invoke(messages);
  
  // Pulizia del markdown se il modello non ha rispettato le regole
  let code = response.content as string;
  code = code.replace(/^```python\s*/i, "").replace(/```$/i, "").trim();

  return {
    pythonCode: code,
    iterations: 1, // Verrà sommato al reducer esistente
  };
};

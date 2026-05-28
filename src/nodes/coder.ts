import { AgentState } from "../state";
import { coderModel } from "../services/llm";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

export const coderNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  let prompt = `Sei un esperto sviluppatore Python. Devi scrivere uno script Python che risolva la richiesta dell'utente in modo definitivo e autonomo.
Regole fondamentali:
1. L'ambiente è un container Docker minimale basato su python:3.11-slim. HAI ACCESSO COMPLETO A INTERNET.
2. SE TI MANCA QUALUNQUE LIBRERIA, STRUMENTO O DIPENDENZA (es. librerie Python, wget, curl, dipendenze di sistema), DEVI SCARICARLO E INSTALLARLO direttamente dal tuo script Python. NON ARRENDERTI MAI.
   Esempio per installare pacchetti Python silenziosamente:
   \`\`\`python
   import subprocess, sys
   subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "requests", "reportlab", "pandas", "matplotlib"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
   \`\`\`
   Se serve scaricare un file o un tool binario, usa il modulo 'urllib.request' o 'requests' per costruirlo al volo o scaricarlo.
3. I file generati (es. PDF, immagini, CSV, TXT) DEVONO essere salvati nella cartella \`/app/data/\`. I contenuti testuali all'interno dei file DEVONO essere in italiano, usando l'Euro come valuta di default.
4. Al termine del tuo script, fai \`print()\` di un **messaggio discorsivo e amichevole in italiano (stile ChatGPT)** che riassume i risultati. L'utente leggerà direttamente questo \`print()\`. Se hai creato un file, includi alla fine la dicitura esatta \`[File Generato: nome_file.est]\`. NESSUN LOG TECNICO, solo una risposta elegante in Markdown.
5. Ritorna SOLO il codice Python. Non aggiungere blocchi Markdown \`\`\`python o spiegazioni testuali. Il tuo output sarà eseguito direttamente. Se fallisci, dovrai ritentare fino al successo. Non dire mai "non posso farlo", costruisci una soluzione alternativa in Python!`;

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
    messages.push(new HumanMessage(`Codice precedente (ATTENZIONE HA FALLITO CON ERRORE):\n${state.pythonCode}`));
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

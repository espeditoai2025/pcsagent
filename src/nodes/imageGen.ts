import { AgentState } from "../state";
import { SystemMessage } from "@langchain/core/messages";

export const imageGenNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const prompt = state.messages[state.messages.length - 1].content;
  
  // Esempio di chiamata fetch ad OpenRouter per il modello immagine
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "google/gemini-3.1-flash-image-preview",
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  const imageResult = data.choices?.[0]?.message?.content || "Errore nella generazione dell'immagine";
  
  return {
    messages: [new SystemMessage(`Risultato Generazione Immagine: ${imageResult}`)],
    finalResult: imageResult,
  };
};

import { AgentState } from "../state";
import { SystemMessage } from "@langchain/core/messages";
import { PrismaClient } from "@prisma/client";
import { chargeFlat } from "../services/tokenMeter";

const prisma = new PrismaClient();
const IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";
const IMAGE_CREDITS = 10_000; // costo fisso per ogni immagine generata

export const imageGenNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const prompt = state.messages[state.messages.length - 1].content;
  const userId = state.userData?.id;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  let imageResult = "Errore nella generazione dell'immagine";
  const images: string[] = [];

  if (msg?.images && msg.images.length > 0) {
    for (const im of msg.images) {
      const url = im?.image_url?.url || im?.url;
      if (url) images.push(url);
    }
  }

  if (images.length > 0) {
    imageResult = images[0];
    // Addebito FISSO: 10.000 token per ogni immagine generata.
    await chargeFlat(prisma, userId, IMAGE_CREDITS * images.length, IMAGE_MODEL, "image").catch(() => {});
  } else if (msg?.content) {
    imageResult = msg.content;
  }

  return {
    messages: [new SystemMessage(`Risultato Generazione Immagine: ${imageResult}`)],
    finalResult: imageResult,
  };
};

import { AgentState } from "../state";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { PrismaClient } from "@prisma/client";
import { chargeFlat } from "../services/tokenMeter";
import { imageModelName } from "../services/aiLevels";

const prisma = new PrismaClient();
const IMAGE_CREDITS = 10_000; // costo fisso per ogni immagine generata

export const imageGenNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const userId = state.userData?.id;

  // Usa la VERA richiesta dell'utente (ultimo messaggio umano), non la decisione del supervisor.
  const humanMsgs = state.messages.filter((m) => m instanceof HumanMessage);
  const prompt = (humanMsgs.length
    ? humanMsgs[humanMsgs.length - 1].content
    : state.messages[state.messages.length - 1].content) as string;

  // Modello configurabile dall'admin (deve produrre immagini in output)
  const model = await imageModelName(prisma);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const msg = data?.choices?.[0]?.message;
    const images: string[] = [];

    if (msg?.images && msg.images.length > 0) {
      for (const im of msg.images) {
        const url = im?.image_url?.url || im?.url;
        if (url) images.push(url);
      }
    }

    if (images.length > 0) {
      // Addebito FISSO: 10.000 token per ogni immagine generata.
      await chargeFlat(prisma, userId, IMAGE_CREDITS * images.length, model, "image").catch(() => {});
      return {
        messages: [new SystemMessage(`Immagine generata (${images.length}).`)],
        finalResult: images[0],
      };
    }

    // Nessuna immagine restituita: spiega senza far fallire la chat.
    const textBack = (msg?.content as string) || "";
    const friendly = textBack
      ? `Non sono riuscito a generare l'immagine. Il modello ha risposto:\n${textBack}`
      : "Non sono riuscito a generare l'immagine in questo momento. Riprova tra poco, oppure prova a descriverla in modo più specifico.";
    return {
      messages: [new SystemMessage("Generazione immagine: nessuna immagine restituita.")],
      finalResult: friendly,
    };
  } catch (e: any) {
    console.error("ImageGen error:", e?.message);
    return {
      messages: [new SystemMessage(`Generazione immagine fallita: ${e?.message}`)],
      finalResult: "⚠️ Al momento non riesco a generare l'immagine (errore del servizio di generazione). Riprova tra poco.",
    };
  }
};

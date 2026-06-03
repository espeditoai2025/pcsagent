import { AgentState } from "../state";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { PrismaClient } from "@prisma/client";
import { chargeFlat } from "../services/tokenMeter";
import { imageModelName } from "../services/aiLevels";
import * as fs from "fs/promises";
import * as path from "path";
import crypto from "crypto";

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
      await chargeFlat(prisma, userId, IMAGE_CREDITS * images.length, model, "image").catch(() => {});

      const first = images[0];
      // ⚠️ IMPORTANTISSIMO: NON restituire il base64 come testo. Verrebbe salvato nella cronologia
      // chat e ri-spedito al modello ai messaggi successivi (centinaia di migliaia di token → costo
      // reale enorme). Le immagini data: vengono salvate su FILE e referenziate con [File Generato].
      const m = first.match(/^data:([^;]+);base64,(.*)$/s);
      if (m) {
        const ext = ((m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png").slice(0, 5);
        const dir = userId
          ? path.resolve(process.cwd(), "shared_data", String(userId))
          : path.resolve(process.cwd(), "shared_data");
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        const name = `immagine_${crypto.randomBytes(4).toString("hex")}.${ext}`;
        await fs.writeFile(path.join(dir, name), Buffer.from(m[2], "base64"));
        return {
          messages: [new SystemMessage(`Immagine generata: ${name}`)],
          finalResult: `Ecco l'immagine che ho generato 👇\n\n[File Generato: ${name}]\n\nDimmi pure se vuoi modificarla o generarne un'altra.`,
        };
      }

      // URL http(s) remoto: è corto, si può includere direttamente.
      return {
        messages: [new SystemMessage("Immagine generata (URL).")],
        finalResult: `Ecco l'immagine che ho generato 👇\n\n${first}`,
      };
    }

    const textBack = (msg?.content as string) || "";
    return {
      messages: [new SystemMessage("Generazione immagine: nessuna immagine restituita.")],
      finalResult: textBack
        ? `Non sono riuscito a generare l'immagine. Il modello ha risposto:\n${textBack.slice(0, 500)}`
        : "Non sono riuscito a generare l'immagine in questo momento. Riprova, magari descrivendola in modo più specifico.",
    };
  } catch (e: any) {
    console.error("ImageGen error:", e?.message);
    return {
      messages: [new SystemMessage(`Generazione immagine fallita: ${e?.message}`)],
      finalResult: "⚠️ Al momento non riesco a generare l'immagine (errore del servizio di generazione). Riprova tra poco.",
    };
  }
};

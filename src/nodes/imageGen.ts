import { AgentState } from "../state";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { PrismaClient } from "@prisma/client";
import { chargeFlat } from "../services/tokenMeter";
import { imageModelName } from "../services/aiLevels";
import { makeChatModel } from "../services/llm";
import * as fs from "fs/promises";
import * as path from "path";
import crypto from "crypto";

const prisma = new PrismaClient();
const IMAGE_CREDITS = 10_000; // costo fisso per ogni immagine generata

export const imageGenNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const userId = state.userData?.id;
  const u = state.userData || {};

  // Richiesta esplicita dell'utente (ultimo messaggio umano)
  const humanMsgs = state.messages.filter((m) => m instanceof HumanMessage);
  const userRequest = (humanMsgs.length
    ? (humanMsgs[humanMsgs.length - 1].content as string)
    : (state.messages[state.messages.length - 1].content as string)) || "";

  // Conversazione recente (testo; i base64 sono già rimossi a monte) per dare CONTESTO al prompt
  const convo = state.messages
    .filter((m) => m instanceof HumanMessage || m instanceof AIMessage)
    .slice(-8)
    .map((m) => `${m instanceof HumanMessage ? "UTENTE" : "AGENTE"}: ${String(m.content).slice(0, 500)}`)
    .join("\n");

  const ctx = [
    u.companyName ? `Azienda: ${u.companyName}` : "",
    u.website ? `Sito: ${u.website}` : "",
    state.agentPrompt ? `Note agente: ${String(state.agentPrompt).slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");

  // === Costruisci un PROMPT IMMAGINE dettagliato e PERTINENTE dal contesto ===
  // (così "grafica" o "riprova" non vengono mandati letteralmente al modello immagini)
  let imagePrompt = userRequest;
  try {
    const builderModelName = state.routerModel || state.chatModel; // modello solido ma economico
    if (builderModelName) {
      const builder = makeChatModel(builderModelName, 0.4);
      const r = await builder.invoke([
        new SystemMessage(
          "Sei un prompt engineer per la generazione di immagini. In base alla CONVERSAZIONE, al PROGETTO/AZIENDA e alla richiesta, scrivi UN SOLO prompt — dettagliato ma conciso — per generare l'immagine che l'utente vuole DAVVERO, coerente col suo progetto. Specifica soggetto, stile, palette colori, composizione ed eventuale testo da inserire. Se la richiesta è vaga (es. 'grafica', 'un'immagine', 'riprova', 'fanne un'altra'), DEDUCI dal contesto cosa serve. Rispondi SOLO con il prompt dell'immagine, senza preamboli, virgolette o spiegazioni."
        ),
        new HumanMessage(
          `PROGETTO/AZIENDA:\n${ctx || "(non specificato)"}\n\nCONVERSAZIONE:\n${convo || "(vuota)"}\n\nRICHIESTA ATTUALE DELL'UTENTE: ${userRequest}`
        ),
      ]);
      const built = ((r.content as string) || "").trim();
      if (built && built.length > 3) imagePrompt = built;
    }
  } catch (e: any) {
    console.error("ImageGen prompt-builder error:", e?.message);
    // si prosegue con la richiesta grezza dell'utente
  }

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
        messages: [{ role: "user", content: imagePrompt }],
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
      // ⚠️ NON restituire il base64 come testo: verrebbe salvato in cronologia e ri-spedito al
      // modello (centinaia di migliaia di token). Le immagini data: si salvano su FILE.
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
          finalResult: `Ecco l'immagine che ho generato 👇\n\n[File Generato: ${name}]\n\nDimmi pure se vuoi modificarla (colori, testo, stile) o generarne un'altra.`,
        };
      }

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
        : "Non sono riuscito a generare l'immagine. Prova a descrivere cosa vuoi (soggetto, stile, colori, testo).",
    };
  } catch (e: any) {
    console.error("ImageGen error:", e?.message);
    return {
      messages: [new SystemMessage(`Generazione immagine fallita: ${e?.message}`)],
      finalResult: "⚠️ Al momento non riesco a generare l'immagine (errore del servizio di generazione). Riprova tra poco.",
    };
  }
};

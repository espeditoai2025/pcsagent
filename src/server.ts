import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { agentGraph } from "./graph";
import { HumanMessage } from "@langchain/core/messages";

import { streamSSE } from "hono/streaming";
import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";

const app = new Hono();
const prisma = new PrismaClient();

app.get("/", (c) => {
  return c.text("Agent Backend is running.");
});

// Endpoint per scaricare i file generati dalla Sandbox
app.get("/api/files/:filename", async (c) => {
  const filename = c.req.param("filename");
  // La cartella condivisa con il container Docker
  const sharedDataPath = path.resolve(__dirname, "../shared_data");
  const filePath = path.join(sharedDataPath, filename);

  // Previene path traversal
  if (!filePath.startsWith(sharedDataPath)) {
    return c.json({ error: "Access denied" }, 403);
  }

  if (fs.existsSync(filePath)) {
    const file = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    
    // Set content type
    let contentType = "application/octet-stream";
    if (ext === ".pdf") contentType = "application/pdf";
    else if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") contentType = `image/${ext.substring(1)}`;
    else if (ext === ".csv") contentType = "text/csv";
    else if (ext === ".txt") contentType = "text/plain";
    else if (ext === ".webm" || ext === ".mp3" || ext === ".wav") contentType = `audio/${ext.substring(1)}`;
    
    c.header("Content-Type", contentType);
    return c.body(file);
  } else {
    return c.json({ error: "File not found" }, 404);
  }
});

// Endpoint per caricare file o audio
app.post("/api/upload", async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || typeof file === 'string') {
      return c.json({ error: "No file uploaded" }, 400);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const sharedDataPath = path.resolve(__dirname, "../shared_data");
    if (!fs.existsSync(sharedDataPath)) {
      fs.mkdirSync(sharedDataPath, { recursive: true });
    }

    // Genera un nome file univoco
    const uniqueName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
    const filePath = path.join(sharedDataPath, uniqueName);

    fs.writeFileSync(filePath, buffer);

    return c.json({ 
      success: true, 
      filename: uniqueName, 
      url: `/api/files/${uniqueName}`,
      type: file.type
    });
  } catch (error: any) {
    console.error("Upload error:", error);
    return c.json({ error: "File upload failed" }, 500);
  }
});

app.post("/api/chat", async (c) => {
  const { message, sessionId, userId, attachment } = await c.req.json();
  
  if (!message && !attachment) {
    return c.json({ error: "Message or attachment is required" }, 400);
  }
  if (!sessionId || !userId) {
    return c.json({ error: "sessionId and userId are required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    try {
      let finalMessageContent = message;

      // 1. Trascrizione Audio (STT) se l'allegato è una nota vocale
      if (attachment && attachment.type?.startsWith('audio/')) {
        await stream.writeSSE({ data: JSON.stringify({ type: "status", message: "Sto ascoltando l'audio..." }) });
        // Simula o esegui chiamata a Whisper (OpenAI / Groq)
        // const audioBuffer = fs.readFileSync(path.join(__dirname, '../shared_data', attachment.filename));
        // const transcription = await openai.audio.transcriptions.create({ ... })
        finalMessageContent = "Ho ascoltato la tua nota vocale. (Trascrizione automatica: " + message + ")";
      }

      // 2. Salva il messaggio dell'utente nel DB
      const userMessageRecord = await prisma.chatMessage.create({
        data: {
          sessionId,
          role: 'user',
          content: finalMessageContent,
        }
      });

      // 3. Salva l'allegato nel DB se presente
      if (attachment) {
        await prisma.document.create({
          data: {
            messageId: userMessageRecord.id,
            filename: attachment.filename,
            filepath: attachment.url,
            fileType: attachment.type || 'unknown',
            sizeBytes: 0, // Opzionale per ora
          }
        });
      }

      // 4. Carica tutto lo storico della sessione
      const history = await prisma.chatMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'asc' }
      });

      // 3. Costruisci i messaggi per LangGraph
      const agentMessages = history.map((msg) => {
        if (msg.role === 'user') return new HumanMessage(msg.content);
        return new (require("@langchain/core/messages").AIMessage)(msg.content);
      });

      const initialState = {
        messages: agentMessages,
      };

      let lastState: any = null;

      // Usa agentGraph.stream per ottenere gli aggiornamenti dei nodi in tempo reale
      for await (const chunk of await agentGraph.stream(initialState)) {
        const nodeName = Object.keys(chunk)[0];
        lastState = (chunk as Record<string, any>)[nodeName];
        
        let statusMessage = "Sto ragionando...";
        if (nodeName === "supervisor") statusMessage = "L'agente sta pianificando...";
        if (nodeName === "coder") statusMessage = "Sto scrivendo il codice Python...";
        if (nodeName === "executor") statusMessage = "Sto eseguendo il codice nella Sandbox sicura...";
        if (nodeName === "searcher") statusMessage = "Sto cercando informazioni sul web...";
        if (nodeName === "image_gen") statusMessage = "Sto generando l'immagine...";

        await stream.writeSSE({
          data: JSON.stringify({ type: "status", message: statusMessage }),
        });
      }

      if (lastState) {
        const lastMessage = lastState.messages[lastState.messages.length - 1];
        
        let content = lastState.finalResult || lastMessage.content;
        
        if (typeof content === 'string' && content.includes('Supervisor Decision:')) {
          const match = content.match(/Instructions:\s*([\s\S]*)/i);
          if (match && match[1]) {
            content = match[1].trim();
          }
        }

        // 4. Salva la risposta dell'agente nel DB
        await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'agent',
            content: content,
          }
        });

        // Inviamo il risultato finale
        await stream.writeSSE({
          data: JSON.stringify({ 
            type: "result", 
            success: true,
            result: content,
            iterations: lastState.iterations || 1,
          }),
        });
      } else {
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", error: "Empty graph output" }),
        });
      }
    } catch (error: any) {
      console.error("Agent Error:", error);
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", error: error.message }),
      });
    }
  });
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port
});

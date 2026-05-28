import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { agentGraph } from "./graph";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { streamSSE } from "hono/streaming";
import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
const pdfParse = require("pdf-parse");
import { processAndStoreDocument } from "./utils/embeddings";
import dotenv from "dotenv";
dotenv.config();

const app = new Hono();
const prisma = new PrismaClient();

// Funzione di utilità per elaborare i documenti caricati per il RAG
async function processDocumentForRag(documentId: string, filename: string, mimeType: string) {
  try {
    const sharedDataPath = path.resolve(__dirname, "../shared_data");
    const filePath = path.join(sharedDataPath, filename);
    let text = "";

    if (mimeType === 'application/pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      text = data.text;
    } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
      text = fs.readFileSync(filePath, 'utf-8');
    }

    if (text && text.trim().length > 0) {
      console.log(`Sto vettorializzando il documento ${documentId}...`);
      await processAndStoreDocument(documentId, text);
      console.log(`Documento ${documentId} vettorializzato con successo.`);
    }
  } catch (error) {
    console.error(`Errore durante l'elaborazione del documento ${documentId}:`, error);
  }
}

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
        await stream.writeSSE({ data: JSON.stringify({ type: "status", message: "Sto ascoltando la nota vocale..." }) });
        
        try {
          const audioBuffer = fs.readFileSync(path.join(__dirname, '../shared_data', attachment.filename));
          const formData = new FormData();
          const blob = new Blob([audioBuffer], { type: attachment.type });
          formData.append('file', blob, attachment.filename);
          formData.append('model', 'whisper-1');
          formData.append('language', 'it');

          const apiKey = process.env.OPENAI_API_KEY;
          if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

          const sttRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`
            },
            body: formData as any
          });
          
          if (sttRes.ok) {
            const sttData = await sttRes.json();
            finalMessageContent = `[Nota vocale trascritta dall'utente]: ${sttData.text}`;
          } else {
            const errText = await sttRes.text();
            console.error("Whisper API error:", errText);
            finalMessageContent = "[Audio incomprensibile - Errore API Whisper]";
          }
        } catch (e: any) {
          console.error("Errore STT interno:", e);
          finalMessageContent = "[Errore interno durante la trascrizione audio]";
        }
      }

      // 2. Salva il messaggio dell'utente nel DB
      const userMessageRecord = await prisma.chatMessage.create({
        data: {
          sessionId,
          role: 'user',
          content: finalMessageContent,
        }
      });

      // 2.5 Generazione Titolo se è il primo messaggio
      const msgCount = await prisma.chatMessage.count({ where: { sessionId } });
      if (msgCount === 1) {
        try {
          const titleModel = new ChatOpenAI({
            configuration: {
              baseURL: "https://openrouter.ai/api/v1",
              apiKey: process.env.OPENROUTER_API_KEY || "",
              defaultHeaders: {
                "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
                "X-Title": "AI Agent Builder",
              },
            },
            modelName: "google/gemini-3.1-flash-lite",
            temperature: 0.3,
          });
          const titleRes = await titleModel.invoke(`Riassumi questo messaggio in un breve titolo di 3-5 parole. Rispondi SOLO con il titolo, senza virgolette e senza testo aggiuntivo. Messaggio: "${finalMessageContent}"`);
          const title = titleRes.content.toString().replace(/['"]/g, '').trim();
          await prisma.chatSession.update({
            where: { id: sessionId },
            data: { title }
          });
        } catch (e) {
          console.error("Errore generazione titolo:", e);
        }
      }

      // 3. Salva l'allegato nel DB se presente
      if (attachment) {
        const attachPath = path.join(path.resolve(__dirname, "../shared_data"), attachment.filename);
        const attachSize = fs.existsSync(attachPath) ? fs.statSync(attachPath).size : 0;
        const docRecord = await prisma.document.create({
          data: {
            messageId: userMessageRecord.id,
            filename: attachment.filename,
            filepath: attachment.url,
            fileType: attachment.type || 'unknown',
            sizeBytes: attachSize,
          }
        });

        // 3.5 Manda in background l'estrazione RAG
        if (attachment.type === 'application/pdf' || attachment.type === 'text/plain' || attachment.type === 'text/csv') {
          processDocumentForRag(docRecord.id, attachment.filename, attachment.type).catch(console.error);
        }
      }

      // 4. Carica tutto lo storico della sessione
      const history = await prisma.chatMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'asc' }
      });

      // 4.5. Carica i dati del profilo aziendale dell'utente
      const userProfile = await prisma.user.findUnique({
        where: { id: userId }
      });

      // 3. Costruisci i messaggi per LangGraph
      const agentMessages = history.map((msg) => {
        if (msg.role === 'user') return new HumanMessage(msg.content);
        return new (require("@langchain/core/messages").AIMessage)(msg.content);
      });

      const initialState = {
        messages: agentMessages,
        userData: userProfile,
      };

      let lastState: any = null;

      // Usa agentGraph.stream per ottenere gli aggiornamenti dei nodi in tempo reale
      for await (const chunk of await agentGraph.stream(initialState)) {
        const nodeName = Object.keys(chunk)[0];
        lastState = (chunk as Record<string, any>)[nodeName];
        
        let statusMessage = "Elaborazione grafo LangChain...";
        if (nodeName === "supervisor") statusMessage = "[Nodo: Supervisor] Analisi richiesta e routing...";
        if (nodeName === "coder") statusMessage = "[Nodo: Coder] Generazione script Python...";
        if (nodeName === "executor") statusMessage = "[Nodo: Executor] Esecuzione script in container Docker...";
        if (nodeName === "searcher") statusMessage = "[Nodo: Searcher] Interrogazione web API...";
        if (nodeName === "image_gen") statusMessage = "[Nodo: ImageGen] Chiamata API generazione immagine...";
        if (nodeName === "pdf_maker") statusMessage = "[Nodo: PDFMaker] Compilazione HTML e rendering Puppeteer...";
        if (nodeName === "retriever") statusMessage = "[Nodo: Retriever] Vettorializzazione ed estrazione dati...";

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
        const agentMessageRecord = await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'agent',
            content: content,
          }
        });

        // 4.5. Controlla se c'è un file generato
        const fileMatch = content.match(/\[File Generato:\s*([^\]]+)\]/);
        if (fileMatch && fileMatch[1]) {
          const generatedFilename = fileMatch[1].trim();
          let ext = path.extname(generatedFilename).toLowerCase();
          let fileType = 'unknown';
          if (ext === '.pdf') fileType = 'application/pdf';
          else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') fileType = 'image/' + ext.substring(1);
          
          const genFilePath = path.join(path.resolve(__dirname, "../shared_data"), generatedFilename);
          const genFileSize = fs.existsSync(genFilePath) ? fs.statSync(genFilePath).size : 0;
          await prisma.document.create({
            data: {
              messageId: agentMessageRecord.id,
              filename: generatedFilename,
              filepath: `/api/files/${generatedFilename}`,
              fileType: fileType,
              sizeBytes: genFileSize,
            }
          });
        }

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

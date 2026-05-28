import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { agentGraph } from "./graph";
import { HumanMessage } from "@langchain/core/messages";

import { streamSSE } from "hono/streaming";
import * as fs from "fs";
import * as path from "path";

const app = new Hono();

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
    else if (ext === ".png") contentType = "image/png";
    else if (ext === ".csv") contentType = "text/csv";
    
    c.header("Content-Type", contentType);
    return c.body(file);
  } else {
    return c.json({ error: "File not found" }, 404);
  }
});

// Endpoint per invocare l'agente con Server-Sent Events (SSE)
app.post("/api/chat", async (c) => {
  const { message } = await c.req.json();
  
  if (!message) {
    return c.json({ error: "Message is required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    try {
      const initialState = {
        messages: [new HumanMessage(message)],
      };

      let lastState: any = null;

      // Usa agentGraph.stream per ottenere gli aggiornamenti dei nodi in tempo reale
      for await (const chunk of await agentGraph.stream(initialState)) {
        // Estrai il nome del nodo che ha appena finito di eseguire
        const nodeName = Object.keys(chunk)[0];
        lastState = chunk[nodeName];
        
        let statusMessage = "Sto ragionando...";
        if (nodeName === "supervisor") statusMessage = "L'agente sta pianificando...";
        if (nodeName === "coder") statusMessage = "Sto scrivendo il codice Python...";
        if (nodeName === "executor") statusMessage = "Sto eseguendo il codice nella Sandbox sicura...";
        if (nodeName === "searcher") statusMessage = "Sto cercando informazioni sul web...";
        if (nodeName === "image_gen") statusMessage = "Sto generando l'immagine...";

        // Invia lo stato al frontend
        await stream.writeSSE({
          data: JSON.stringify({ type: "status", message: statusMessage }),
        });
      }

      if (lastState) {
        const lastMessage = lastState.messages[lastState.messages.length - 1];
        
        // Cerca di estrarre e filtrare l'output
        // Se c'è un finalResult è il risultato desiderato. Altrimenti usiamo il testo del supervisor.
        // Se il testo del supervisor contiene tool calls, formattiamo.
        let content = lastState.finalResult || lastMessage.content;
        
        // Pulisce l'output da eventuali log di tool se non richiesti esplicitamente (miglioramento UX)
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

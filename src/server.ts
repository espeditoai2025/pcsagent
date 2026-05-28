import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { agentGraph } from "./graph";
import { HumanMessage } from "@langchain/core/messages";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Agent Backend is running.");
});

// Endpoint per invocare l'agente
app.post("/api/chat", async (c) => {
  try {
    const { message } = await c.req.json();
    
    if (!message) {
      return c.json({ error: "Message is required" }, 400);
    }

    // Inizializza lo stato
    const initialState = {
      messages: [new HumanMessage(message)],
    };

    // Esegue il grafo fino alla fine
    const finalState = await agentGraph.invoke(initialState);
    
    // Ritorna l'ultimo messaggio o il finalResult
    const lastMessage = finalState.messages[finalState.messages.length - 1];
    
    return c.json({
      success: true,
      result: finalState.finalResult || lastMessage.content,
      iterations: finalState.iterations,
      error: finalState.executionError,
    });
  } catch (error: any) {
    console.error("Agent Error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port
});

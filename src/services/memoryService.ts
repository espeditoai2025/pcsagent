import { ChatOpenAI } from "@langchain/openai";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

// Modello leggero e veloce per l'estrazione della memoria
const memoryModel = new ChatOpenAI({
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY || "",
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "AI Agent Builder",
    },
  },
  modelName: "google/gemini-3.1-flash-lite",
  temperature: 0.1,
  maxTokens: 500,
});

const MEMORY_MAX_CHARS = 2000;

/**
 * Estrae fatti utili dalla conversazione e aggiorna la memoria dell'utente.
 * Gira in background (fire-and-forget) dopo ogni risposta dell'agente.
 * 
 * Strategia:
 * - Analizza solo gli ULTIMI messaggi della sessione (gli ultimi 2: domanda + risposta)
 * - Confronta con la memoria esistente per evitare duplicati
 * - Il modello decide autonomamente se ci sono fatti nuovi da aggiungere
 * - Se non c'è nulla di nuovo, restituisce la memoria invariata
 */
export async function extractAndUpdateMemory(userId: string, sessionId: string): Promise<void> {
  try {
    // 1. Leggi la memoria attuale dell'utente
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { agentMemory: true },
    });

    const currentMemory = user?.agentMemory || "";

    // 2. Leggi gli ultimi messaggi della sessione (max ultimi 6 per contesto)
    const recentMessages = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { role: true, content: true },
    });

    if (recentMessages.length < 2) return; // Serve almeno uno scambio utente-agente

    // Riordina cronologicamente
    const messagesText = recentMessages
      .reverse()
      .map((m) => `${m.role === "user" ? "UTENTE" : "AGENTE"}: ${m.content}`)
      .join("\n");

    // 3. Chiedi al modello di estrarre fatti nuovi
    const extractionPrompt = `Sei un sistema di memoria per un assistente AI. Analizza questa conversazione ed estrai SOLO informazioni utili e durature sull'utente.

=== MEMORIA ATTUALE ===
${currentMemory || "(vuota — primo salvataggio)"}

=== CONVERSAZIONE RECENTE ===
${messagesText}

=== ISTRUZIONI ===
- Aggiorna la memoria integrando eventuali FATTI NUOVI sull'utente (nome, lavoro, preferenze, progetti, contesto aziendale, abitudini, richieste ricorrenti)
- NON aggiungere informazioni generiche o temporanee (es. "ha chiesto un preventivo" non è utile, ma "lavora nel settore edile" lo è)
- NON ripetere fatti già presenti nella memoria attuale
- Se NON ci sono fatti nuovi da aggiungere, rispondi ESATTAMENTE con: [NESSUN_AGGIORNAMENTO]
- Mantieni il formato conciso con bullet points
- Massimo ${MEMORY_MAX_CHARS} caratteri totali
- Scrivi in italiano, in terza persona (es. "L'utente si chiama Marco", "Lavora a Milano")

Rispondi SOLO con la memoria aggiornata completa (o [NESSUN_AGGIORNAMENTO]).`;

    const response = await memoryModel.invoke(extractionPrompt);
    const updatedMemory = (response.content as string).trim();

    // 4. Se il modello indica nessun aggiornamento, esci
    if (updatedMemory.includes("[NESSUN_AGGIORNAMENTO]")) {
      return;
    }

    // 5. Tronca se necessario e salva
    const truncatedMemory = updatedMemory.slice(0, MEMORY_MAX_CHARS);

    await prisma.user.update({
      where: { id: userId },
      data: { agentMemory: truncatedMemory },
    });

    console.log(`[Memory] Memoria utente ${userId} aggiornata (${truncatedMemory.length} chars)`);
  } catch (error) {
    // Non deve mai bloccare il flusso principale
    console.error("[Memory] Errore durante l'estrazione della memoria:", error);
  }
}

/**
 * Legge la memoria formattata per il prompt dell'agente.
 * Restituisce una stringa pronta da iniettare nel system prompt.
 */
export function formatMemoryForPrompt(agentMemory: string | null | undefined): string {
  if (!agentMemory || agentMemory.trim().length === 0) {
    return "";
  }

  return `
=== MEMORIA DELL'UTENTE (dalle conversazioni precedenti) ===
${agentMemory.trim()}
Usa queste informazioni per personalizzare le tue risposte. Non ripetere queste informazioni esplicitamente a meno che l'utente non te le chieda.`;
}

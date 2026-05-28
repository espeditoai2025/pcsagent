import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing");

  // Uso del modello openai/text-embedding-3-small tramite OpenRouter
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pcsagent.vercel.app", // Referer obbligatorio per OpenRouter
      "X-Title": "PCS Agent"
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text
    })
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`OpenRouter Embedding API failed: ${response.status} - ${errorData}`);
  }

  const data = await response.json();
  if (!data.data || !data.data[0] || !data.data[0].embedding) {
    throw new Error("Invalid response format from OpenRouter Embeddings");
  }

  return data.data[0].embedding;
}

export function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

export async function processAndStoreDocument(documentId: string, text: string) {
  const chunks = chunkText(text);
  
  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk);
    
    // Inserisce il chunk nel database vettoriale utilizzando pgvector con una query raw
    await prisma.$executeRaw`
      INSERT INTO "DocumentChunk" (id, "documentId", content, embedding, "createdAt")
      VALUES (gen_random_uuid(), ${documentId}, ${chunk}, ${embedding}::vector, NOW())
    `;
  }
}

export async function searchSimilarChunks(query: string, limit = 3): Promise<any[]> {
  const queryEmbedding = await generateEmbedding(query);
  
  // Utilizza l'operatore <=> per la distanza coseno di pgvector
  const results = await prisma.$queryRaw`
    SELECT "documentId", content, 1 - (embedding <=> ${queryEmbedding}::vector) AS similarity
    FROM "DocumentChunk"
    ORDER BY embedding <=> ${queryEmbedding}::vector
    LIMIT ${limit}
  `;
  
  return results as any[];
}

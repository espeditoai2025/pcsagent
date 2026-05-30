import { searchSimilarChunks } from "../utils/embeddings";

export const retrieverNode = async (state: any) => {
  console.log("---RETRIEVER NODE---");
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];
  const query = lastMessage.content;
  const userId = state.userData?.id;

  if (!userId) {
    const msg = "Non riesco ad accedere ai documenti: utente non identificato.";
    return {
      messages: [...messages, { role: "system", content: msg }],
      finalResult: msg,
    };
  }

  try {
    // Cerca SOLO nei documenti dell'utente corrente (isolamento multi-tenant)
    const results = await searchSimilarChunks(query, 3, userId);
    
    let resultText = "";
    if (results && results.length > 0) {
      resultText = "Ho trovato le seguenti informazioni nei documenti allegati dell'utente:\n\n";
      results.forEach((r, i) => {
        resultText += `[Documento ${i+1}] (Rilevanza: ${(r.similarity * 100).toFixed(1)}%):\n${r.content}\n\n`;
      });
    } else {
      resultText = "Non ho trovato informazioni rilevanti nei documenti caricati.";
    }

    return {
      messages: [...messages, { role: "system", content: resultText }],
      finalResult: resultText
    };
  } catch (error: any) {
    console.error("Retriever Error:", error);
    return {
      messages: [...messages, { role: "system", content: `Errore nella ricerca documenti: ${error.message}` }],
    };
  }
};

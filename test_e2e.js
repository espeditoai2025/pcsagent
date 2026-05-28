const fs = require('fs');

async function runTest() {
  const fileContent = fs.readFileSync('fatturato.txt');
  const blob = new Blob([fileContent], { type: 'text/plain' });
  const formData = new FormData();
  formData.append('file', blob, 'fatturato.txt');

  console.log("1. Caricamento file 'fatturato.txt' sul server...");
  const uploadRes = await fetch('http://187.124.221.180:3005/api/upload', {
    method: 'POST',
    body: formData
  });

  if (!uploadRes.ok) {
    console.error("Upload fallito", await uploadRes.text());
    return;
  }
  
  const uploadData = await uploadRes.json();
  console.log("Upload completato:", uploadData);

  // Aspettiamo un paio di secondi per dare tempo al chunking e embedding
  await new Promise(r => setTimeout(r, 2000));

  console.log("\n2. Invio richiesta RAG alla Chat...");
  
  // Utilizzo delle chiavi reali create nel database della VPS
  const sessionId = "f14bd938-0153-48d1-ba99-64cbc8e259e1";
  const userId = "1a6018b0-bf0d-46ee-bd1c-acfbf419a95a";

  const chatBody = {
    message: "Qual è stato il fatturato del 2025 e l'obiettivo per il 2026?",
    sessionId,
    userId,
    attachment: {
      url: uploadData.url,
      filename: uploadData.filename,
      type: 'text/plain'
    }
  };

  const chatRes = await fetch('http://187.124.221.180:3005/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatBody)
  });

  if (!chatRes.ok) {
    console.error("Chat fallita", await chatRes.text());
    return;
  }

  // Lettura streaming SSE
  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'status') {
            console.log(`[Stato]: ${data.message}`);
          } else if (data.type === 'result') {
            console.log(`\n✅ [Risposta Agente]:\n${data.result}`);
          } else if (data.type === 'error') {
            console.error(`❌ [Errore]: ${data.error}`);
          }
        } catch(e) {}
      }
    }
  }
}

runTest().catch(console.error);

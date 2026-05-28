// Assicurati di avere Node.js 18+ per il fetch nativo
async function testAgent() {
  const url = "http://187.124.221.180:3005/api/chat";
  
  // Richiesta che forzerà il Supervisor a chiamare il CoderNode, e di conseguenza l'ExecutorNode (Docker)
  const prompt = "Genera uno script Python che calcoli i primi 15 numeri della sequenza di Fibonacci e stampi il risultato a schermo usando print().";

  console.log(`Inviando richiesta all'agente su ${url}...\nAttendi, l'agente sta ragionando ed eseguendo Docker...`);
  console.log(`Prompt: "${prompt}"\n`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: prompt }),
    });

    const data = await response.json();
    console.log("==========================================");
    console.log("RISPOSTA DELL'AGENTE:");
    console.log("==========================================");
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Errore di connessione. Forse il server PM2 si sta ancora avviando?", error.message);
  }
}

testAgent();

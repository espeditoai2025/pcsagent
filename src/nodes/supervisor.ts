import { AgentState } from "../state";
import { routerModel, makeChatModel } from "../services/llm";
import { formatMemoryForPrompt } from "../services/memoryService";
import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

const routerSchema = z.object({
  next: z.enum(["coder", "searcher", "image_gen", "retriever", "pdf_maker", "gestionale", "social_scheduler", "finish"]),
  instructions: z.string().describe("Istruzioni dettagliate e specifiche per il nodo successivo"),
});

export const supervisorNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  // Costruisci il blocco memoria dall'userData
  const userData = state.userData || {};
  const memoryBlock = formatMemoryForPrompt(userData.agentMemory);

  // Costruisci il blocco dati aziendali
  const nomeCompleto = [userData.firstName, userData.lastName].filter(Boolean).join(" ");
  const indirizzo = [userData.street, userData.city, userData.zipCode].filter(Boolean).join(", ");
  const hasCompanyData = !!(userData.companyName || nomeCompleto);
  const companyBlock = hasCompanyData ? `
=== DATI AZIENDALI UTENTE ===
Nome: ${nomeCompleto}
Azienda: ${userData.companyName || ""}
P.IVA: ${userData.vatNumber || ""}
Indirizzo: ${indirizzo}
Telefono: ${userData.phone || ""}
Email: ${userData.email || ""}
Sito Web: ${userData.website || ""}` : "";

  // Personalità/istruzioni specifiche dell'agente (configurate dall'admin per il cliente)
  const agentPromptBlock = state.agentPrompt
    ? `\n=== ISTRUZIONI DELL'AGENTE (priorità alta) ===\n${state.agentPrompt}\n`
    : "";

  const systemPrompt = `Sei il Supervisor di un Agente AI autonomo. Analizza la richiesta dell'utente e scegli lo strumento corretto.
${agentPromptBlock}${memoryBlock}
${companyBlock}

=== STRUMENTI DISPONIBILI ===

🐍 'coder' — STRUMENTO PRINCIPALE. Esegue Python in un container Docker con accesso internet completo.
   USA per:
   - Qualsiasi automazione, calcolo, elaborazione dati
   - Analisi di file (CSV, Excel, PDF) e generazione di report dati
   - Scraping web (estrarre prezzi/dati da un sito, anche dinamico con Playwright), chiamate API, download file
   - PDF con grafici, calcoli complessi o elaborazione dati
   - Qualsiasi task che richiede logica Python
   USA 'coder' per documenti SOLO se l'utente chiede esplicitamente grafici, calcoli su dati o elaborazioni complesse.

📄 'pdf_maker' — Generatore documenti aziendali con carta intestata. USA per:
   - Preventivi, fatture, offerte, contratti, report — anche con prodotti specifici e prezzi già forniti
   - Qualsiasi documento dove i dati sono già presenti nel messaggio dell'utente
   - Documenti con FOTO DEL PRODOTTO: usa tag <img src="URL"> con URL pubblici del produttore
     (es. lenovo.com, hp.com, Dell.com, Amazon, ecc.) — Puppeteer li carica automaticamente.
     Istruisci pdf_maker a cercare un URL immagine realistico per il prodotto richiesto.
   NON usare 'coder' per generare PDF con immagini — pdf_maker gestisce tutto tramite Puppeteer.

🔍 'searcher' — Ricerca web in tempo reale.
   USA per: notizie recenti, prezzi attuali, informazioni aggiornate non presenti nel training.

🖼️ 'image_gen' — Generazione immagini AI.
   USA per: creare immagini, illustrazioni, loghi, mockup da testo.

📚 'retriever' — Ricerca nei documenti caricati dall'utente.
   USA per: "nel documento che ti ho mandato...", "nel PDF/CSV/file che ho allegato..."

🏢 'gestionale' — Accede ai dati aziendali dell'utente (clienti, fornitori, prodotti, preventivi).
   USA per:
   - Creare preventivi/offerte per un cliente specifico usando i prodotti del catalogo
   - "fai un preventivo per [cliente] per [prodotto]"
   - "mostrami la lista clienti / fornitori / prodotti"
   - "invia un'email a [cliente]" — il nodo caricherà l'email del cliente dal gestionale
   - Analisi contabilità, storico preventivi, fatturato, riepilogo commerciale
   - Qualsiasi richiesta che richiede dati specifici dell'azienda (prezzi, anagrafiche, quantità)
   IMPORTANTE: dopo 'gestionale', l'agente può passare a 'pdf_maker' per generare il documento
   o a 'coder' per inviare email.

📅 'social_scheduler' — Pubblicazioni su Facebook: sia TEST IMMEDIATI sia programmazioni ricorrenti.
   USA per:
   - "fai un post di test", "pubblica ora", "prova a pubblicare un post" → pubblicazione IMMEDIATA
   - "pubblica ogni giorno alle 9 un prodotto dal mio Google Sheet / file Excel" → ricorrente
   - "programma post automatici", "imposta un cron per pubblicare sui social"
   - Qualsiasi richiesta di pubblicazione su Facebook, immediata o pianificata
   NON usare 'coder' per questo: lo scheduler gestisce credenziali cifrate, test e cron.
   Le 'instructions' devono riportare integralmente la richiesta dell'utente.

💬 'finish' — Risposta diretta senza tool.
   USA SOLO per: saluti, domande generali di conversazione, domande a cui puoi rispondere direttamente.
   IMPORTANTE: quando usi 'finish', il campo 'instructions' contiene ESATTAMENTE il testo che verrà mostrato all'utente.
   Scrivi la risposta IN PRIMA PERSONA, come se tu fossi l'assistente che parla direttamente all'utente.
   NON scrivere meta-istruzioni come "Rispondi all'utente spiegando che..." — scrivi direttamente "Non ho accesso..."
   Esempio SBAGLIATO: "Rispondi all'utente dicendo che non ho memoria"
   Esempio CORRETTO: "Ciao Marco! Come posso aiutarti oggi?"

=== REGOLA FONDAMENTALE ===
NON dire mai "non posso farlo". Se la richiesta è complessa, usa 'coder' — il container Python può fare quasi tutto.
Per gli altri nodi (coder, pdf_maker, ecc.), le 'instructions' spiegano cosa il nodo deve fare.

Rispondi SOLO in JSON valido:
{ "next": "...", "instructions": "..." }`;

  const messages = [
    new SystemMessage(systemPrompt),
    ...state.messages,
  ];

  // Usa il modello del grado di intelligenza scelto dall'utente (fallback al router base)
  const model = state.chatModel ? makeChatModel(state.chatModel, 0) : routerModel;
  const response = await model.withStructuredOutput(routerSchema).invoke(messages);

  return {
    messages: [new SystemMessage(`Supervisor Decision: ROUTE TO ${response.next}\nInstructions: ${response.instructions}`)],
  };
};

export const routerEdge = (state: AgentState): string => {
  const lastMessage = state.messages[state.messages.length - 1];
  const content = lastMessage.content as string;

  if (content.includes("ROUTE TO coder")) return "coder";
  if (content.includes("ROUTE TO searcher")) return "searcher";
  if (content.includes("ROUTE TO image_gen")) return "image_gen";
  if (content.includes("ROUTE TO retriever")) return "retriever";
  if (content.includes("ROUTE TO pdf_maker")) return "pdf_maker";
  if (content.includes("ROUTE TO gestionale")) return "gestionale";
  if (content.includes("ROUTE TO social_scheduler")) return "social_scheduler";

  return "finish";
};

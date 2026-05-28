import { AgentState } from "../state";
import { coderModel } from "../services/llm";
import { SystemMessage } from "@langchain/core/messages";
import puppeteer from "puppeteer";
import * as path from "path";
import * as fs from "fs/promises";
import crypto from "crypto";

export const pdfMakerNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  // 1. Estrai i dati aziendali dell'utente
  const u = state.userData || {};
  const nomeCompleto = [u.firstName, u.lastName].filter(Boolean).join(" ") || "Utente Sconosciuto";
  const indirizzoCompleto = [u.street, u.city, u.zipCode].filter(Boolean).join(", ") || "Indirizzo non specificato";
  
  const companyInfo = `
    Nome/Intestatario: ${nomeCompleto}
    Azienda: ${u.companyName || ""}
    P.IVA: ${u.vatNumber || ""}
    Indirizzo: ${indirizzoCompleto}
    Telefono: ${u.phone || ""}
    Sito Web: ${u.website || ""}
    URL Logo: ${u.companyLogoUrl || ""}
  `;

  // 2. Costruisci il prompt per generare solo l'HTML
  const prompt = `Sei un esperto designer e sviluppatore frontend. L'utente ti ha chiesto di generare un documento professionale (preventivo, report, fattura, ecc.).
Devi generare ESCLUSIVAMENTE il codice sorgente HTML completo di un documento impaginato in A4.

REGOLE FONDAMENTALI:
1. Il codice generato DEVE essere racchiuso nel tag <html> e includere <head> e <body>.
2. Usa TailwindCSS via CDN (es. <script src="https://cdn.tailwindcss.com"></script>) per lo styling, oppure CSS inline molto ben curato.
3. Il documento deve avere un aspetto estremamente professionale, moderno, elegante e ben allineato. Usa Google Fonts (es. Inter o Roboto).
4. **INTEGRAZIONE DATI AZIENDALI:** Devi includere un'intestazione (header) professionale usando questi dati dell'utente:
${companyInfo}
Se è presente l'URL del Logo, inseriscilo in un tag <img src="..." class="h-16 object-contain"> in alto a sinistra o al centro.
5. Usa tabelle ben formattate per prezzi o dati strutturati. Usa layout a griglia.
6. Ritorna SOLO E SOLTANTO il codice HTML. Nessun blocco markdown \`\`\`html, nessuna spiegazione prima o dopo. Il tuo output sarà salvato in un file .html e convertito in PDF.`;

  const lastMsg = state.messages[state.messages.length - 1].content as string;
  
  const messages = [
    new SystemMessage(prompt),
    ...state.messages,
    new SystemMessage(`Istruzioni specifiche per il documento:\n${lastMsg}`)
  ];

  console.log("PDF Maker: Sto generando il template HTML...");
  const response = await coderModel.invoke(messages);
  
  let htmlCode = response.content as string;
  // Pulizia da eventuali blocchi markdown
  htmlCode = htmlCode.replace(/^```html\s*/i, "").replace(/```$/i, "").trim();

  // 3. Salva l'HTML temporaneo
  const sharedDataDir = path.resolve(process.cwd(), "shared_data");
  await fs.mkdir(sharedDataDir, { recursive: true }).catch(() => {});
  
  const uniqueId = crypto.randomBytes(4).toString("hex");
  const htmlFileName = `temp_${uniqueId}.html`;
  const pdfFileName = `Documento_${uniqueId}.pdf`;
  
  const htmlFilePath = path.join(sharedDataDir, htmlFileName);
  const pdfFilePath = path.join(sharedDataDir, pdfFileName);

  await fs.writeFile(htmlFilePath, htmlCode, "utf8");

  // 4. Converti in PDF usando Puppeteer
  console.log("PDF Maker: Avvio conversione HTML -> PDF via Puppeteer...");
  try {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
      channel: 'chrome'
    });
    const page = await browser.newPage();
    
    // Imposta l'HTML
    await page.setContent(htmlCode, { waitUntil: 'domcontentloaded' });
    
    // Stampa PDF
    await page.pdf({
      path: pdfFilePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
    });
    
    await browser.close();
    console.log("PDF Maker: PDF generato con successo.");

    // Pulizia file html
    await fs.unlink(htmlFilePath).catch(() => {});

    const finalResultMessage = `Ho preparato il tuo documento professionale impaginato usando i dati della tua azienda.\n\n[File Generato: ${pdfFileName}]`;

    return {
      messages: [new SystemMessage(`Conversione PDF completata: ${pdfFileName}`)],
      finalResult: finalResultMessage,
    };
  } catch (error: any) {
    console.error("PDF Maker Error:", error);
    return {
      messages: [new SystemMessage(`Errore durante la generazione del PDF: ${error.message}`)],
      executionError: error.message,
    };
  }
};

import { AgentState } from "../state";
import { coderModel } from "../services/llm";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import puppeteer from "puppeteer";
import * as path from "path";
import * as fs from "fs/promises";
import crypto from "crypto";

export const pdfMakerNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  const u = state.userData || {};
  const nomeCompleto = [u.firstName, u.lastName].filter(Boolean).join(" ") || "Utente";
  const indirizzoCompleto = [u.street, u.city, u.zipCode].filter(Boolean).join(", ") || "";

  const companyInfo = `
Nome/Intestatario: ${nomeCompleto}
Azienda: ${u.companyName || ""}
P.IVA: ${u.vatNumber || "N/D"}
Indirizzo: ${indirizzoCompleto}
Telefono: ${u.phone || ""}
Email: ${u.email || ""}
Sito Web: ${u.website || ""}
URL Logo: ${u.companyLogoUrl || ""}`.trim();

  const userRequest = state.messages[state.messages.length - 1].content as string;

  const htmlPrompt = `Sei un designer UI/UX esperto in documenti aziendali. Genera un documento HTML/CSS completo, impaginato in formato A4, con grafica PROFESSIONALE e MODERNA.

=== DATI AZIENDALI DA INTEGRARE ===
${companyInfo}

=== RICHIESTA DELL'UTENTE ===
${userRequest}

=== REGOLE DI DESIGN OBBLIGATORIE ===

1. STRUTTURA HTML
   - Documento completo: <!DOCTYPE html><html lang="it"><head>...</head><body>...</body></html>
   - Charset UTF-8, viewport per A4
   - ZERO dipendenze esterne eccetto Google Fonts via @import nel CSS

2. TIPOGRAFIA
   @import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,600;0,700;0,800;1,400&display=swap');
   - Font principale: Inter (Google Fonts)
   - Gerarchia: titolo principale 22pt bold, sezioni 13pt semibold, corpo 9.5pt regular
   - Interlinea: 1.5 per il corpo, 1.2 per le celle tabella

3. PALETTE COLORI (adatta al tipo di documento)
   - Fattura/Preventivo: primario #0f2557, accento #2563eb, sfondo header #f0f4ff
   - Report/Analisi: primario #064e3b, accento #059669, sfondo header #ecfdf5
   - Proposta/Contratto: primario #1e1b4b, accento #7c3aed, sfondo header #f5f3ff
   - Default: primario #1e293b, accento #3b82f6, sfondo header #f8fafc

4. LAYOUT HEADER (obbligatorio, posizionato in cima)
   - Flexbox row, space-between
   - Sinistra: logo aziendale (se URL logo disponibile: <img src="URL" style="height:50px; object-fit:contain">),
     altrimenti iniziali azienda in un box colorato
   - Centro/Destra: dati azienda (nome, P.IVA, indirizzo, telefono, email) in font size 8.5pt
   - Tipo documento (es. "PREVENTIVO", "FATTURA", "REPORT") in UPPERCASE, font-size:28pt, colore accento, lettera-spacing:3px

5. CORPO DEL DOCUMENTO
   - Usa CSS Grid o Flexbox per layout pulito
   - Per tabelle prodotti/servizi:
     * Intestazione colonna con sfondo primario, testo bianco, padding 10px
     * Righe alternate: bianco / #f8fafc
     * Colonne numeriche allineate a destra
     * Riga totale finale con sfondo accento, testo bianco, font-weight:700
     * Bordi: 1px solid #e2e8f0
   - Box informativi (es. dati cliente, note) con border-left:4px solid accento, padding:15px, sfondo leggero
   - Separatori sezione: line hr con gradiente o bordo top

6. FOOTER
   - Bordo top 2px colore primario
   - Info pagamento (se fattura/preventivo) o disclaimer
   - "Pagina 1" centrato, font-size:8pt, colore grigio
   - Data generazione documento

7. STAMPA/PDF OTTIMIZZATA
   @page {{ size: A4; margin: 0; }}
   @media print {{
     body {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
     .no-print {{ display: none; }}
   }}
   - Evita page-break dentro le tabelle
   - Margini interni pagina: 15mm su tutti i lati tramite padding sul body o wrapper

8. CONTENUTO
   - Compila TUTTI i campi con dati realistici e coerenti basati sulla richiesta utente
   - Per preventivi/fatture: includi voci con descrizione, quantità, prezzo unitario, IVA 22%, totale
   - Per report: includi sezioni chiare, eventuali statistiche fittizie coerenti, raccomandazioni
   - Testo in italiano, valuta Euro (€), formato date italiano (GG/MM/AAAA)
   - Numero documento: usa formato anno+sequenza (es. PRV-2024-001)

RITORNA SOLO IL CODICE HTML COMPLETO. Nessun blocco markdown \`\`\`html, zero testo prima o dopo.
Il tuo output viene salvato direttamente come file .html e renderizzato in PDF.`;

  const messages = [
    new SystemMessage(htmlPrompt),
    new HumanMessage(userRequest),
  ];

  console.log("PDF Maker: Generazione template HTML professionale...");
  const response = await coderModel.invoke(messages);

  let htmlCode = response.content as string;

  // Estrazione robusta dell'HTML
  const htmlMatch = htmlCode.match(/<!DOCTYPE[\s\S]*<\/html>/i) || htmlCode.match(/<html[\s\S]*<\/html>/i);
  if (htmlMatch) {
    htmlCode = htmlMatch[0];
  } else {
    const mdMatch = htmlCode.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (mdMatch) htmlCode = mdMatch[1].trim();
  }

  const sharedDataDir = path.resolve(process.cwd(), "shared_data");
  await fs.mkdir(sharedDataDir, { recursive: true }).catch(() => {});

  const uniqueId = crypto.randomBytes(4).toString("hex");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // Rileva il tipo di documento per il nome file
  const req = userRequest.toLowerCase();
  let docType = "documento";
  if (req.includes("preventiv")) docType = "preventivo";
  else if (req.includes("fattur")) docType = "fattura";
  else if (req.includes("report") || req.includes("analisi")) docType = "report";
  else if (req.includes("proposta") || req.includes("offerta")) docType = "offerta";
  else if (req.includes("contratt")) docType = "contratto";

  const htmlFileName = `${docType}_${today}_${uniqueId}.html`;
  const pdfFileName = `${docType}_${today}_${uniqueId}.pdf`;

  const htmlFilePath = path.join(sharedDataDir, htmlFileName);
  const pdfFilePath = path.join(sharedDataDir, pdfFileName);

  await fs.writeFile(htmlFilePath, htmlCode, "utf8");
  console.log(`PDF Maker: HTML salvato → ${htmlFileName}`);

  // Converti in PDF via Puppeteer (Chromium host)
  console.log("PDF Maker: Rendering HTML → PDF via Puppeteer...");
  try {
    const browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
      ],
      headless: true,
      executablePath: '/usr/bin/chromium-browser',
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 }); // A4 px at 96dpi

    // Carica tramite URL locale per supportare risorse relative
    await page.setContent(htmlCode, { waitUntil: 'load' });

    // Attendi Google Fonts e risorse di rete
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    await page.pdf({
      path: pdfFilePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    await browser.close();
    console.log(`PDF Maker: PDF generato con successo → ${pdfFileName}`);

    const finalMsg =
      `Ho generato il tuo documento professionale in formato PDF.\n\n` +
      `Puoi scaricarlo qui sotto:\n\n` +
      `[File Generato: ${pdfFileName}]\n\n` +
      `È disponibile anche il template HTML modificabile:\n[File Generato: ${htmlFileName}]`;

    return {
      messages: [new SystemMessage(`PDF generato: ${pdfFileName} | HTML: ${htmlFileName}`)],
      finalResult: finalMsg,
    };
  } catch (error: any) {
    console.error("PDF Maker Error:", error.message);

    // Fallback: ritorna almeno l'HTML
    const fallbackMsg =
      `Si è verificato un errore durante la conversione in PDF (${error.message}).\n\n` +
      `Ho comunque salvato il template HTML che puoi aprire nel browser e stampare come PDF:\n\n` +
      `[File Generato: ${htmlFileName}]`;

    return {
      messages: [new SystemMessage(`Errore PDF, HTML disponibile: ${htmlFileName}`)],
      finalResult: fallbackMsg,
    };
  }
};

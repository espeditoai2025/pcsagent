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

  // Data corrente da iniettare nel documento
  const oggi = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
  const annoCorrente = new Date().getFullYear();

  // Logo HTML — costruito qui per non ingolfare il prompt LLM con base64 enormi
  // Il logo viene iniettato DOPO che l'LLM genera l'HTML, sostituendo il placeholder
  const LOGO_PLACEHOLDER = "___LOGO_AZIENDALE___";
  const logoHtml = u.companyLogoUrl
    ? `<img src="${u.companyLogoUrl}" style="height:55px; max-width:180px; object-fit:contain; display:block;" alt="Logo">`
    : `<div style="width:55px;height:55px;background:#0f2557;border-radius:6px;display:flex;align-items:center;justify-content:center;color:white;font-weight:800;font-size:18px;">${(u.companyName || nomeCompleto || "A").charAt(0).toUpperCase()}</div>`;

  const companyInfo = `
Intestatario: ${nomeCompleto}
Azienda: ${u.companyName || ""}
P.IVA: ${u.vatNumber || "N/D"}
Indirizzo: ${indirizzoCompleto}
Telefono: ${u.phone || ""}
Email: ${u.email || ""}
Sito Web: ${u.website || ""}
DATA DOCUMENTO: ${oggi}
ANNO: ${annoCorrente}`.trim();

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
   - Sinistra: inserisci ESATTAMENTE questo testo come placeholder per il logo (verrà sostituito automaticamente):
     ${LOGO_PLACEHOLDER}
   - Destra: dati azienda (nome, P.IVA, indirizzo, telefono, email) in font size 8.5pt
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
   @media print {{
     body {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
   }}
   - Evita page-break dentro le tabelle
   - Margini interni pagina: 15mm su tutti i lati tramite padding sul body o wrapper
   - NON usare @page CSS — la gestione pagina è affidata a Puppeteer

8. PREZZI E IVA — REGOLA FONDAMENTALE
   - Se l'utente indica un prezzo (es. "799€", "1.200 euro") SENZA specificare nulla → è SEMPRE IVA INCLUSA (22%)
   - Calcola IVA esclusa = prezzo / 1.22, IVA = prezzo - imponibile
   - Solo se l'utente scrive "+ IVA", "IVA esclusa", "netto" → il prezzo è imponibile e devi aggiungere IVA sopra
   - Nel documento specifica sempre chiaramente: "Prezzi IVA inclusa (22%)" o "Prezzi IVA esclusa"

9. CONTENUTO
   - Compila TUTTI i campi con dati realistici e coerenti basati sulla richiesta utente
   - Per preventivi/fatture: righe prodotto con descrizione, quantità, prezzo unitario, riepilogo IVA, totale finale
   - Per report: includi sezioni chiare, eventuali statistiche fittizie coerenti, raccomandazioni
   - Testo in italiano, valuta Euro (€), formato date italiano (GG/MM/AAAA)
   - Numero documento: usa formato anno+sequenza con anno corrente (es. PRV-${annoCorrente}-001)
   - VIETATO usare immagini in base64. Per immagini prodotto usa URL diretti pubblici (.jpg/.png/.webp) che Puppeteer caricherà automaticamente.

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

  // Sostituisce il placeholder con il logo reale (base64 o URL)
  // In questo modo il prompt LLM non viene ingolfato con dati enormi
  htmlCode = htmlCode.replace(new RegExp(LOGO_PLACEHOLDER, 'g'), logoHtml);

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
    await page.setViewport({ width: 794, height: 1123 });

    await page.setContent(htmlCode, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Attendi caricamento immagini esterne, Google Fonts e rendering
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

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

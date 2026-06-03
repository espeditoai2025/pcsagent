import { AgentState } from "../state";
import { coderModel, makeChatModel } from "../services/llm";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import puppeteer from "puppeteer";
import * as path from "path";
import * as fs from "fs/promises";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

  // Usa la VERA richiesta dell'utente (ultimo messaggio umano), NON la decisione del supervisor
  // (che è l'ultimo messaggio dopo il routing). E ricostruisci un breve storico per capire
  // le correzioni iterative ("togli il testo in mezzo", "cambia colore", ecc.).
  const humanMsgs = state.messages.filter((m) => m instanceof HumanMessage);
  const userRequest = (humanMsgs.length
    ? (humanMsgs[humanMsgs.length - 1].content as string)
    : (state.messages[state.messages.length - 1].content as string)) || "";

  // Tieni TUTTI i messaggi dell'utente (portano i dati: cliente, prodotti, prezzi…) + gli ultimi
  // scambi per contesto. Così su un thread lungo i dati del documento NON escono dalla finestra
  // (era il bug per cui, rigenerando, si inventava prodotti nuovi tipo "PC + monitor").
  const convMsgs = state.messages.filter((m) => m instanceof HumanMessage || m instanceof AIMessage);
  const convo = convMsgs
    .filter((m, i) => m instanceof HumanMessage || i >= convMsgs.length - 6)
    .map((m) => `${m instanceof HumanMessage ? "UTENTE" : "AGENTE"}: ${String(m.content).slice(0, 500)}`)
    .join("\n");

  // È una revisione di un documento già generato in questa conversazione?
  const isRevision = state.messages.some(
    (m) => typeof m.content === "string" && (m.content as string).startsWith("PDF generato:")
  );

  // === CARTA INTESTATA SALVATA (riusabile) ===
  const uid = (u as any).id;
  const userDir = uid
    ? path.resolve(process.cwd(), "shared_data", String(uid))
    : path.resolve(process.cwd(), "shared_data");
  const savedLetterhead: string | undefined = (u as any).letterheadHtml || undefined;

  // L'utente vuole SALVARE la carta intestata appena vista come modello ufficiale?
  const wantsSave =
    /\b(salva(la|lo)?|memorizza|conserva|imposta come (modello|predefinit|ufficiale)|usa (sempre|d'ora in poi))\b/i.test(userRequest) &&
    /(carta intestata|intestazione|modello|template|quest|quell|cos[ìi]|sempre)/i.test(userRequest);

  if (wantsSave) {
    // Trova l'HTML dell'ULTIMO documento generato (di norma la carta intestata appena fatta)
    let srcName: string | null = null;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const c = state.messages[i].content;
      if (typeof c === "string") {
        const m = c.match(/HTML:\s*([^\s|]+\.html)/);
        if (m) { srcName = m[1]; break; }
      }
    }
    let htmlToSave: string | null = null;
    try {
      if (srcName) {
        htmlToSave = await fs.readFile(path.join(userDir, srcName), "utf8");
      } else {
        // fallback: il file .html più recente nella cartella utente (preferendo le carte intestate)
        const files = await fs.readdir(userDir).catch(() => [] as string[]);
        const htmls = files.filter((f) => f.endsWith(".html"));
        if (htmls.length) {
          const stats = await Promise.all(
            htmls.map(async (f) => ({ f, t: (await fs.stat(path.join(userDir, f))).mtimeMs }))
          );
          stats.sort((a, b) => {
            const ai = a.f.includes("carta-intestata") ? 1 : 0;
            const bi = b.f.includes("carta-intestata") ? 1 : 0;
            if (ai !== bi) return bi - ai;
            return b.t - a.t;
          });
          htmlToSave = await fs.readFile(path.join(userDir, stats[0].f), "utf8");
        }
      }
    } catch { /* ignore */ }

    if (htmlToSave && uid) {
      await prisma.user
        .update({ where: { id: String(uid) }, data: { letterheadHtml: htmlToSave, letterheadSavedAt: new Date() } })
        .catch((e) => console.error("save letterhead", e));
      return {
        messages: [new SystemMessage("Carta intestata salvata come modello ufficiale")],
        finalResult:
          "Fatto! ✅ Ho salvato questa carta intestata come la tua **ufficiale**. Da ora la userò automaticamente per tutti i documenti (preventivi, fatture, lettere…): stesso logo, colori e impaginazione — cambierò solo il contenuto.\n\nQuando vorrai cambiarla, generane una nuova e dimmi di nuovo «salvala». Se per un documento vuoi un'altra grafica, basta dirmi «con un design diverso».",
      };
    }
    return {
      messages: [new SystemMessage("Nessuna carta intestata da salvare")],
      finalResult:
        "Per salvarla devo prima averne generata una. Dimmi «fammi una carta intestata»; quando quella che vedi ti piace scrivi «salvala» e la imposto come modello ufficiale per tutti i tuoi documenti.",
    };
  }

  // Se l'utente ha una carta intestata salvata, RIUSALA — a meno che chieda esplicitamente un design nuovo/diverso
  const wantsFreshDesign =
    /\b(nuova|nuovo|divers|altr[ao]|da zero|cambia (stile|grafica|design|colori|logo)|ridisegn|rifai (la grafica|il design|lo stile))\b/i.test(userRequest);
  const useSaved = !!savedLetterhead && !wantsFreshDesign;

  const scratchPrompt = `Sei un designer UI/UX esperto in documenti aziendali. Genera un documento HTML/CSS completo, impaginato in formato A4, con grafica PROFESSIONALE e MODERNA.

=== DATI AZIENDALI DA INTEGRARE ===
${companyInfo}

=== RICHIESTA ATTUALE DELL'UTENTE (è la cosa da soddisfare ORA) ===
${userRequest}
${convo ? `\n=== CONVERSAZIONE (leggila TUTTA: contiene i dati del documento e le correzioni) ===\n${convo}\n\n⚠️ REGOLE PER LE REVISIONI (fondamentali):\n- I DATI del documento (cliente, indirizzo, prodotti, quantità, prezzi, intestazione) sono quelli che l'utente ha indicato nei suoi messaggi qui sopra: USA SEMPRE QUELLI.\n- Se l'utente chiede solo di correggere/sistemare (es. "rimedia", "fai stare in una pagina", "cambia colore", "aggiungi le caratteristiche"), MANTIENI identici cliente, prodotti, quantità e prezzi: cambia SOLO ciò che ha chiesto. NON sostituire i prodotti con altri e NON inventare nuovi articoli (es. PC, monitor) che l'utente non ha mai citato.\n- Se l'utente ha chiesto di TOGLIERE o CAMBIARE qualcosa, NON rimetterlo. Il documento deve riflettere l'ULTIMA volontà dell'utente, partendo dai dati reali della conversazione.\n` : ""}

=== REGOLE DI DESIGN OBBLIGATORIE ===

1. STRUTTURA HTML
   - Documento completo: <!DOCTYPE html><html lang="it"><head>...</head><body>...</body></html>
   - Charset UTF-8, viewport per A4
   - TUTTO il CSS deve stare in UN SOLO blocco <style> dentro <head>. Mai CSS nel <body>.
   - ZERO dipendenze esterne: NON usare @import, NON usare <link> a font o fogli di stile esterni.
     ⚠️ VIETATO scrivere righe @import url(...): comparirebbero come testo nel PDF. Usa SOLO il font di sistema.

2. TIPOGRAFIA
   - Font principale (font di sistema, nessun download): font-family: 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif;
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

9. CONTENUTO — ⚠️ NON INVENTARE NULLA (regola fondamentale)
   - Usa ESCLUSIVAMENTE i dati realmente forniti dall'utente (cliente, indirizzo, prodotto, quantità, prezzo).
   - VIETATO inventare: nomi clienti, indirizzi, prezzi, P.IVA, codici, numeri di telefono, quantità,
     date di consegna, sconti, statistiche o numeri di qualsiasi tipo non forniti dall'utente.
   - Se un dato NON è stato fornito, lascia il campo vuoto, scrivi un trattino "—", oppure ometti la riga.
     MAI riempire un campo "a caso" pur di completarlo.
   - CARATTERISTICHE/SPECIFICHE DI UN PRODOTTO: includile SOLO se (a) le ha fornite l'utente, oppure
     (b) sono informazioni di pubblico dominio di cui sei assolutamente certo. In caso di dubbio NON
     inventare numeri tecnici (memoria, batteria, fotocamera, dimensioni, peso, ecc.): è molto meglio una
     descrizione generale e CORRETTA che specifiche precise ma INVENTATE. Mai spacciare per certe specifiche
     di cui non sei sicuro: un preventivo con dati falsi è un danno serio per chi lo manda a un cliente.
   - Per preventivi/fatture: righe prodotto con descrizione, quantità, prezzo unitario, riepilogo IVA, totale finale — usando SOLO i dati dati.
   - Per report: includi sezioni chiare e raccomandazioni, ma SENZA inventare statistiche o numeri.
   - Testo in italiano, valuta Euro (€), formato date italiano (GG/MM/AAAA)
   - Numero documento: usa formato anno+sequenza con anno corrente (es. PRV-${annoCorrente}-001)
   - VIETATO usare immagini in base64.
   - FOTO PRODOTTO: se la richiesta include una foto o immagine del prodotto, usa URL pubblici REALI
     del sito del produttore (es. https://www.lenovo.com, https://www.hp.com, https://www.dell.com,
     https://images.unsplash.com per foto generiche). Usa <img src="URL" style="max-width:260px; max-height:180px; object-fit:contain; display:block; margin:0 auto;">
     Puppeteer caricherà l'immagine automaticamente durante la conversione in PDF.

10. CASO "CARTA INTESTATA" (se l'utente chiede una carta intestata / letterhead / foglio intestato)
   NON è una fattura e NON è una lettera: è un FOGLIO BRANDIZZATO VUOTO, pronto perché l'utente ci scriva
   sopra. La struttura è SOLO due elementi: intestazione in CIMA e piè di pagina in FONDO. In mezzo NIENTE.
   - HEADER raffinato in alto: logo a sinistra, a destra nome azienda (grande, colore primario),
     sotto in piccolo P.IVA, indirizzo completo, telefono, email, sito — ben allineati.
   - Una sottile linea/banda colorata (accento) sotto l'header come separatore.
   - CORPO: COMPLETAMENTE VUOTO. ⚠️ VIETATO inserire QUALSIASI cosa nel corpo della pagina:
     NIENTE "Spett.le", NIENTE "Oggetto", NIENTE date, NIENTE "Luogo, data", NIENTE righe o testo
     segnaposto, NIENTE testo fac-simile, NIENTE contenuti di esempio. Solo grande spazio bianco.
   - Usa il layout per "spingere" il footer in fondo alla pagina A4 (es. body flex column, min-height
     piena pagina, header in alto, un div centrale che cresce (flex:1) e resta vuoto, footer in basso).
   - FOOTER elegante in fondo alla pagina: banda/linea col colore primario con i dati azienda ripetuti
     in piccolo (azienda · P.IVA · indirizzo · tel · email · sito) centrati.
   - Massima pulizia. Deve sembrare la carta intestata di uno studio professionale: solo testata e piede,
     centro vuoto. Se l'utente chiede esplicitamente di togliere/cambiare elementi, RISPETTALO alla lettera.

RITORNA SOLO IL CODICE HTML COMPLETO. Nessun blocco markdown \`\`\`html, zero testo prima o dopo.
Il tuo output viene salvato direttamente come file .html e renderizzato in PDF.`;

  // Prompt di RIUSO: l'utente ha già la sua carta intestata ufficiale → mantienila identica, cambia solo il corpo
  const reusePrompt = `Sei un assistente che impagina documenti aziendali. L'utente ha GIÀ la sua carta intestata UFFICIALE (logo, intestazione, piè di pagina, colori, font): devi RIUSARLA esattamente, cambiando SOLO il contenuto del corpo.

=== CARTA INTESTATA UFFICIALE (riusa header e footer IDENTICI) ===
${savedLetterhead}

=== COSA METTERE NEL CORPO (l'area centrale tra header e footer) ===
${userRequest}
${convo ? `\n=== CONVERSAZIONE (dati reali del documento) ===\n${convo}\n` : ""}

=== REGOLE ===
- Parti dall'HTML della carta intestata qui sopra. Mantieni IDENTICI logo, intestazione, piè di pagina, colori, font e struttura. NON ridisegnare e NON cambiare i dati aziendali in header/footer.
- Riempi il CORPO con il contenuto richiesto (es. tabella prodotti di un preventivo/fattura, testo di una lettera), nello stesso stile e colori della carta intestata.
- ⚠️ NON INVENTARE NULLA: usa SOLO i dati realmente forniti (cliente, indirizzo, prodotti, quantità, prezzi). Se un dato manca, lascia vuoto o ometti la riga. Niente clienti, prezzi, P.IVA, specifiche o prodotti di fantasia.
- Specifiche di un prodotto: includile solo se fornite dall'utente o se ne sei assolutamente certo; in dubbio NON inventare numeri tecnici.
- IVA: se un prezzo è indicato senza specificare → è IVA inclusa (22%): imponibile = prezzo/1,22, IVA = prezzo − imponibile. Solo se l'utente scrive "+IVA"/"IVA esclusa"/"netto" → aggiungi l'IVA sopra. Indica sempre "IVA inclusa/esclusa".
- Se serve far stare tutto in una pagina, compatta margini e spaziature (NON rimpicciolire il logo).
- VIETATO @import e font esterni: usa i font già presenti nella carta intestata.

RITORNA SOLO L'HTML COMPLETO (<!DOCTYPE html>…</html>). Nessun markdown, nessun testo prima o dopo.`;

  const htmlPrompt = useSaved ? reusePrompt : scratchPrompt;

  const messages = [
    new SystemMessage(htmlPrompt),
    new HumanMessage(userRequest),
  ];

  console.log("PDF Maker: Generazione template HTML professionale...");
  // Usa il modello del grado scelto dall'utente (più capace = layout migliore), fallback al coder base
  const model = state.chatModel ? makeChatModel(state.chatModel, 0.3) : coderModel;
  const response = await model.invoke(messages);

  let htmlCode = response.content as string;

  // Estrazione robusta dell'HTML
  const htmlMatch = htmlCode.match(/<!DOCTYPE[\s\S]*<\/html>/i) || htmlCode.match(/<html[\s\S]*<\/html>/i);
  if (htmlMatch) {
    htmlCode = htmlMatch[0];
  } else {
    const mdMatch = htmlCode.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (mdMatch) htmlCode = mdMatch[1].trim();
  }

  // SICUREZZA: rimuovi qualsiasi @import (a font/CSS esterni). A volte il modello lo lascia
  // come testo visibile nel documento o spezzato su due righe → comparirebbe nel PDF.
  // Usiamo font di sistema, quindi è sempre sicuro eliminarli.
  htmlCode = htmlCode.replace(/@import[^;]*;/gi, "");

  // Sostituisce il placeholder con il logo reale (base64 o URL)
  // In questo modo il prompt LLM non viene ingolfato con dati enormi
  htmlCode = htmlCode.replace(new RegExp(LOGO_PLACEHOLDER, 'g'), logoHtml);

  // IMPORTANTE: salva nella cartella ISOLATA dell'utente (shared_data/<userId>),
  // la stessa da cui /api/files serve i download. Altrimenti il file non è scaricabile.
  const userId = (u as any).id;
  const sharedDataDir = userId
    ? path.resolve(process.cwd(), "shared_data", String(userId))
    : path.resolve(process.cwd(), "shared_data");
  await fs.mkdir(sharedDataDir, { recursive: true }).catch(() => {});

  const uniqueId = crypto.randomBytes(4).toString("hex");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // Rileva il tipo di documento per il nome file
  const req = userRequest.toLowerCase();
  let docType = "documento";
  if (req.includes("intestata") || req.includes("letterhead")) docType = "carta-intestata";
  else if (req.includes("preventiv")) docType = "preventivo";
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

    // Misura l'altezza reale del contenuto per CONOSCERE il numero di pagine (niente più "indovinare")
    const A4_PX = 1123; // altezza A4 a 96dpi
    const contentH: number = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => A4_PX);
    let pages = Math.max(1, Math.ceil(contentH / A4_PX));

    // Se l'utente ha chiesto UNA pagina e ne servirebbero di più, riduci in scala per farcele stare
    const wantsOnePage = /(?:una|1)\s*(?:sola\s*)?pagina|in\s*un[a']?\s*pagina|tutto\s+in\s+una|in\s+un\s+foglio|single\s*page|stare?\s+in\s+una/i.test(`${userRequest}\n${convo}`);
    let pdfScale = 1;
    if (wantsOnePage && pages > 1) {
      pdfScale = Math.max(0.5, Math.min(1, (A4_PX - 6) / contentH));
      pages = 1; // dopo la riduzione sta in una pagina
    }

    await page.pdf({
      path: pdfFilePath,
      format: 'A4',
      printBackground: true,
      scale: pdfScale,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    await browser.close();
    console.log(`PDF Maker: PDF generato (${pages} pag., scala ${pdfScale.toFixed(2)}) → ${pdfFileName}`);

    const pagesTxt = pages === 1 ? "1 pagina" : `${pages} pagine`;
    const apertura = isRevision
      ? `Ho aggiornato il documento con le modifiche che mi hai chiesto 👇`
      : `Ecco il documento in PDF, pronto da scaricare 👇`;
    const chiusura = isRevision
      ? `Va bene così? Se c'è ancora qualcosa da sistemare dimmelo e lo correggo.`
      : `Se vuoi cambiare qualcosa (colori, logo, impaginazione) dimmelo e lo rifaccio.`;
    // Il numero di pagine REALE finisce nel messaggio (e quindi nello storico): così se poi chiedi
    // "quante pagine sono?" la risposta è basata sul dato vero, non inventata.
    const finalMsg = `${apertura}\n\n[File Generato: ${pdfFileName}]\n\nIl documento è di ${pagesTxt}. ${chiusura}`;

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

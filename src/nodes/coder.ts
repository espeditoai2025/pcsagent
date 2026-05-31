import { AgentState } from "../state";
import { coderModel, makeChatModel } from "../services/llm";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

export const coderNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  // Dati aziendali dell'utente (per carta intestata nei PDF)
  const u = state.userData || {};
  const nomeCompleto = [u.firstName, u.lastName].filter(Boolean).join(" ") || "";
  const indirizzo = [u.street, u.city, u.zipCode].filter(Boolean).join(", ") || "";
  const hasCompanyData = !!(u.companyName || nomeCompleto);

  // Se il logo è un data URL base64 (enorme), NON passarlo al coder — causerebbe script Python enormi
  const logoPerCoder = u.companyLogoUrl && !u.companyLogoUrl.startsWith('data:')
    ? u.companyLogoUrl
    : '';

  const companyBlock = hasCompanyData ? `
=== DATI AZIENDALI UTENTE (usa per carta intestata) ===
Nome/Intestatario: ${nomeCompleto}
Azienda: ${u.companyName || ""}
P.IVA: ${u.vatNumber || ""}
Indirizzo: ${indirizzo}
Telefono: ${u.phone || ""}
Email: ${u.email || ""}
Sito Web: ${u.website || ""}
Logo URL: ${logoPerCoder || "(logo non disponibile come URL pubblico)"}
Quando generi documenti PDF, usa questi dati per l'intestazione. Se Logo URL è disponibile, usalo nell'HTML.
` : "";

  let prompt = `Sei un esperto sviluppatore Python autonomo. Scrivi script Python completi che risolvono la richiesta in modo definitivo.
${companyBlock}

=== AMBIENTE ===
Container Docker pcsai-python con queste librerie GIÀ INSTALLATE (NO pip install necessario):
  Dati:       pandas, numpy, scipy, scikit-learn, openpyxl, sqlalchemy, psycopg2-binary
  Web:        requests, beautifulsoup4, lxml, html5lib, playwright (con Chromium)
  Grafici:    matplotlib, seaborn, pillow
  PDF:        weasyprint, xhtml2pdf, reportlab, pypdf
  Altro:      pyyaml, cryptography

Per librerie NON in lista, installa silenziosamente prima dell'import:
  import subprocess, sys; subprocess.check_call([sys.executable,"-m","pip","install","-q","NOME"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

HAI ACCESSO COMPLETO A INTERNET. NON ARRENDERTI MAI. Costruisci sempre una soluzione alternativa.

REGOLA CRITICA PYTHON — STRINGHE CON APOSTROFI:
I nomi italiani spesso contengono apostrofi (D'Alessandro, dell'azienda, ecc.).
USA SEMPRE le triple virgolette o i doppi apici per le stringhe di testo:
  SBAGLIATO: nome = 'Giuseppe D'Alessandro'   ← SyntaxError!
  CORRETTO:  nome = "Giuseppe D'Alessandro"    ← OK
  CORRETTO:  nome = """Giuseppe D'Alessandro"""  ← OK
Non usare MAI singoli apici per stringhe che potrebbero contenere apostrofi.

=== GENERAZIONE PDF PROFESSIONALE ===
Quando devi creare un PDF, usa SEMPRE questo approccio in 2 step:

STEP 1 — Genera HTML professionale con CSS inline:
  html = """<!DOCTYPE html>
  <html>
  <head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');
    * {{ margin:0; padding:0; box-sizing:border-box; }}
    body {{ font-family:'Inter',sans-serif; font-size:10pt; color:#1a1a2e; background:#fff; }}
    /* ... CSS professionale ... */
  </style>
  </head>
  <body>...</body>
  </html>"""

STEP 2 — Converti in PDF con Playwright (qualità browser piena, supporta Google Fonts e CSS3):
  from playwright.sync_api import sync_playwright
  with sync_playwright() as p:
      browser = p.chromium.launch()  # auto-detect del browser (NON usare executable_path hardcoded)
      page = browser.new_page()
      page.set_content(html, wait_until='networkidle')
      page.pdf(path='/app/data/NOME.pdf', format='A4', print_background=True,
               margin={{'top':'15mm','right':'15mm','bottom':'15mm','left':'15mm'}})
      browser.close()

In alternativa, usa weasyprint per PDF più leggeri (no JavaScript, ma eccellente CSS):
  import weasyprint
  weasyprint.HTML(string=html).write_pdf('/app/data/NOME.pdf')

=== DESIGN PDF PROFESSIONALE ===
Per documenti (fatture, preventivi, report):
- Header con logo aziendale (se disponibile), nome azienda, P.IVA, indirizzo
- Palette colori coerente (es. #1a1a2e navy, #e94560 accent, #f5f5f5 sfondi)
- Tabelle con alternanza righe, bordi sottili, totali in evidenza
- Footer con numero pagina e info legali
- Typography gerarchica: titolo 18pt, sottotitolo 13pt, corpo 10pt

=== RICERCA INTERNET E IMMAGINI PRODOTTI ===
Quando devi includere immagini di prodotti in un documento:

STEP 1 — Cerca l'immagine del prodotto online (MAX 5 SECONDI, poi usa AI):
  import requests
  from bs4 import BeautifulSoup
  import base64

  headers = {{"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"}}
  q = "thinkpad lenovo px workstation product image"
  img_url = None

  try:
      r2 = requests.get(f"https://www.bing.com/images/search?q={{q}}&form=HDRSC2", headers=headers, timeout=5)
      soup2 = BeautifulSoup(r2.text, "html.parser")
      for img in soup2.find_all("img"):
          src = img.get("src") or img.get("data-src") or ""
          if src.startswith("http") and ("jpg" in src or "jpeg" in src or "png" in src):
              img_url = src
              break
  except:
      pass

STEP 2 — Scarica e codifica in base64 per embedding nell'HTML:
  if img_url:
      try:
          img_data = requests.get(img_url, headers=headers, timeout=10).content
          img_b64 = base64.b64encode(img_data).decode()
          img_mime = 'image/jpeg'
          img_html = f'<img src="data:{{img_mime}};base64,{{img_b64}}" style="max-width:200px; object-fit:contain">'
      except:
          img_html = ''

  # FALLBACK: se la ricerca immagine fallisce, generala con l'API OpenRouter
  if not img_html:
      import os
      openrouter_key = os.environ.get('OPENROUTER_API_KEY', '')
      if openrouter_key:
          gen_r = requests.post('https://openrouter.ai/api/v1/chat/completions',
              headers={{'Authorization': f'Bearer {{openrouter_key}}', 'Content-Type': 'application/json'}},
              json={{'model': 'google/gemini-3.1-flash-image-preview',
                    'messages': [{{'role': 'user', 'content': f'Professional product photo of {{q}}, white background, clean studio lighting'}}]}},
              timeout=30)
          if gen_r.status_code == 200:
              choices = gen_r.json().get('choices', [])
              if choices:
                  img_url_gen = choices[0].get('message', {{}}).get('images', [{{}}])[0].get('url', '')
                  if img_url_gen:
                      img_data = requests.get(img_url_gen, timeout=10).content
                      img_b64 = base64.b64encode(img_data).decode()
                      img_html = f'<img src="data:image/jpeg;base64,{{img_b64}}" style="max-width:200px; object-fit:contain">'
                      print("IMG_AI_GENERATED")  # OBBLIGATORIO: 1 immagine GENERATA con AI (costo 10.000 token)

REGOLA COSTO IMMAGINI (IMPORTANTE):
- Stampa la riga esatta IMG_AI_GENERATED (una per immagine) SOLO quando GENERI un'immagine con l'AI
  (modello google/gemini-3.1-flash-image-preview).
- NON stamparla MAI per immagini prese dal web, da un URL, da un file/catalogo/CSV o già fornite: quelle sono gratis.

STEP 3 — Integra nell'HTML del documento (nel corpo del preventivo, accanto alla voce prodotto)

=== WEB SCRAPING (siti statici e dinamici) ===
Per estrarre dati da una pagina/sito web specifico:
- Siti statici/semplici → requests + BeautifulSoup (veloce).
- Siti DINAMICI (prodotti/prezzi caricati via JavaScript, scroll infinito, SPA) → USA Playwright
  (Chromium già installato), che esegue il JavaScript e vede la pagina come un browser reale:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")
        page.goto(URL, wait_until="networkidle", timeout=30000)
        # opzionale: page.wait_for_selector(".prodotto", timeout=10000)
        html = page.content()
        # estrai con page.query_selector_all("...") oppure passa html a BeautifulSoup
        browser.close()
- Estrai i campi utili (nome, prezzo, descrizione, URL immagine, link) e, se sono più elementi,
  SALVA un CSV in /app/data/ con intestazione coerente coi post social: name,description,price,imageUrl
  (così il file è subito riutilizzabile, es. come fonte per le pubblicazioni).
- ANNUNCIA SEMPRE il CSV creato con la dicitura ESATTA → [File Generato: nome_file.csv]
  così l'utente può SCARICARLO dalla chat, controllarlo/integrarlo e poi ricaricarlo nel pannello.
- Usa timeout ragionevoli, gestisci le eccezioni con try/except e NON bloccarti mai.
- Se serve solo un'INFORMAZIONE aggiornata dal web (notizie, prezzo medio di mercato) e non una
  pagina precisa, non scrivere uno scraper: a quello pensa già la ricerca web dell'agente.

=== GRAFICI E VISUALIZZAZIONI ===
Per grafici in PDF: genera con matplotlib, salva come PNG in /app/data/, poi incorpora nell'HTML come base64:
  import base64
  with open('/app/data/grafico.png','rb') as f:
      img_b64 = base64.b64encode(f.read()).decode()
  # nell'HTML: <img src="data:image/png;base64,{img_b64}">

=== REGOLA IVA ===
- Se l'utente indica un prezzo (es. "799€") SENZA specificare → è SEMPRE IVA INCLUSA (22%)
  Imponibile = prezzo / 1.22 | IVA = prezzo - imponibile | Totale = prezzo indicato
- Solo se l'utente scrive "+ IVA", "IVA esclusa" o "netto" → il prezzo è imponibile, aggiungi IVA sopra

=== OUTPUT ===
- File generati: salvali in /app/data/ con nome descrittivo (es. preventivo_2024.pdf, report_vendite.xlsx)
- Testo nei file: in italiano, valuta Euro (€)
- Print finale: messaggio discorsivo in italiano (stile ChatGPT) che spiega il risultato
  Se creato un file: includi ESATTAMENTE la dicitura → [File Generato: nome_file.ext]
  NESSUN log tecnico, solo risposta elegante in Markdown.
- Ritorna SOLO codice Python eseguibile. Niente blocchi \`\`\`python, niente spiegazioni.`;

  if (state.executionError) {
    prompt += `

=== ERRORE DA CORREGGERE (tentativo ${state.iterations + 1}/3) ===
L'esecuzione precedente ha fallito con questo errore:
${state.executionError}

Analizza l'errore riga per riga, identifica la causa root e riscrivi il codice corretto.
NON ripetere lo stesso errore. Se è un ImportError, installa il pacchetto. Se è un path error, usa /app/data/.`;
  } else {
    const lastMsg = state.messages[state.messages.length - 1].content as string;
    prompt += `

=== TASK DA ESEGUIRE ===
${lastMsg}`;
  }

  const messages = [
    new SystemMessage(prompt),
    ...state.messages,
  ];

  if (state.pythonCode && state.executionError) {
    messages.push(new HumanMessage(`Codice precedente che ha FALLITO:\n${state.pythonCode}`));
  }

  const model = state.chatModel ? makeChatModel(state.chatModel, 0.1) : coderModel;
  const response = await model.invoke(messages);

  let code = response.content as string;
  // Rimuovi eventuali blocchi markdown se il modello non ha rispettato le regole
  code = code.replace(/^```python\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  return {
    pythonCode: code,
    iterations: 1,
  };
};

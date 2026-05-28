import { AgentState } from "../state";
import { coderModel } from "../services/llm";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

export const coderNode = async (state: AgentState): Promise<Partial<AgentState>> => {
  // Dati aziendali dell'utente (per carta intestata nei PDF)
  const u = state.userData || {};
  const nomeCompleto = [u.firstName, u.lastName].filter(Boolean).join(" ") || "";
  const indirizzo = [u.street, u.city, u.zipCode].filter(Boolean).join(", ") || "";
  const hasCompanyData = !!(u.companyName || nomeCompleto);

  const companyBlock = hasCompanyData ? `
=== DATI AZIENDALI UTENTE (usa per carta intestata) ===
Nome/Intestatario: ${nomeCompleto}
Azienda: ${u.companyName || ""}
P.IVA: ${u.vatNumber || ""}
Indirizzo: ${indirizzo}
Telefono: ${u.phone || ""}
Email: ${u.email || ""}
Sito Web: ${u.website || ""}
Logo URL: ${u.companyLogoUrl || ""}
Quando generi documenti PDF (fatture, preventivi, report), usa questi dati per l'intestazione professionale.
Se è disponibile il Logo URL, incorporalo nell'HTML come: <img src="LOGO_URL" style="height:55px; object-fit:contain">
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
      browser = p.chromium.launch(executable_path='/ms-playwright/chromium-1223/chrome-linux64/chrome')
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

STEP 1 — Cerca l'immagine del prodotto online:
  import requests
  from bs4 import BeautifulSoup
  import base64

  # Cerca su DuckDuckGo Images (no API key)
  headers = {{'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'}}
  q = 'iphone 16 128gb product image'
  url = f'https://duckduckgo.com/?q={{q}}&iax=images&ia=images'
  r = requests.get(url, headers=headers, timeout=10)
  soup = BeautifulSoup(r.text, 'html.parser')
  img_tag = soup.find('img', class_='tile--img__img')
  img_url = img_tag['src'] if img_tag else None

  # Oppure cerca su Bing Images:
  r2 = requests.get(f'https://www.bing.com/images/search?q={{q}}&form=HDRSC2', headers=headers, timeout=10)
  soup2 = BeautifulSoup(r2.text, 'html.parser')
  imgs = soup2.find_all('img', class_='mimg')
  img_url = imgs[0]['src'] if imgs else None

STEP 2 — Scarica e codifica in base64 per embedding nell'HTML:
  if img_url:
      img_data = requests.get(img_url, headers=headers, timeout=10).content
      img_b64 = base64.b64encode(img_data).decode()
      img_mime = 'image/jpeg'
      img_html = f'<img src="data:{{img_mime}};base64,{{img_b64}}" style="max-width:200px; object-fit:contain">'
  else:
      img_html = ''  # fallback: nessuna immagine

STEP 3 — Integra nell'HTML del documento (nel corpo del preventivo, accanto alla voce prodotto)

=== GRAFICI E VISUALIZZAZIONI ===
Per grafici in PDF: genera con matplotlib, salva come PNG in /app/data/, poi incorpora nell'HTML come base64:
  import base64
  with open('/app/data/grafico.png','rb') as f:
      img_b64 = base64.b64encode(f.read()).decode()
  # nell'HTML: <img src="data:image/png;base64,{img_b64}">

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

  const response = await coderModel.invoke(messages);

  let code = response.content as string;
  // Rimuovi eventuali blocchi markdown se il modello non ha rispettato le regole
  code = code.replace(/^```python\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  return {
    pythonCode: code,
    iterations: 1,
  };
};

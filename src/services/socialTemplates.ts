/**
 * Template Python COLLAUDATO per la pubblicazione automatica su Facebook.
 * E uno script statico: tutta la configurazione (token, fonte, riga, caption)
 * arriva da variabili d'ambiente iniettate a runtime nel container Docker.
 * Non viene rigenerato dall'LLM ad ogni esecuzione -> comportamento deterministico.
 *
 * ENV attese:
 *   FB_PAGE_ID, FB_ACCESS_TOKEN
 *   SOURCE_TYPE   = GOOGLE_SHEET | EXCEL | CSV | TEXT
 *   SOURCE_REF    = URL del foglio Google | filename .csv/.xlsx in /app/data (non serve per TEXT)
 *   ROW_INDEX     = indice riga da pubblicare (verra applicato il modulo sul totale righe)
 *   CAPTION_TEMPLATE = template caption con segnaposto {colonna}; in modalita TEXT e il testo del post
 *   AI_CAPTION    = "true" per generare la caption con l'AI (post che vende)
 *   OPENROUTER_API_KEY = chiave per la generazione AI della caption
 *   COMPANY_NAME  = nome azienda dell'utente (per firmare il post) — GENERICO, dal profilo
 *   AI_TONE       = descrizione del tono (es. "simpatico e commerciale")
 */
export const FACEBOOK_POST_SCRIPT = String.raw`
import os, re, sys, json
import pandas as pd
import requests

GRAPH = "https://graph.facebook.com/v21.0"

page_id = os.environ.get("FB_PAGE_ID", "").strip()
token = os.environ.get("FB_ACCESS_TOKEN", "").strip()
source_type = os.environ.get("SOURCE_TYPE", "GOOGLE_SHEET").strip().upper()
source_ref = os.environ.get("SOURCE_REF", "").strip()
row_index = int(os.environ.get("ROW_INDEX", "0") or "0")
caption_template = os.environ.get("CAPTION_TEMPLATE", "").strip()
ai_caption = os.environ.get("AI_CAPTION", "").strip().lower() == "true"
openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
company_name = os.environ.get("COMPANY_NAME", "").strip()
ai_tone = os.environ.get("AI_TONE", "").strip() or "simpatico e commerciale, con emoji"

if not page_id or not token:
    print("ERRORE: credenziali Facebook mancanti (FB_PAGE_ID / FB_ACCESS_TOKEN).")
    sys.exit(1)

# Risolvi il PAGE access token: per pubblicare COME pagina serve il token della
# pagina, non un token utente. Se 'token' e' un user-token che gestisce la pagina,
# /{page_id}?fields=access_token restituisce il page-token. Funziona anche se 'token'
# e' gia un page-token. In caso di errore si prosegue col token fornito.
post_token = token
try:
    _r = requests.get(f"{GRAPH}/{page_id}", params={"fields": "access_token", "access_token": token}, timeout=30)
    _j = _r.json()
    if _r.status_code == 200 and _j.get("access_token"):
        post_token = _j["access_token"]
except Exception:
    pass

# --- Modalita TEXT: post di testo immediato (test), senza fonte dati ---
if source_type == "TEXT":
    caption = caption_template.strip() or "Post di test da PCS Agent: la connessione alla pagina Facebook funziona correttamente."
    try:
        resp = requests.post(f"{GRAPH}/{page_id}/feed",
                             data={"message": caption, "access_token": post_token}, timeout=60)
        body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"raw": resp.text}
        if resp.status_code == 200 and (body.get("id") or body.get("post_id")):
            print(f"POST_OK {body.get('post_id') or body.get('id')} | {caption[:80]}")
            sys.exit(0)
        print(f"ERRORE pubblicazione Facebook (HTTP {resp.status_code}): {json.dumps(body)[:500]}")
        sys.exit(1)
    except Exception as e:
        print(f"ERRORE chiamata Graph API: {e}")
        sys.exit(1)

if not source_ref:
    print("ERRORE: fonte dati non configurata (SOURCE_REF vuoto).")
    sys.exit(1)

def gsheet_to_csv(url):
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", url)
    if not m:
        return url  # gia un CSV o URL diretto
    sheet_id = m.group(1)
    gid_m = re.search(r"[#&?]gid=([0-9]+)", url)
    gid = gid_m.group(1) if gid_m else "0"
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"

# 1) Carica i dati (Google Sheet via URL, oppure file CSV/Excel caricato in /app/data)
try:
    if source_type == "GOOGLE_SHEET":
        df = pd.read_csv(gsheet_to_csv(source_ref))
    else:
        local = os.path.join("/app/data", source_ref)
        if source_type == "CSV" or source_ref.lower().endswith(".csv"):
            df = pd.read_csv(local)
        else:
            df = pd.read_excel(local)
except Exception as e:
    print(f"ERRORE caricamento fonte dati ({source_type}): {e}")
    sys.exit(1)

if df.empty:
    print("ERRORE: la fonte dati non contiene righe.")
    sys.exit(1)

# Normalizza i nomi colonna (lowercase, trim) mantenendo il mapping originale
df.columns = [str(c).strip() for c in df.columns]
norm = {str(c).strip().lower(): c for c in df.columns}

idx = row_index % len(df)
row = df.iloc[idx]

def get(*names):
    for n in names:
        c = norm.get(n)
        if c is not None:
            v = row.get(c)
            if pd.notna(v) and str(v).strip():
                return str(v).strip()
    return ""

# 2) Estrai i campi del prodotto (nomi colonna generici IT/EN)
nome = get("nome", "name", "prodotto", "titolo", "title")
descr = get("descrizione", "description", "desc")
categoria = get("categoria", "category", "reparto")
prezzo_promo = get("promoprice", "prezzopromo", "prezzo_promo", "prezzo", "price", "prezzovendita")
prezzo_pieno = get("originalprice", "prezzopieno", "prezzo_pieno", "prezzolistino", "listino")
image_url = get("image", "img", "immagine", "foto", "photo", "image_url", "imageurl", "url")

def _p(v):
    return v.replace("€", "").strip()

has_sconto = prezzo_pieno and prezzo_promo and _p(prezzo_pieno) != _p(prezzo_promo)

# 3) Caption: priorita AI -> template fisso -> default
caption = ""
if ai_caption and openrouter_key:
    azienda = company_name or "il nostro negozio"
    info = []
    if nome: info.append(f"Prodotto: {nome}")
    if categoria: info.append(f"Categoria: {categoria}")
    if descr: info.append(f"Descrizione: {descr}")
    if has_sconto:
        info.append(f"Prezzo pieno: {_p(prezzo_pieno)} euro, in offerta a {_p(prezzo_promo)} euro")
    elif prezzo_promo:
        info.append(f"Prezzo: {_p(prezzo_promo)} euro")
    prompt = (
        f"Sei il social media manager di {azienda}. Scrivi UN post Facebook breve (max 4 righe) "
        f"dal tono {ai_tone} per vendere questo prodotto. Evidenzia l'eventuale sconto, usa qualche "
        f"emoji pertinente e chiudi con una call-to-action verso {azienda}. NON inventare "
        f"caratteristiche non presenti. Rispondi SOLO col testo del post, senza virgolette.\n\n"
        + "\n".join(info)
    )
    try:
        air = requests.post("https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {openrouter_key}", "Content-Type": "application/json"},
            json={"model": "google/gemini-3.1-flash-lite", "temperature": 0.8,
                  "messages": [{"role": "user", "content": prompt}]}, timeout=45)
        if air.status_code == 200:
            caption = air.json()["choices"][0]["message"]["content"].strip().strip('"')
    except Exception as e:
        print(f"(AI caption fallita, uso fallback: {e})")

if not caption and caption_template:
    class _SafeDict(dict):
        def __missing__(self, k):
            return ""
    data = {str(k).strip().lower(): ("" if pd.isna(v) else str(v)) for k, v in row.items()}
    data.update({str(k): ("" if pd.isna(v) else str(v)) for k, v in row.items()})
    try:
        caption = caption_template.format_map(_SafeDict(data))
    except Exception:
        caption = caption_template

if not caption:
    parts = []
    if nome: parts.append(nome)
    if has_sconto:
        parts.append(f"da {_p(prezzo_pieno)}€ a soli {_p(prezzo_promo)}€")
    elif prezzo_promo:
        parts.append(f"a soli {_p(prezzo_promo)}€")
    if descr: parts.append(descr)
    caption = " — ".join([x for x in parts if x]) or "Nuovo prodotto disponibile!"

# 3) Pubblica
try:
    if image_url and image_url.lower().startswith("http"):
        resp = requests.post(f"{GRAPH}/{page_id}/photos",
                             data={"url": image_url, "caption": caption, "access_token": post_token},
                             timeout=60)
    else:
        resp = requests.post(f"{GRAPH}/{page_id}/feed",
                             data={"message": caption, "access_token": post_token},
                             timeout=60)
    body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"raw": resp.text}
    if resp.status_code == 200 and (body.get("id") or body.get("post_id")):
        post_id = body.get("post_id") or body.get("id")
        print(f"POST_OK {post_id} | riga {idx} | {caption[:80]}")
        sys.exit(0)
    else:
        print(f"ERRORE pubblicazione Facebook (HTTP {resp.status_code}): {json.dumps(body)[:500]}")
        sys.exit(1)
except Exception as e:
    print(f"ERRORE chiamata Graph API: {e}")
    sys.exit(1)
`;

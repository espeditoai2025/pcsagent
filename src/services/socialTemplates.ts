/**
 * Template Python COLLAUDATO per la pubblicazione automatica su Facebook.
 * Script statico: tutta la configurazione arriva da variabili d'ambiente iniettate
 * a runtime nel container Docker. Non rigenerato dall'LLM -> comportamento prevedibile.
 *
 * ENV attese:
 *   FB_PAGE_ID, FB_ACCESS_TOKEN
 *   SOURCE_TYPE   = GOOGLE_SHEET | EXCEL | CSV | TEXT
 *   SOURCE_REF    = URL foglio Google | filename .csv/.xlsx in /app/data (non serve per TEXT)
 *   ROW_INDEX     = indice riga di partenza (modulo sul totale)
 *   POSTS_PER_RUN = quanti prodotti pubblicare in questa esecuzione (default 1)
 *   SELECTION_MODE= SEQUENTIAL | RANDOM
 *   CAPTION_TEMPLATE = template con {colonna}; in TEXT e il testo del post
 *   AI_CAPTION    = "true" per generare la caption con l'AI
 *   OPENROUTER_API_KEY = chiave per la generazione AI
 *   AI_TONE       = tono (default "simpatico e commerciale")
 *   Branding (override del profilo, opzionali): BIZ_NAME, BIZ_ADDRESS, BIZ_WHATSAPP, BIZ_WEBSITE
 *   COMPANY_NAME  = nome azienda dal profilo (fallback se BIZ_NAME vuoto)
 */
export const FACEBOOK_POST_SCRIPT = String.raw`
import os, re, sys, json, random, base64
import pandas as pd
import requests

GRAPH = "https://graph.facebook.com/v21.0"

page_id = os.environ.get("FB_PAGE_ID", "").strip()
token = os.environ.get("FB_ACCESS_TOKEN", "").strip()
source_type = os.environ.get("SOURCE_TYPE", "GOOGLE_SHEET").strip().upper()
source_ref = os.environ.get("SOURCE_REF", "").strip()
row_index = int(os.environ.get("ROW_INDEX", "0") or "0")
posts_per_run = int(os.environ.get("POSTS_PER_RUN", "1") or "1")
selection_mode = os.environ.get("SELECTION_MODE", "SEQUENTIAL").strip().upper()
caption_template = os.environ.get("CAPTION_TEMPLATE", "").strip()
ai_caption = os.environ.get("AI_CAPTION", "").strip().lower() == "true"
openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
ai_model = os.environ.get("AI_MODEL", "").strip() or "google/gemini-3.1-flash-lite"
ai_tone = os.environ.get("AI_TONE", "").strip() or "simpatico e commerciale, con emoji"

biz_name = os.environ.get("BIZ_NAME", "").strip() or os.environ.get("COMPANY_NAME", "").strip() or "il nostro negozio"
biz_address = os.environ.get("BIZ_ADDRESS", "").strip()
biz_whatsapp = os.environ.get("BIZ_WHATSAPP", "").strip()
biz_website = os.environ.get("BIZ_WEBSITE", "").strip()

# Immagini: pool caricato dall'utente + generazione AI quando manca + anteprima
pool_files = [f.strip() for f in os.environ.get("POOL_FILES", "").split(",") if f.strip()]
pool_index = int(os.environ.get("POOL_INDEX", "0") or "0")
auto_image = os.environ.get("AUTO_IMAGE", "").strip().lower() == "true"
image_context = os.environ.get("IMAGE_CONTEXT", "").strip()
image_ai_model = os.environ.get("IMAGE_AI_MODEL", "").strip() or "google/gemini-3.1-flash-image-preview"
preview_mode = os.environ.get("PREVIEW", "").strip().lower() == "true"
few_site_images = os.environ.get("FEW_SITE_IMAGES", "").strip().lower() == "true"

USAGE = {"p": 0, "c": 0}  # token AI accumulati (per il conteggio crediti)

if not page_id or not token:
    print("ERRORE: credenziali Facebook mancanti (FB_PAGE_ID / FB_ACCESS_TOKEN).")
    sys.exit(1)

# Risolvi il PAGE access token (necessario per pubblicare come pagina)
post_token = token
try:
    _r = requests.get(f"{GRAPH}/{page_id}", params={"fields": "access_token", "access_token": token}, timeout=30)
    _j = _r.json()
    if _r.status_code == 200 and _j.get("access_token"):
        post_token = _j["access_token"]
except Exception:
    pass

def clean_fb_text(t):
    # Facebook NON interpreta il Markdown: i marcatori (** ~~ # backtick ecc.) verrebbero
    # mostrati come caratteri grezzi. Li rimuoviamo / convertiamo in testo semplice.
    if not t:
        return t
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t, flags=re.S)   # **grassetto** -> testo
    t = re.sub(r"__(.+?)__", r"\1", t, flags=re.S)        # __grassetto__ -> testo
    t = t.replace("**", "").replace("__", "")             # marcatori spaiati residui
    # ~~barrato~~ -> barrato VERO con caratteri Unicode combinanti (reso su Facebook)
    t = re.sub(r"~~(.+?)~~", lambda m: "".join(c + chr(0x336) for c in m.group(1)), t, flags=re.S)
    t = t.replace("~~", "")
    t = t.replace(chr(96), "")                            # rimuove i backtick (codice)
    t = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", t)           # titoli markdown a inizio riga
    t = re.sub(r"(?m)^\s{0,3}>\s?", "", t)                # citazioni >
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1", t)  # [testo](url) -> testo
    return t

def publish(message, image_url=None, image_file=None):
    message = clean_fb_text(message)
    # Facebook "collassa" le righe vuote nei post via API: inserisco un carattere
    # invisibile (Braille blank U+2800) sulle righe vuote per preservare la
    # spaziatura tra i paragrafi (cosi il post pubblicato corrisponde all'anteprima).
    message = re.sub(r"\n{2,}", "\n⠀\n", message)
    if image_file and os.path.exists(image_file):
        with open(image_file, "rb") as fh:
            r = requests.post(f"{GRAPH}/{page_id}/photos", data={"caption": message, "access_token": post_token}, files={"source": fh}, timeout=120)
    elif image_url and str(image_url).lower().startswith("http"):
        r = requests.post(f"{GRAPH}/{page_id}/photos", data={"url": image_url, "caption": message, "access_token": post_token}, timeout=60)
    else:
        r = requests.post(f"{GRAPH}/{page_id}/feed", data={"message": message, "access_token": post_token}, timeout=60)
    b = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text}
    if r.status_code == 200 and (b.get("id") or b.get("post_id")):
        return True, (b.get("post_id") or b.get("id"))
    return False, f"HTTP {r.status_code}: {json.dumps(b)[:300]}"

def _gen_ai_image(subject):
    # Genera un'immagine col modello AI, salva in /app/data, ritorna il path (o None).
    if not openrouter_key:
        return None
    try:
        pr = (f"Crea un'immagine professionale e accattivante per un post Facebook di {biz_name}. "
              f"Contesto dell'attivita: {image_context or biz_name}. Soggetto del post: {str(subject)[:300]}. "
              f"Stile pulito e moderno, colori coerenti col brand, adatta ai social, SENZA testo sovraimpresso.")
        r = requests.post("https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {openrouter_key}", "Content-Type": "application/json"},
            json={"model": image_ai_model, "messages": [{"role": "user", "content": pr}]}, timeout=90)
        if r.status_code != 200:
            return None
        msg = (r.json().get("choices") or [{}])[0].get("message", {}) or {}
        url = None
        for im in (msg.get("images") or []):
            url = (im.get("image_url") or {}).get("url") or im.get("url")
            if url:
                break
        if not url:
            return None
        if url.startswith("data:"):
            data = base64.b64decode(url.split(",", 1)[1])
        else:
            data = requests.get(url, timeout=60).content
        path = "/app/data/_aiimg_%d.jpg" % random.randint(1000, 9999999)
        with open(path, "wb") as f:
            f.write(data)
        print("IMG_AI_GENERATED")  # 10.000 token (addebito flat lato server)
        return path
    except Exception as e:
        print(f"(immagine AI fallita: {e})")
        return None

def _looks_logo(u):
    u = str(u or "").lower()
    return any(k in u for k in ("logo", "favicon", "icon", "sprite", "brand"))

def resolve_image(content_image_url, subject):
    # Se il sito ha POCHE immagini (es. solo la copertina) e l'AI è attiva: genera un'immagine
    # AI DIVERSA per ogni post (varietà) invece di ripetere sempre la stessa copertina.
    if auto_image and few_site_images:
        p = _gen_ai_image(subject)
        if p:
            return None, p
    # Cascata: 1) immagine del contenuto  2) pool caricato (rotazione)  3) AI se abilitato
    # REGOLA: niente loghi/icone come immagine del post (si sgranano su Facebook).
    if content_image_url and str(content_image_url).lower().startswith("http") and not _looks_logo(content_image_url):
        return content_image_url, None
    if pool_files:
        fn = pool_files[pool_index % len(pool_files)]
        p = os.path.join("/app/data", fn)
        if os.path.exists(p):
            return None, p
    if auto_image:
        p = _gen_ai_image(subject)
        if p:
            return None, p
    return None, None

def emit_preview(caption, image_url=None, image_file=None):
    # Anteprima: NON pubblica. Restituisce caption + riferimento immagine per il pannello.
    caption = clean_fb_text(caption)
    img = ""
    if image_url:
        img = image_url
    elif image_file and os.path.exists(image_file):
        img = "file:" + os.path.basename(image_file)  # il frontend lo serve via /api/files
    print("PREVIEW_JSON " + json.dumps({"caption": caption, "image": img}))

# --- Modalita TEXT: singolo post di testo (test) ---
if source_type == "TEXT":
    caption = caption_template.strip() or "Post di test da PCS Agent: la connessione alla pagina Facebook funziona correttamente."
    if preview_mode:
        emit_preview(caption)
        sys.exit(0)
    ok, msg = publish(caption)
    if ok:
        print(f"POST_OK {msg} | {caption[:80]}")
        sys.exit(0)
    print(f"ERRORE pubblicazione Facebook ({msg})")
    sys.exit(1)

# --- Modalita WEBSITE: genera un post NUOVO da un contenuto gia estratto dal sito ---
if source_type == "WEBSITE":
    web_title = os.environ.get("WEB_TITLE", "").strip()
    web_content = os.environ.get("WEB_CONTENT", "").strip()
    web_image = os.environ.get("WEB_IMAGE", "").strip()
    caption = ""
    if ai_caption and openrouter_key and web_content:
        prompt = (
            f"Sei il social media manager di {biz_name}. Scrivi un post Facebook ACCATTIVANTE e ORIGINALE "
            f"basato sul seguente contenuto del nostro sito. RIELABORALO con parole NUOVE (non copiarlo), "
            f"ogni volta in modo diverso. FORMATTAZIONE: testo ben spaziato su piu righe separate da una riga "
            f"vuota, qualche emoji, e una breve call-to-action finale.\n"
            f"TESTO SEMPLICE per Facebook: NON usare Markdown (niente **grassetto**, niente ~~barrato~~, niente #): "
            f"Facebook li mostra come simboli.\n"
            f"Tono: {ai_tone}. NON inventare dati o prezzi non presenti. NON scrivere indirizzo, telefono, "
            f"WhatsApp o sito (li aggiungo io sotto). Rispondi SOLO col testo del post, senza virgolette.\n\n"
            f"Titolo: {web_title}\nContenuto: {web_content[:1500]}"
        )
        try:
            air = requests.post("https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {openrouter_key}", "Content-Type": "application/json"},
                json={"model": ai_model, "temperature": 0.95, "messages": [{"role": "user", "content": prompt}]}, timeout=45)
            if air.status_code == 200:
                _aj = air.json()
                caption = _aj["choices"][0]["message"]["content"].strip().strip('"')
                _u = _aj.get("usage", {}) or {}
                USAGE["p"] += _u.get("prompt_tokens", 0) or 0
                USAGE["c"] += _u.get("completion_tokens", 0) or 0
        except Exception as e:
            print(f"(AI caption fallita, uso fallback: {e})")
    if not caption:
        caption = ((web_title + "\n\n") if web_title else "") + web_content[:300]
        caption = caption.strip() or "Scopri le nostre novita!"
    footer = []
    if biz_address: footer.append(f"📍 {biz_address}")
    if biz_whatsapp: footer.append(f"📲 {biz_whatsapp}")
    if biz_website: footer.append(f"🌐 {biz_website}")
    if footer:
        caption = caption.rstrip() + "\n\n" + "\n".join(footer)
    img_url, img_file = resolve_image(web_image, web_title or web_content)
    if preview_mode:
        emit_preview(caption, img_url, img_file)
        print(f"AI_USAGE {USAGE['p']} {USAGE['c']} {ai_model}")
        sys.exit(0)
    ok, msg = publish(caption, img_url, img_file)
    print(f"AI_USAGE {USAGE['p']} {USAGE['c']} {ai_model}")
    if ok:
        print(f"POST_OK web (id {msg}): {caption[:70]}")
        sys.exit(0)
    print(f"ERRORE pubblicazione Facebook ({msg})")
    sys.exit(1)

if not source_ref:
    print("ERRORE: fonte dati non configurata (SOURCE_REF vuoto).")
    sys.exit(1)

def gsheet_to_csv(url):
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", url)
    if not m:
        return url
    sheet_id = m.group(1)
    gid_m = re.search(r"[#&?]gid=([0-9]+)", url)
    gid = gid_m.group(1) if gid_m else "0"
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"

# 1) Carica i dati
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

n = len(df)
if n == 0:
    print("ERRORE: la fonte dati non contiene righe.")
    sys.exit(1)

df.columns = [str(c).strip() for c in df.columns]
norm = {str(c).strip().lower(): c for c in df.columns}

def get(row, *names):
    for nm in names:
        c = norm.get(nm)
        if c is not None:
            v = row.get(c)
            if pd.notna(v) and str(v).strip():
                return str(v).strip()
    return ""

def _p(v):
    return v.replace("€", "").strip()

# Blocco contatti reali (per la CTA, niente invenzioni)
contatti = []
if biz_address: contatti.append(f"Indirizzo: {biz_address}")
if biz_whatsapp: contatti.append(f"WhatsApp: {biz_whatsapp}")
if biz_website: contatti.append(f"Sito: {biz_website}")
contatti_str = " | ".join(contatti)

def build_caption(row):
    nome = get(row, "nome", "name", "prodotto", "titolo", "title")
    descr = get(row, "descrizione", "description", "desc")
    categoria = get(row, "categoria", "category", "reparto")
    promo = get(row, "promoprice", "prezzopromo", "prezzo_promo", "prezzo", "price", "prezzovendita")
    pieno = get(row, "originalprice", "prezzopieno", "prezzo_pieno", "prezzolistino", "listino")
    image_url = get(row, "image", "img", "immagine", "foto", "photo", "image_url", "imageurl", "url")
    has_sconto = pieno and promo and _p(pieno) != _p(promo)

    caption = ""
    if ai_caption and openrouter_key:
        info = []
        if nome: info.append(f"Prodotto: {nome}")
        if categoria: info.append(f"Categoria: {categoria}")
        if descr: info.append(f"Descrizione: {descr}")
        if has_sconto: info.append(f"Prezzo pieno: {_p(pieno)} euro, in offerta a {_p(promo)} euro")
        elif promo: info.append(f"Prezzo: {_p(promo)} euro")
        prompt = (
            f"Sei il social media manager di {biz_name}. Scrivi un post Facebook che vende questo prodotto.\n"
            f"FORMATTAZIONE IMPORTANTE: testo ben spaziato e leggibile, NON un unico blocco. Struttura su piu "
            f"sezioni separate da una RIGA VUOTA: 1) un gancio iniziale accattivante; 2) l'offerta col prezzo "
            f"(sconto in evidenza); 3) una breve call-to-action (es. 'Passa a trovarci!'). Usa qualche emoji.\n"
            f"TESTO SEMPLICE per Facebook: NON usare Markdown (niente **grassetto**, niente #, niente _corsivo_): "
            f"Facebook li mostra come simboli. UNICA eccezione: per il prezzo VECCHIO da barrare usa la sintassi "
            f"~~prezzo~~ (verra mostrato barrato).\n"
            f"Tono: {ai_tone}. NON inventare nulla. NON scrivere indirizzo, telefono, WhatsApp o sito web "
            f"(li aggiungo io sotto). Rispondi SOLO col testo del post, senza virgolette.\n\n"
            + "\n".join(info)
        )
        try:
            air = requests.post("https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {openrouter_key}", "Content-Type": "application/json"},
                json={"model": ai_model, "temperature": 0.8,
                      "messages": [{"role": "user", "content": prompt}]}, timeout=45)
            if air.status_code == 200:
                _aj = air.json()
                caption = _aj["choices"][0]["message"]["content"].strip().strip('"')
                _u = _aj.get("usage", {}) or {}
                USAGE["p"] += _u.get("prompt_tokens", 0) or 0
                USAGE["c"] += _u.get("completion_tokens", 0) or 0
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
        if has_sconto: parts.append(f"da {_p(pieno)}€ a soli {_p(promo)}€")
        elif promo: parts.append(f"a soli {_p(promo)}€")
        if descr: parts.append(descr)
        caption = " — ".join([x for x in parts if x]) or "Nuovo prodotto disponibile!"

    # Footer contatti su righe separate (formattazione pulita) — per tutte le modalita
    footer = []
    if biz_address: footer.append(f"📍 {biz_address}")
    if biz_whatsapp: footer.append(f"📲 {biz_whatsapp}")
    if biz_website: footer.append(f"🌐 {biz_website}")
    if footer:
        caption = caption.rstrip() + "\n\n" + "\n".join(footer)

    return caption, image_url

# 2) Scegli quanti/quali prodotti
posts_per_run = max(1, min(posts_per_run, n, 10))
if selection_mode == "RANDOM":
    indices = random.sample(range(n), posts_per_run)
else:
    indices = [(row_index + k) % n for k in range(posts_per_run)]

# 3a) Anteprima: genera solo il primo elemento e mostralo, senza pubblicare
if preview_mode:
    caption, image_url = build_caption(df.iloc[indices[0]])
    img_url, img_file = resolve_image(image_url, caption)
    emit_preview(caption, img_url, img_file)
    print(f"AI_USAGE {USAGE['p']} {USAGE['c']} {ai_model}")
    sys.exit(0)

# 3b) Pubblica
n_ok = 0
for i in indices:
    try:
        caption, image_url = build_caption(df.iloc[i])
        img_url, img_file = resolve_image(image_url, caption)
        ok, msg = publish(caption, img_url, img_file)
        if ok:
            n_ok += 1
            print(f"POST_OK riga {i} (id {msg}): {caption[:70]}")
        else:
            print(f"POST_ERR riga {i}: {msg}")
    except Exception as e:
        print(f"POST_ERR riga {i}: {e}")

print(f"\nRIEPILOGO: {n_ok}/{len(indices)} pubblicati su {biz_name}")
print(f"AI_USAGE {USAGE['p']} {USAGE['c']} {ai_model}")
sys.exit(0 if n_ok > 0 else 1)
`;

/**
 * Scraping di un sito web (UNA TANTUM) con Playwright: estrae blocchi di testo
 * significativi + immagini e li stampa come JSON ("SCRAPE_JSON [...]").
 * ENV: SCRAPE_URL = url del sito.
 */
export const WEBSITE_SCRAPE_SCRIPT = String.raw`
import os, json
from playwright.sync_api import sync_playwright

url = os.environ.get("SCRAPE_URL", "").strip()
if not url:
    print("SCRAPE_ERR nessun URL")
    raise SystemExit(1)
if not url.lower().startswith("http"):
    url = "https://" + url

items = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")
        page.goto(url, wait_until="networkidle", timeout=45000)
        site_title = (page.title() or "").strip()
        blocks = page.eval_on_selector_all("h1,h2,h3,p,li", "els => els.map(e => (e.innerText||'').trim()).filter(t => t.length > 40)")
        imgs = page.eval_on_selector_all("img", "els => els.map(e => ({src:(e.currentSrc||e.src||''), w:(e.naturalWidth||0), h:(e.naturalHeight||0), alt:(e.alt||''), cls:(e.className||'')})).filter(o => o.src)")
        og = ""
        try:
            el = page.query_selector("meta[property='og:image']")
            og = el.get_attribute("content") if el else ""
        except Exception:
            og = ""
        browser.close()
except Exception as e:
    print(f"SCRAPE_ERR {e}")
    raise SystemExit(1)

# Pulisci testi (dedup, niente troppo corti)
seen = set(); texts = []
for t in blocks:
    t = " ".join(str(t).split())
    if len(t) > 40 and t not in seen:
        seen.add(t); texts.append(t)

# Pulisci immagini: http assolute, niente svg/data/sprite, ESCLUDI loghi/icone e immagini piccole
LOGO_KW = ("logo", "favicon", "icon", "sprite", "brand", "header")

def _is_logo(src, alt, cls, w, h):
    blob = (str(src) + " " + str(alt) + " " + str(cls)).lower()
    if any(k in blob for k in LOGO_KW):
        return True
    try:
        if w and h and (int(w) < 200 or int(h) < 200):  # icone/loghi piccoli
            return True
    except Exception:
        pass
    return False

good = []
if og and not _is_logo(og, "", "", 0, 0):
    good.append(og)
for o in imgs:
    s = str(o.get("src", ""))
    if s.startswith("//"):
        s = "https:" + s
    low = s.lower()
    if not low.startswith("http") or ".svg" in low or "data:" in low:
        continue
    if _is_logo(s, o.get("alt", ""), o.get("cls", ""), o.get("w", 0), o.get("h", 0)):
        continue
    if s not in good:
        good.append(s)

# Costruisci gli item: ogni blocco di testo con un'immagine (a rotazione)
for i, t in enumerate(texts[:25]):
    img = good[i % len(good)] if good else ""
    items.append({"title": site_title[:120], "content": t[:1200], "imageUrl": img, "sourceUrl": url})

if not items:
    print("SCRAPE_ERR nessun contenuto utile estratto")
    raise SystemExit(1)

print("SCRAPE_JSON " + json.dumps(items))
`;

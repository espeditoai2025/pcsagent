# Immagine di esecuzione per il nodo "coder" dell'agente.
# Contiene tutte le librerie promesse nel prompt del coder (src/nodes/coder.ts).
# Ricostruzione sul VPS:
#   docker build -t pcsai-python:latest docker/pcsai-python
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Dipendenze di sistema:
# - WeasyPrint: pango / cairo / gdk-pixbuf / libffi / shared-mime-info
# - font per il rendering PDF
# - psycopg2: libpq-dev + build-essential
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
    libffi-dev shared-mime-info \
    fonts-liberation fonts-dejavu-core \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Librerie Python (allineate al prompt del coder)
RUN pip install --no-cache-dir \
    pandas numpy scipy scikit-learn openpyxl sqlalchemy psycopg2-binary \
    requests beautifulsoup4 lxml html5lib \
    matplotlib seaborn pillow \
    weasyprint xhtml2pdf reportlab pypdf \
    pyyaml cryptography \
    playwright

# Chromium + dipendenze di sistema installati in /ms-playwright.
# Il codice generato deve usare p.chromium.launch() (auto-detect), NON un percorso hardcoded.
RUN playwright install --with-deps chromium

WORKDIR /app/data

CMD ["python", "--version"]

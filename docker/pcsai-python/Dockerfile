# Immagine di esecuzione per il nodo "coder" dell'agente.
# Contiene tutte le librerie promesse nel prompt del coder (src/nodes/coder.ts).
# Base: immagine ufficiale Playwright (Chromium + toolchain gia presenti).
# Ricostruzione sul VPS:
#   docker build -t pcsai-python:latest docker/pcsai-python
FROM mcr.microsoft.com/playwright/python:v1.40.0-jammy

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Dipendenze di sistema per WeasyPrint / pycairo / pango (compilazione da sorgente)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3-dev pkg-config \
    libffi-dev libssl-dev \
    libcairo2-dev libpango1.0-dev libgdk-pixbuf2.0-dev libglib2.0-dev \
    shared-mime-info \
    && rm -rf /var/lib/apt/lists/*

# Librerie Python (allineate al prompt del coder)
RUN pip install --no-cache-dir \
    pandas numpy scipy scikit-learn openpyxl sqlalchemy psycopg2-binary \
    requests beautifulsoup4 lxml html5lib \
    matplotlib seaborn pillow \
    weasyprint xhtml2pdf reportlab pypdf \
    pyyaml cryptography playwright

# Chromium e gia presente nella base image; riallinea al playwright installato via pip.
# Il codice generato deve usare p.chromium.launch() (auto-detect), NON un percorso hardcoded.
RUN playwright install chromium

WORKDIR /app/data

CMD ["python", "--version"]

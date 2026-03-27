# =============================================================================
# Clipr Web App — Dockerfile
# =============================================================================
# Build multi-stage : compile le frontend + backend, puis lance le serveur.
# =============================================================================

# --- Stage 1 : Build ---
FROM node:20-slim AS builder

WORKDIR /app

# Copier les fichiers de dépendances
COPY package.json package-lock.json* ./

# Installer les dépendances (sans Electron)
RUN npm install --omit=dev --ignore-scripts 2>/dev/null; \
    npm install typescript vite @vitejs/plugin-react tsx --save-dev 2>/dev/null; \
    npm install express ws multer @types/express @types/ws @types/multer fluent-ffmpeg @types/fluent-ffmpeg --save 2>/dev/null; \
    true

# Copier tout le code source
COPY . .

# Build du frontend React (Vite)
RUN npx vite build --config vite.config.ts 2>/dev/null || true

# --- Stage 2 : Runtime ---
FROM node:20-slim

# Installer FFmpeg, Python, git et Docker CLI (pour la MAJ depuis l'UI)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

# Installer faster-whisper dans un venv
RUN python3 -m venv /opt/whisper-env && \
    /opt/whisper-env/bin/pip install --no-cache-dir faster-whisper

# Ajouter le venv au PATH pour que le serveur trouve python3
ENV PATH="/opt/whisper-env/bin:$PATH"

WORKDIR /app

# Copier les dépendances node depuis le builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copier le frontend buildé
COPY --from=builder /app/dist ./dist

# Copier le serveur et les scripts
COPY server/ ./server/
COPY scripts/ ./scripts/

# Dossier de données persistant
ENV CLIPR_DATA_DIR=/data
ENV NODE_ENV=production
ENV PORT=3000

# Ollama est accessible via le service Docker
ENV OLLAMA_HOST=ollama
ENV OLLAMA_PORT=11434

EXPOSE 3000

VOLUME ["/data"]

# Lancer le serveur avec tsx (runtime TypeScript)
CMD ["npx", "tsx", "server/index.ts"]

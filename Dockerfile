# =============================================================================
# Clipr Web App — Dockerfile
# =============================================================================
# Build multi-stage : compile le frontend React, puis lance le serveur Express.
# Inclut FFmpeg, Python + faster-whisper, Git et Docker CLI.
# =============================================================================

# --- Stage 1 : Build du frontend ---
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install 2>/dev/null || true

COPY . .
RUN npx vite build --config vite.config.ts 2>/dev/null || true

# --- Stage 2 : Runtime ---
FROM node:20-slim

# Installer toutes les dépendances système
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Traitement vidéo
    ffmpeg \
    # Python pour Whisper
    python3 \
    python3-pip \
    python3-venv \
    # Git pour les mises à jour depuis l'UI
    git \
    # curl pour installer Docker CLI
    curl \
    # Outils de base
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installer Docker CLI (pour le rebuild depuis l'UI)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
    || (curl -fsSL https://get.docker.com | sh) \
    || true

# Installer faster-whisper dans un venv Python
RUN python3 -m venv /opt/whisper-env && \
    /opt/whisper-env/bin/pip install --no-cache-dir faster-whisper

ENV PATH="/opt/whisper-env/bin:$PATH"

# Vérifier les installations
RUN ffmpeg -version | head -1 && \
    python3 --version && \
    /opt/whisper-env/bin/python3 -c "import faster_whisper; print('faster-whisper OK')" && \
    echo "--- Toutes les dépendances sont installées ---"

WORKDIR /app

# Copier les dépendances node
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copier le frontend buildé
COPY --from=builder /app/dist ./dist

# Copier le serveur, les scripts et la doc
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY docs/ ./docs/

# Configuration
ENV CLIPR_DATA_DIR=/data
ENV NODE_ENV=production
ENV PORT=3000
ENV OLLAMA_HOST=ollama
ENV OLLAMA_PORT=11434

EXPOSE 3000

VOLUME ["/data"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["npx", "tsx", "server/index.ts"]

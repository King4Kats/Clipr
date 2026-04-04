# ── Stage 1 : Dependencies ──
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Stage 2 : Build frontend + server ──
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY . .
RUN npm run build:client && npm run build:server

# ── Stage 3 : Runtime ──
FROM nvidia/cuda:12.8.0-runtime-ubuntu22.04 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Force UTF-8 locale
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Installer les dependances systeme
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    build-essential \
    python3-dev \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Installer faster-whisper dans un venv (avec support large-v3)
RUN python3 -m venv /opt/whisper-venv \
    && /opt/whisper-venv/bin/pip install --no-cache-dir faster-whisper \
    && /opt/whisper-venv/bin/pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu128 \
    && /opt/whisper-venv/bin/pip install --no-cache-dir speechbrain scikit-learn soundfile \
    && /opt/whisper-venv/bin/pip install --no-cache-dir allosaurus \
    && /opt/whisper-venv/bin/pip install --no-cache-dir whisperx
ENV PATH="/opt/whisper-venv/bin:$PATH"

# Installer Docker CLI (pour self-rebuild)
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.4.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && chmod +x /usr/local/bin/docker

# Copier les fichiers
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package.json ./
COPY scripts/ ./scripts/
COPY docs/ ./docs/

# Verifier les installations
RUN echo "=== Verification ===" \
    && node --version \
    && ffmpeg -version 2>&1 | head -1 \
    && python3 --version \
    && python3 -c "import faster_whisper; print('faster-whisper OK')" \
    && git --version \
    && docker --version \
    && echo "=== Tout est installe ==="

# Creer le repertoire data
RUN mkdir -p /data/uploads /data/exports /data/projects /data/logs /data/temp

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV OLLAMA_HOST=ollama
ENV OLLAMA_PORT=11434

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "dist-server/index.js"]

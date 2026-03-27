<p align="center">
  <img src="src/assets/Clipr.svg" width="140" alt="Clipr logo">
</p>

<h1 align="center">Clipr</h1>

<p align="center">
  <strong>Segmentation vidéo intelligente par IA — Application web Docker 🐳</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0--web-006B9F?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-GPL--3.0-489caa?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker" alt="Docker">
  <img src="https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=nodedotjs" alt="Node.js">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript" alt="TypeScript">
</p>

---

## 📖 À propos

**Clipr** est une application web conteneurisée (Docker) permettant la segmentation automatique de vidéos par intelligence artificielle. Analyser un cours, une conférence, un podcast vidéo — Clipr écoute le contenu, identifie les sujets et propose un découpage en segments thématiques.

🔒 **Tout tourne en local.** Aucune donnée n'est envoyée sur Internet.

Accessible via navigateur à l'adresse `http://localhost:3000`. Pour un accès distant, configurer un nom de domaine avec Caddy et HTTPS automatique.

### Pipeline

```
Vidéo uploadée → FFmpeg (audio) → Whisper (transcription) → Ollama (analyse IA) → Éditeur NLE → Export
```

---

## ✨ Fonctionnalités

- **Upload drag & drop** — Importer des vidéos directement depuis le navigateur
- **Transcription locale** — Reconnaissance vocale via faster-whisper (Python)
- **Découpe IA** — Analyse thématique par LLM local (Ollama)
- **Éditeur NLE** — Timeline avec waveform, segments colorés, panneaux réorganisables
- **3 formats d'export** — Vidéos découpées (MP4), timecodes (TXT), texte propre (TXT)
- **Sauvegarde projets** — Auto-save + sauvegarde/chargement manuel
- **Mise à jour depuis l'interface** — Rebuild Docker intégré
- **Documentation intégrée** — Guide utilisateur + documentation développeur accessibles depuis l'app
- **Thème clair / sombre** — Interface adaptative
- **Accès distant** — Caddy + nom de domaine + HTTPS automatique

---

## 🛠 Stack technique

| Catégorie | Technologies |
|-----------|-------------|
| **Backend** | Express, WebSocket (ws), Node.js 20 |
| **Frontend** | React 18, TypeScript 5, Zustand, Tailwind CSS, Radix UI, Framer Motion |
| **Vidéo** | FFmpeg / FFprobe |
| **IA locale** | faster-whisper (Python), Ollama (service Docker) |
| **Infra** | Docker, Docker Compose, Caddy (HTTPS auto) |
| **Layout** | React Grid Layout |

---

## 🚀 Installation

### Installation rapide (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/King4Kats/Clipr/main/install.sh | bash
```

### Installation manuelle

```bash
git clone https://github.com/King4Kats/Clipr.git
cd Clipr
docker compose up -d --build
# Télécharger le modèle Ollama :
docker exec clipr-ollama ollama pull qwen2.5:3b
```

📌 Accéder à l'application : **http://localhost:3000**

---

## 💻 Développement local

```bash
npm install
npm run dev:web    # Lancer en développement avec HMR
npm run build:web  # Build production
npm run start:web  # Démarrer le serveur production
```

### Commandes utiles

| Commande | Description |
|----------|-------------|
| `docker compose up -d --build` | Démarrer les conteneurs |
| `docker compose logs -f clipr` | Afficher les logs en temps réel |
| `docker compose down` | Arrêter les conteneurs |
| `npm run dev:web` | Lancer le développement local |
| `npm run build:web` | Compiler le frontend |

---

## 🏗 Architecture

```
Docker Compose
├── clipr-app (Express + React)
│   ├── API REST + WebSocket (port 3000)
│   └── Services: FFmpeg, Whisper, Ollama client
├── ollama (LLM local, port 11434)
└── caddy (reverse proxy + HTTPS)
```

### Structure du projet

```
Clipr/
├── server/              # Backend Express
├── src/                 # Frontend React
├── scripts/             # Python transcription
├── docs/                # Documentation HTML
├── Dockerfile
├── docker-compose.yml
├── caddy/Caddyfile
└── install.sh
```

---

## 🌐 Accès distant

Pour rendre Clipr accessible depuis l'extérieur :

1. Configurer le `caddy/Caddyfile` avec le nom de domaine souhaité
2. Ouvrir les ports **80** et **443** sur le routeur/pare-feu
3. Redémarrer Caddy : `docker compose restart caddy`

Le certificat HTTPS est généré automatiquement par Caddy via Let's Encrypt.

---

## 🇬🇧 English

**Clipr** is a self-hosted web application (Docker) for AI-powered video segmentation. Upload a lecture, conference talk, or video podcast — Clipr extracts audio, transcribes speech locally with faster-whisper, and uses a local LLM (Ollama) to segment content by topic. Everything runs offline.

### Features

- Drag & drop upload via browser
- Local speech-to-text transcription (faster-whisper)
- AI-powered thematic segmentation (Ollama LLM)
- NLE-style editor with waveform timeline, colored segments, rearrangeable panels
- Export as MP4 clips, TXT timecodes, or clean transcript
- Auto-save + manual project management
- In-app update (Docker rebuild)
- Light / dark theme
- Remote access via Caddy reverse proxy + automatic HTTPS

### Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/King4Kats/Clipr/main/install.sh | bash
```

Then open **http://localhost:3000** in a browser.

---

## 📄 License

Distribué sous licence **GPL-3.0**. Consulter le fichier [LICENSE](LICENSE) pour plus de détails.

---

<p align="center">
  <sub>Fait avec ❤️ par <a href="https://github.com/King4Kats">King4Kats</a></sub>
</p>

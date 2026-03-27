<p align="center">
  <img src="src/assets/Clipr.svg" width="140" alt="Clipr logo">
</p>

<h1 align="center">Clipr</h1>

<p align="center">
  <strong>Decoupage video intelligent par intelligence artificielle</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-006B9F?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-GPL--3.0-489caa?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square&logo=windows" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-27-47848F?style=flat-square&logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript" alt="TypeScript">
</p>

---

## A propos

**Clipr** est une application de bureau qui analyse automatiquement vos videos grace a l'intelligence artificielle. Importez un cours, une conference, un podcast video — Clipr ecoute le contenu, identifie les sujets et propose un decoupage en segments thematiques.

**Tout se passe en local sur votre machine.** Aucune donnee n'est envoyee sur Internet.

### Comment ca marche

```
Video importee
  │
  ├─ 1. Extraction audio (FFmpeg)
  │     └─ Conversion en WAV 16kHz mono
  │
  ├─ 2. Transcription (Whisper)
  │     └─ Reconnaissance vocale locale, segments en temps reel
  │
  ├─ 3. Analyse thematique (LLM Ollama)
  │     └─ Decoupe intelligente en segments titres
  │
  └─ 4. Editeur interactif
        └─ Ajustement, renommage, export
```

---

## Fonctionnalites

- **Import multi-videos** — Glissez-deposez une ou plusieurs videos (MP4, MKV, AVI, MOV, WEBM)
- **Transcription automatique** — Reconnaissance vocale locale via Whisper (tiny, base, small, medium)
- **Decoupe IA** — Un LLM local (Ollama) identifie les themes et propose des segments
- **Editeur NLE** — Timeline avec waveform, segments colores, panneaux redimensionnables et deplacables
- **3 formats d'export** — Videos decoupees (MP4), timecodes (TXT), texte propre (TXT)
- **Sauvegarde de projets** — Auto-save + sauvegarde/chargement manuel (.json)
- **Mise a jour automatique** — Verification et installation depuis GitHub Releases
- **Documentation integree** — Guide utilisateur + kit developpeur accessible depuis l'app
- **Theme clair / sombre** — Interface adaptative

---

## Stack technique

| Categorie | Technologies |
|-----------|-------------|
| **Desktop** | Electron 27, electron-vite, electron-builder (NSIS) |
| **Frontend** | React 18, TypeScript 5, Zustand, Tailwind CSS, Radix UI, Framer Motion |
| **Layout** | React Grid Layout (panneaux draggables), react-resizable-panels |
| **Video** | FFmpeg / FFprobe (fluent-ffmpeg) |
| **IA locale** | faster-whisper (Python subprocess), Ollama (HTTP REST, port 11434) |
| **Modeles** | Whisper GGML (HuggingFace), Qwen2.5-3B / Phi-3-mini (GGUF) |
| **Logs** | electron-log (rotation 5 Mo), archiver (export ZIP) |
| **MAJ** | electron-updater + GitHub Releases |

---

## Installation

### Utilisateur

1. **Telecharger** le fichier `Clipr-Setup-X.Y.Z.exe` depuis les [Releases](https://github.com/King4Kats/Clipr/releases)
2. **Lancer** l'installeur — installation automatique, sans droits administrateur
3. **Premier lancement** — l'assistant telecharge les modeles IA (~2.2 Go au total)

### Developpeur

**Prerequisites** : Node.js 18+ et npm

```bash
# Cloner le repo
git clone https://github.com/King4Kats/Clipr.git
cd Clipr

# Installer les dependances
npm install

# Lancer en mode developpement (HMR)
npm run dev

# Build + installeur Windows
npm run build
```

| Commande | Description |
|----------|-------------|
| `npm run dev` | Developpement avec Hot Module Replacement |
| `npm run build` | Compilation TypeScript + creation installeur NSIS |
| `npm run preview` | Previsualisation du build |
| `npm run test` | Lancer les tests (Vitest) |

---

## Structure du projet

```
Clipr/
├── electron/                  # Processus principal (Node.js)
│   ├── main.ts               # Point d'entree, handlers IPC
│   ├── preload.ts             # Bridge securise (ContextBridge)
│   └── services/
│       ├── ffmpeg.ts          # Extraction audio, decoupe, concatenation
│       ├── whisper.ts         # Transcription vocale (subprocess Python)
│       ├── ollama.ts          # Analyse LLM (serveur Ollama local)
│       ├── model-manager.ts   # Telechargement modeles IA
│       ├── project-history.ts # Sauvegarde/chargement projets
│       ├── setup.ts           # Verification des dependances
│       ├── logger.ts          # Logging persistant (electron-log)
│       ├── log-sender.ts      # Export ZIP des logs
│       ├── updater.ts         # Mise a jour automatique
│       ├── whisper-native.ts  # Transcription native (alternatif)
│       └── llm-native.ts     # Inference LLM native (alternatif)
│
├── src/                       # Processus renderer (React)
│   ├── App.tsx                # Composant racine, routage par etat
│   ├── store/useStore.ts      # Etat global Zustand
│   ├── types/index.ts         # Interfaces TypeScript
│   ├── components/
│   │   ├── SetupWizard.tsx    # Assistant de configuration
│   │   ├── new/               # Composants applicatifs
│   │   │   ├── Header.tsx
│   │   │   ├── UploadZone.tsx
│   │   │   ├── AIAnalysisPanel.tsx
│   │   │   ├── ProgressPanel.tsx
│   │   │   ├── VideoPreview.tsx
│   │   │   ├── EditorLayout.tsx
│   │   │   ├── Timeline.tsx
│   │   │   ├── SegmentTimeline.tsx
│   │   │   └── Mascot.tsx
│   │   └── ui/                # Primitives Radix UI (shadcn/ui)
│   └── assets/
│       ├── Clipr.svg          # Logo
│       └── Clipr.ico          # Icone Windows
│
├── docs/                      # Documentation HTML
└── models/                    # Modeles IA (telecharges au runtime)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Processus Principal                    │
│                    (electron/main.ts)                    │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ ffmpeg   │ │ whisper  │ │ ollama   │ │  model-   │  │
│  │   .ts    │ │   .ts    │ │   .ts    │ │ manager   │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ logger   │ │ updater  │ │  setup   │ │  project  │  │
│  │   .ts    │ │   .ts    │ │   .ts    │ │ history   │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│                                                         │
│              preload.ts (ContextBridge)                  │
│         41 canaux IPC (36 invoke + 5 events)            │
└────────────────────────┬────────────────────────────────┘
                         │ window.electron.*
┌────────────────────────┴────────────────────────────────┐
│                   Processus Renderer                     │
│                       (React 18)                         │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │              useStore (Zustand)                  │    │
│  │  videoFiles, transcript, segments, config, ...  │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  App.tsx                                                │
│  ├── Header          ├── ProgressPanel                  │
│  ├── UploadZone      ├── EditorLayout                   │
│  ├── SetupWizard     │   ├── VideoPreview               │
│  └── AIAnalysisPanel │   ├── Timeline                   │
│                      │   └── SegmentTimeline             │
└─────────────────────────────────────────────────────────┘
```

---

## English

**Clipr** is a desktop application that automatically analyzes videos using local AI. It extracts audio, transcribes speech with Whisper, and uses a local LLM (Ollama) to segment content by topic — all running offline on your machine.

### Features

- Multi-video import (drag & drop)
- Local speech-to-text transcription (Whisper)
- AI-powered thematic segmentation (Ollama LLM)
- NLE-style editor with waveform timeline, colored segments, draggable panels
- Export as MP4 clips, TXT timecodes, or clean transcript
- Auto-save, manual project management
- Auto-updates via GitHub Releases

### Quick start

```bash
git clone https://github.com/King4Kats/Clipr.git
cd Clipr && npm install && npm run dev
```

Or download the latest installer from [Releases](https://github.com/King4Kats/Clipr/releases).

---

## License

Ce projet est distribue sous licence **GPL-3.0**. Voir le fichier [LICENSE](LICENSE) pour plus de details.

---

<p align="center">
  <sub>Fait avec  ❤️ par <a href="https://github.com/King4Kats">King4Kats</a></sub>
</p>

<p align="center">
  <img src="src/assets/Clipr.svg" width="140" alt="Clipr logo">
</p>

<h1 align="center">Clipr</h1>

<p align="center">
  <strong>Application web Docker pour segmenter automatiquement des vidéos longues en extraits thématiques grâce à l'IA locale</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker" alt="Docker">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react" alt="React">
  <img src="https://img.shields.io/badge/Whisper-local-FF6F00?style=flat-square" alt="Whisper">
  <img src="https://img.shields.io/badge/Ollama-LLM-000000?style=flat-square" alt="Ollama">
</p>

---

## 📋 Table des matières

- [Architecture](#-architecture-docker)
- [Prérequis](#-prérequis)
- [Installation](#-installation)
- [Configuration](#%EF%B8%8F-configuration)
- [Utilisation](#-utilisation)
- [Commandes Docker](#-commandes-docker)
- [Architecture technique](#-architecture-technique)
- [Développement](#-développement)
- [Licence](#-licence)

---

## 🏗 Architecture Docker

```
┌─────────────────────────────────────────────────────────────┐
│                      docker-compose                         │
│                                                             │
│  ┌─────────────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │       clipr          │  │    ollama     │  │   caddy   │  │
│  │                      │  │              │  │           │  │
│  │  Node.js (Express)   │  │  LLM local   │  │  Reverse  │  │
│  │  FFmpeg              │  │  GPU         │  │  Proxy    │  │
│  │  Python              │  │              │  │  HTTPS    │  │
│  │  faster-whisper      │  │              │  │           │  │
│  │                      │  │  :11434      │  │  :443     │  │
│  │  :3000               │  │              │  │  :80      │  │
│  └─────────────────────┘  └──────────────┘  └───────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

| Service | Rôle | Port |
|---------|------|------|
| **clipr** | Backend Express + transcription Whisper + FFmpeg | `3000` |
| **ollama** | Serveur LLM local (accélération GPU) | `11434` |
| **caddy** | Reverse proxy avec HTTPS automatique | `80` / `443` |

---

## ✅ Prérequis

- **Docker** >= 20.10
- **Docker Compose** >= 2.0
- **GPU NVIDIA** recommandé pour Ollama (CUDA) — fonctionne aussi en CPU, mais plus lentement

---

## 🚀 Installation

### Installation rapide (une commande)

```bash
bash <(curl -s https://raw.githubusercontent.com/King4Kats/Clipr/main/install.sh)
```

### Installation manuelle

```bash
# Cloner le dépôt
git clone https://github.com/King4Kats/Clipr.git
cd Clipr

# Lancer les conteneurs
docker compose up -d
```

L'application est ensuite accessible sur **http://localhost:3000**.

---

## ⚙️ Configuration

### Nom de domaine (HTTPS)

Définir la variable d'environnement `CLIPR_DOMAIN` pour configurer le domaine dans Caddy :

```bash
export CLIPR_DOMAIN=clipr.mondomaine.fr
```

Ou modifier directement le fichier `caddy/Caddyfile` :

```
clipr.mondomaine.fr {
    reverse_proxy clipr:3000
}
```

### Modèles Ollama

Les modèles LLM se gèrent directement depuis l'interface de Clipr :

1. Ouvrir l'application
2. Accéder aux **Paramètres** (icône engrenage)
3. Sélectionner et télécharger le modèle souhaité

---

## 🎬 Utilisation

1. **Ouvrir** l'application : `http://localhost:3000`
2. **Importer** une vidéo (drag & drop ou sélection de fichier)
3. **Analyse automatique** : extraction audio → transcription Whisper → segmentation thématique par LLM
4. **Ajuster** les segments dans l'éditeur interactif
5. **Exporter** les extraits (MP4, timecodes TXT, transcription)

---

## 🐳 Commandes Docker

| Commande | Description |
|----------|-------------|
| `docker compose up -d` | Démarrer tous les services |
| `docker compose down` | Arrêter tous les services |
| `docker compose logs -f` | Suivre les logs en temps réel |
| `docker compose logs -f clipr` | Logs du service Clipr uniquement |
| `docker compose restart` | Redémarrer les services |
| `docker compose build --no-cache` | Reconstruire les images sans cache |
| `docker compose pull && docker compose up -d` | Mettre à jour et relancer |

---

## 🔧 Architecture technique

### Backend — `server/`

- **Express.js** : API REST + serveur de fichiers statiques
- **WebSocket** : communication temps réel (progression, transcription live)
- **FFmpeg** : extraction audio, découpe et export des segments vidéo
- **faster-whisper** (Python) : transcription vocale locale
- **Ollama** (HTTP) : analyse sémantique et segmentation thématique via LLM

### Frontend — `src/`

- **React 18** + **TypeScript**
- **Zustand** : gestion d'état global (`src/store/useStore.ts`)
- **Tailwind CSS** : styles utilitaires
- Composants principaux dans `src/components/new/`

### Flux de traitement

```
Vidéo importée
  │
  ├─ 1. Extraction audio (FFmpeg)
  │     └─ Conversion en WAV 16kHz mono
  │
  ├─ 2. Transcription (faster-whisper)
  │     └─ Reconnaissance vocale locale, segments horodatés
  │
  ├─ 3. Analyse thématique (Ollama LLM)
  │     └─ Découpe intelligente en segments titrés
  │
  └─ 4. Éditeur interactif
        └─ Ajustement, renommage, export
```

---

## 💻 Développement

### Lancer en mode développement (hors Docker)

```bash
# Installer les dépendances
npm install

# Lancer client + serveur en parallèle (HMR)
npm run dev

# Build de production
npm run build
```

| Commande | Description |
|----------|-------------|
| `npm run dev` | Développement avec Hot Module Replacement (client + serveur) |
| `npm run build` | Compilation TypeScript + build de production |

---

## 📄 Licence

Ce projet est distribué sous licence **MIT**. Voir le fichier [LICENSE](LICENSE) pour les détails.

---

<p align="center">
  <sub>Fait avec ❤️ par <a href="https://github.com/King4Kats">King4Kats</a></sub>
</p>

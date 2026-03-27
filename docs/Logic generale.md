# Architecture Generale de Clipr

> Documentation interne - Vue d'ensemble du fonctionnement de l'application.

---

## Sommaire

1. [Architecture a deux processus](#1-architecture-a-deux-processus)
2. [Structure du projet](#2-structure-du-projet)
3. [Le pont IPC : comment les deux cotes communiquent](#3-le-pont-ipc--comment-les-deux-cotes-communiquent)
4. [Pipeline de traitement video](#4-pipeline-de-traitement-video)
5. [Technologies et dependances](#5-technologies-et-dependances)
6. [Gestion de l'etat (store)](#6-gestion-de-letat-store)

---

## 1. Architecture a deux processus

Clipr est une application **Electron**, ce qui signifie qu'elle est composee de deux processus distincts qui tournent en parallele :

### Le processus principal (Main Process)

C'est le coeur de l'application. Il a acces a tout le systeme d'exploitation : fichiers, reseau, processus enfants, etc. C'est lui qui :

- Cree et gere la fenetre de l'application
- Execute FFmpeg pour manipuler la video
- Lance le script Python de transcription Whisper (ou utilise l'implementation native)
- Communique avec le serveur local Ollama pour l'analyse IA (ou utilise un LLM natif)
- Gere les dialogues systeme (ouvrir un fichier, enregistrer sous...)
- Gere les mises a jour et les logs

**Dossier correspondant :** `electron/`

### Le processus de rendu (Renderer Process)

C'est l'interface graphique. Techniquement, c'est une page web (HTML/CSS/JS) qui tourne dans un Chromium integre. C'est la partie visible par l'utilisateur : dashboard, lecteur video, barres de progression, editeur de segments.

Pour des raisons de securite, ce processus **n'a aucun acces direct** au systeme. Il ne peut pas lire un fichier, lancer un programme ou acceder au reseau. Tout doit transiter par le processus principal via l'IPC (voir section 3).

**Dossier correspondant :** `src/`

### Pourquoi cette separation ?

C'est un choix de securite d'Electron. Si un jour une faille de securite existait dans l'interface web, un attaquant ne pourrait pas acceder au systeme de fichiers ou executer du code arbitraire, car le renderer est isole. Seules les fonctions explicitement exposees dans `preload.ts` sont accessibles.

---

## 2. Structure du projet

```
clipr/
├── electron/                        # Processus principal (Node.js)
│   ├── main.ts                      # Point d'entree, handlers IPC, cycle de vie de la fenetre
│   ├── preload.ts                   # Pont securise : expose les fonctions au renderer
│   └── services/                    # Services metier (un fichier = une responsabilite)
│       ├── ffmpeg.ts                # Traitement video : extraction audio, decoupage, concatenation
│       ├── whisper.ts               # Transcription via faster-whisper (processus Python externe)
│       ├── whisper-native.ts        # Transcription alternative sans Python (telecharge le modele)
│       ├── ollama.ts                # Analyse semantique via Ollama (serveur LLM local)
│       ├── llm-native.ts            # Analyse alternative avec un LLM GGUF embarque
│       ├── model-manager.ts         # Telechargement et verification des modeles IA
│       ├── setup.ts                 # Verification des dependances systeme (legacy, non utilise)
│       ├── logger.ts                # Logging centralise (electron-log, rotation 5MB)
│       ├── log-sender.ts            # Export des logs en ZIP + gestion UUID d'installation
│       ├── updater.ts               # Mise a jour automatique via GitHub Releases
│       └── project-history.ts       # Sauvegarde/chargement de projets (auto-save + manuel)
│
├── src/                             # Processus de rendu (React + TypeScript)
│   ├── App.tsx                      # Composant racine : dashboard modernise avec animations
│   ├── main.tsx                     # Point d'entree React (montage du DOM)
│   ├── index.css                    # Styles globaux (Tailwind base + variables CSS)
│   ├── store/useStore.ts            # Etat global (Zustand) : videos, segments, config, etape
│   ├── types/index.ts               # Types TypeScript partages (ElectronAPI, segments, config)
│   ├── lib/utils.ts                 # Utilitaires (cn() pour les classes Tailwind)
│   │
│   ├── components/                  # Composants applicatifs
│   │   ├── SetupWizard.tsx          # Ecran de configuration initiale + diagnostic + mise a jour
│   │   └── new/                     # Interface principale (version actuelle)
│   │       ├── Header.tsx           # Barre de navigation avec tabs et parametres
│   │       ├── UploadZone.tsx       # Zone d'import video avec animations Framer Motion
│   │       ├── AIAnalysisPanel.tsx  # Panneau de lancement de l'analyse IA
│   │       ├── VideoPreview.tsx     # Lecteur video embarque
│   │       ├── EditorLayout.tsx     # Layout drag-and-drop configurable (react-grid-layout)
│   │       ├── Timeline.tsx         # Timeline des segments avec marqueurs
│   │       ├── SegmentTimeline.tsx  # Vue detaillee des segments sur la timeline
│   │       └── ProgressPanel.tsx    # Indicateur de progression redesigne
│   │
│   └── components/ui/               # Composants de base (Shadcn UI) - uniquement ceux utilises
│       ├── button.tsx               # Bouton avec variantes (default, destructive, outline, ghost, link)
│       ├── input.tsx                # Champ de saisie texte
│       ├── select.tsx               # Liste deroulante de selection
│       └── slider.tsx               # Curseur de valeur numerique
│
├── scripts/
│   ├── transcribe.py                # Script Python pour faster-whisper
│   └── generate-icon.mjs            # Generation de l'icone de l'application
│
├── assets/                          # Icones de l'application
│   ├── Clipr.ico
│   └── Clipr.svg
│
└── docs/                            # Documentation interne
```

### Organisation des composants

L'interface a ete nettoyee : les anciens composants (DropZone, ConfigPanel, SegmentEditor, etc.) et les composants inutilises (ProjectCard, NavLink, Mascot) ont ete supprimes. Il ne reste que :

- **`SetupWizard.tsx`** dans `components/` : ecran de configuration, diagnostic et mise a jour. C'est le seul composant de l'ancienne interface encore utilise.
- **`components/new/`** : les 8 composants de l'interface actuelle, utilises par `App.tsx` et `EditorLayout.tsx`.

Le layout de l'editeur (`EditorLayout.tsx`) utilise `react-grid-layout` pour permettre a l'utilisateur de reorganiser les panneaux (video, timeline, segments) par glisser-deposer. La disposition est sauvegardee dans le localStorage.

### Composants Shadcn UI

Le dossier `components/ui/` a ete nettoye pour ne conserver que les 4 composants effectivement utilises par l'application :

| Composant | Utilise par |
|---|---|
| `button.tsx` | AIAnalysisPanel, EditorLayout, Header, ProgressPanel, SegmentTimeline, Timeline, VideoPreview |
| `input.tsx` | VideoPreview |
| `select.tsx` | AIAnalysisPanel |
| `slider.tsx` | VideoPreview |

Les 45 autres composants ShadCN installes par defaut mais jamais importes ont ete supprimes. Ils peuvent etre reinstalles a la demande via `npx shadcn@latest add <composant>` si besoin.

### Principe d'organisation des services

Chaque fichier dans `electron/services/` represente **une responsabilite unique** :

| Service | Responsabilite | Depend de |
|---|---|---|
| `ffmpeg.ts` | Manipulation video (couper, coller, extraire audio) | FFmpeg (binaire embarque) |
| `whisper.ts` | Transcription audio via processus Python | Python + faster-whisper |
| `whisper-native.ts` | Transcription sans Python (modele telecharge) | Modele Whisper GGUF |
| `ollama.ts` | Analyse semantique via serveur Ollama local | Serveur Ollama |
| `llm-native.ts` | Analyse avec un LLM GGUF embarque (sans Ollama) | Modele GGUF telecharge |
| `model-manager.ts` | Telechargement et verification des modeles IA | Systeme de fichiers |
| `setup.ts` | Verification des dependances systeme (legacy, non importe) | Processus enfants (spawn) |
| `logger.ts` | Ecriture structuree des logs | electron-log |
| `log-sender.ts` | Export des logs + identification d'installation | logger.ts, archiver |
| `updater.ts` | Mise a jour automatique | electron-updater, GitHub |
| `project-history.ts` | Persistance des projets utilisateur | Systeme de fichiers |

Cette separation permet de modifier un service sans impacter les autres. Par exemple, l'application propose deux chemins pour la transcription : `whisper.ts` (via Python) et `whisper-native.ts` (embarque). Le meme principe s'applique a l'analyse IA avec `ollama.ts` et `llm-native.ts`.

> **Note :** `setup.ts` contenait des fonctions de verification des dependances (`checkFFmpeg`, `checkPython`, `checkOllamaInstalled`) mais n'est plus importe par `main.ts`. La verification de FFmpeg est desormais assuree par `ffmpeg.ts` et la verification d'Ollama par `ollama.ts`. Ce fichier est conserve a titre de reference mais pourra etre supprime.

---

## 3. Le pont IPC : comment les deux cotes communiquent

IPC signifie **Inter-Process Communication**. C'est le mecanisme qui permet au renderer (l'interface) de demander des actions au processus principal (le backend).

### Le circuit complet d'un appel

Prenons l'exemple concret de l'extraction audio :

```
1. L'utilisateur clique "Analyser" dans l'interface (AIAnalysisPanel.tsx)

2. Le composant React appelle :
   window.electron.extractAudio('/path/to/video.mp4')

3. Cette fonction est definie dans preload.ts :
   extractAudio: (videoPath) => ipcRenderer.invoke('ffmpeg:extractAudio', videoPath)
   --> invoke() envoie un message au processus principal et attend la reponse

4. Dans main.ts, le handler correspondant recoit le message :
   ipcMain.handle('ffmpeg:extractAudio', async (_, videoPath) => {
     return extractAudio(videoPath, (percent) => { sendProgress(percent, '...') })
   })
   --> Il appelle le service ffmpeg.ts qui execute la commande FFmpeg

5. Le resultat (chemin du fichier audio) remonte la chaine :
   ffmpeg.ts -> main.ts -> preload.ts -> composant React
```

### Les trois fichiers impliques

| Fichier | Role dans l'IPC |
|---|---|
| `electron/preload.ts` | Definit les fonctions disponibles cote renderer. C'est la **surface d'API** exposee a l'interface. Chaque fonction fait un `ipcRenderer.invoke('canal', args)`. |
| `electron/main.ts` | Enregistre les handlers avec `ipcMain.handle('canal', callback)`. Recoit les appels et delegue aux services. |
| `src/types/index.ts` | Definit les types TypeScript de l'API (`ElectronAPI`). Assure que le renderer et le preload sont synchronises sur les signatures. |

### Communication bidirectionnelle

Certaines operations longues (transcription, telechargement, mise a jour) envoient des mises a jour de progression **du main vers le renderer** :

```
main.ts --> mainWindow.webContents.send('processing:progress', { progress: 45, message: '...' })
         |
         v
preload.ts --> ipcRenderer.on('processing:progress', handler)
            |
            v
composant React --> met a jour la barre de progression
```

Le renderer s'abonne a ces evenements via les fonctions `onProgress`, `onUpdateStatus`, `onModelProgress`, etc. definies dans `preload.ts`. Chaque abonnement retourne une fonction de desabonnement appelee dans le `useEffect` cleanup pour eviter les fuites memoire.

---

## 4. Pipeline de traitement video

Quand l'utilisateur importe une video et lance l'analyse, voici la sequence complete :

```
Import video       Extraction audio       Transcription          Analyse IA           Edition
(UploadZone)  -->     (FFmpeg)      -->    (Whisper)       -->    (Ollama)     -->  (EditorLayout)
                                                                                         |
                                                                                         v
                                                                                   Export final
                                                                                    (FFmpeg)
```

### Etape 1 : Import et validation

Le composant `UploadZone.tsx` recoit le fichier (glisser-deposer ou dialogue d'ouverture). Le main process verifie la duree via FFprobe (`ffmpeg:getDuration`). La video est affichee dans le lecteur via un protocole personnalise `local-video://` qui permet de charger des fichiers locaux dans Chromium sans violer les regles de securite (Content Security Policy).

L'application gere le multi-video : chaque fichier recoit un offset temporel pour creer une timeline globale.

### Etape 2 : Extraction audio

FFmpeg extrait la piste audio de la video en fichier WAV temporaire. C'est necessaire car Whisper travaille uniquement sur de l'audio. La progression est envoyee en temps reel au renderer via `processing:progress`.

### Etape 3 : Transcription

Deux chemins possibles selon la configuration :

**Via Python (`whisper.ts`)** : lance un processus enfant qui execute `scripts/transcribe.py` avec faster-whisper. Le script communique avec Node.js via `stderr` en utilisant un protocole textuel :
- `PROGRESS:45` - pourcentage d'avancement
- `SEGMENT:{"id":"1","start":12.5,"end":18.3,"text":"..."}` - segment transcrit
- `STATUS:Loading model...` - message d'etat

**Via implementation native (`whisper-native.ts`)** : telecharge un modele Whisper au format GGUF et execute la transcription directement, sans necessiter Python.

Dans les deux cas, chaque segment est envoye au renderer en temps reel (`whisper:segment`), ce qui permet d'afficher la transcription au fur et a mesure.

### Etape 4 : Analyse semantique

Le texte complet de la transcription est envoye a un LLM. Deux chemins possibles :

**Via Ollama (`ollama.ts`)** : communique avec le serveur Ollama local via son API REST (`http://localhost:11434`). Le service gere le demarrage automatique d'Ollama si necessaire.

**Via LLM natif (`llm-native.ts`)** : utilise un modele GGUF telecharge localement, sans serveur intermediaire.

Le modele recoit un prompt structure qui lui demande d'identifier des segments thematiques et de proposer des points de coupe. Si le texte est trop long, il est decoupe en blocs (chunking) traites sequentiellement, puis les resultats sont fusionnes.

### Etape 5 : Edition manuelle

L'utilisateur ajuste les segments dans l'`EditorLayout.tsx`, un layout configurable avec trois panneaux reorganisables :
- **Video** (`VideoPreview.tsx`) : lecteur video avec controles
- **Segments** (`Timeline.tsx`) : liste des segments avec titres editables
- **Timeline** (`SegmentTimeline.tsx`) : vue chronologique avec bornes ajustables

### Etape 6 : Export

FFmpeg decoupe la video originale selon les segments finalises. Chaque segment est exporte en fichier individuel. L'option de concatenation assemble les segments en une seule video.

---

## 5. Technologies et dependances

| Technologie | Usage | Pourquoi ce choix |
|---|---|---|
| **Electron** | Framework d'application desktop | Permet d'utiliser les technologies web tout en ayant acces au systeme |
| **React 18** | Interface utilisateur | Composants reutilisables, rendu performant, ecosysteme mature |
| **TypeScript** | Langage | Typage statique, erreurs detectees a la compilation |
| **Vite (electron-vite)** | Build et dev server | Demarrage instantane en dev, build optimise en production |
| **Tailwind CSS** | Styles | Classes utilitaires directement dans le JSX, pas de CSS separe |
| **Shadcn UI** | Composants de base | 4 composants utilises (button, input, select, slider), installables a la demande |
| **Framer Motion** | Animations | Transitions fluides et animations declaratives dans React |
| **react-grid-layout** | Layout editeur | Panneaux reorganisables par drag-and-drop |
| **Zustand** | Gestion d'etat | Plus leger que Redux, un seul fichier pour tout l'etat global |
| **Lucide React** | Icones | Jeu d'icones coherent et leger |
| **FFmpeg** | Traitement video | Standard de l'industrie, supporte tous les codecs |
| **faster-whisper** | Transcription vocale | Implementation optimisee de Whisper, tourne localement |
| **Ollama** | Inference LLM locale | Serveur local pour modeles de langage, interface simple |
| **electron-log** | Logging | Rotation automatique, adapte a Electron |
| **electron-updater** | Mise a jour | Integration native avec GitHub Releases |
| **electron-builder** | Packaging | Installeurs Windows (NSIS), signature, publication |

---

## 6. Gestion de l'etat (store)

L'application utilise **Zustand** pour centraliser l'etat global dans `src/store/useStore.ts`. Ce fichier contient :

- Les videos importees et leurs metadonnees (chemin, duree, offset temporel)
- Les segments de transcription (texte + timestamps)
- Les segments de decoupage (bornes de coupe, titres, couleurs)
- L'etape actuelle du pipeline (`idle`, `extracting-audio`, `transcribing`, `analyzing`, `ready`, `exporting`, `done`, `error`)
- La progression et le message de l'etape en cours
- Les parametres utilisateur (modele Whisper, modele LLM, langue, contexte IA)
- L'historique des projets

Tous les composants React lisent et modifient cet etat via des hooks Zustand :

```typescript
// Lire l'etat
const videos = useStore(state => state.videoFiles)
const segments = useStore(state => state.segments)
const step = useStore(state => state.processingStep)

// Modifier l'etat
const setProcessing = useStore(state => state.setProcessing)
setProcessing('transcribing', 45, 'Transcription en cours...')
```

L'avantage de Zustand est que n'importe quel composant peut acceder a n'importe quelle donnee sans avoir a faire transiter des props de parent en enfant a travers toute l'arborescence des composants.

---

> **Pour aller plus loin :** Chaque fichier de service contient des commentaires detailles en en-tete qui expliquent son role et son fonctionnement interne. Consulter `docs/log et Maj chez utilisateur.md` pour le detail du systeme de logs et de mise a jour.

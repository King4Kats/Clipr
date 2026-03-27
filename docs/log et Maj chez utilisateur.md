# Systeme de Logs et Mise a Jour Automatique

> Documentation interne - Fonctionnement detaille du diagnostic et de la distribution des mises a jour.

---

## Sommaire

1. [Vue d'ensemble](#1-vue-densemble)
2. [Systeme de logging](#2-systeme-de-logging)
3. [Export des logs et identification](#3-export-des-logs-et-identification)
4. [Mise a jour automatique](#4-mise-a-jour-automatique)
5. [Flux IPC detaille](#5-flux-ipc-detaille)
6. [Interface utilisateur (SetupWizard)](#6-interface-utilisateur-setupwizard)
7. [Publication d'une nouvelle version](#7-publication-dune-nouvelle-version)
8. [Reference des fichiers](#8-reference-des-fichiers)
9. [FAQ](#9-faq)

---

## 1. Vue d'ensemble

L'application dispose de deux mecanismes complementaires pour le support et la distribution :

- **Le logging** : enregistrement permanent de toutes les actions et erreurs de l'application dans des fichiers sur le disque de l'utilisateur. Permet de diagnostiquer des problemes a distance en demandant a l'utilisateur d'exporter ses logs.

- **La mise a jour automatique** : verification et installation de nouvelles versions via GitHub Releases, sans que l'utilisateur ait besoin de retelecharger manuellement l'installeur.

Les deux systemes sont accessibles depuis l'ecran de configuration (SetupWizard) dans la section "Diagnostic" et "Mise a jour".

---

## 2. Systeme de logging

### Principe

Tous les `console.log` et `console.error` de l'application ont ete remplaces par un logger centralise base sur la librairie `electron-log`. La difference fondamentale :

- `console.log()` affiche un message dans la console de developpement (DevTools). Si personne ne regarde, le message est perdu.
- `logger.info()` ecrit le message dans un **fichier sur le disque**, avec un horodatage precis et un niveau de severite. Le message persiste meme si l'application plante.

### Configuration (`electron/services/logger.ts`)

Le logger est configure au demarrage avec les parametres suivants :

| Parametre | Valeur | Explication |
|---|---|---|
| Chemin du fichier | `%APPDATA%/decoupeur-video/logs/main.log` | Dossier standard pour les donnees applicatives sous Windows |
| Taille max | 5 MB | Au-dela, le fichier est archive et un nouveau est cree (rotation) |
| Format | `[2025-01-15 14:30:22.123] [info] message` | Horodatage milliseconde + niveau (info/warn/error/debug) |
| Console en dev | Activee | En mode developpement, les logs apparaissent aussi dans la console |
| Console en prod | Desactivee | En production, seul le fichier est utilise |

### Niveaux de log

```
debug  -->  Informations techniques detaillees (progression interne, valeurs de variables)
info   -->  Actions normales (demarrage, chargement d'un fichier, fin de traitement)
warn   -->  Situations anormales mais gerees (timeout, reessai, fallback)
error  -->  Erreurs qui impactent le fonctionnement (echec de transcription, fichier introuvable)
```

### Informations systeme au demarrage

A chaque lancement, la fonction `logSystemInfo()` enregistre automatiquement :

```
[2025-01-15 14:30:00.001] [info] === Application Starting ===
[2025-01-15 14:30:00.002] [info] App Version: 1.0.0
[2025-01-15 14:30:00.003] [info] Electron: 27.3.0
[2025-01-15 14:30:00.004] [info] OS: Windows_NT 10.0.22631 (x64)
[2025-01-15 14:30:00.005] [info] Memory: 16384 MB total, 8192 MB free
[2025-01-15 14:30:00.006] [info] CPUs: 8x AMD Ryzen 7 5800X
[2025-01-15 14:30:00.007] [info] User Data: C:\Users\xxx\AppData\Roaming\decoupeur-video
```

Ces informations sont precieuses pour le diagnostic : elles permettent de savoir immediatement sur quel environnement l'utilisateur travaille.

### Utilisation dans le code

Chaque service importe le logger et l'utilise a la place de `console` :

```typescript
import { logger } from './logger.js'

// Avant
console.log('Extraction audio terminee :', result)
console.error('Erreur FFmpeg :', error)

// Apres
logger.info('Extraction audio terminee :', result)
logger.error('Erreur FFmpeg :', error)
```

Les services concernes : `main.ts`, `ffmpeg.ts`, `whisper.ts`, `ollama.ts`, `model-manager.ts`, `project-history.ts`.

---

## 3. Export des logs et identification

### UUID d'installation (`electron/services/log-sender.ts`)

Au premier lancement, l'application genere un identifiant unique universel (UUID v4) et le stocke dans :

```
%APPDATA%/decoupeur-video/installation-id.json
```

Contenu du fichier :
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "createdAt": "2025-01-15T14:30:00.000Z"
}
```

Cet identifiant permet de distinguer les installations quand plusieurs utilisateurs envoient leurs logs. Il est genere une seule fois et ne change jamais, meme apres une mise a jour de l'application.

L'UUID est affiche sous forme tronquee dans l'interface (les 8 premiers caracteres) avec un bouton pour copier l'identifiant complet.

### Processus d'export

Quand l'utilisateur clique "Exporter les logs" :

```
1. L'interface appelle window.electron.sendLogs()
   |
2. Le handler IPC dans main.ts ouvre un dialogue "Enregistrer sous"
   |  --> Nom par defaut : clipr-logs-a1b2c3d4.zip
   |  --> Dossier par defaut : Telechargements
   |
3. Si l'utilisateur confirme, exportLogs() dans log-sender.ts :
   |
   |  a. Cree une archive ZIP contenant :
   |     - Le dossier logs/ complet (tous les fichiers de log)
   |     - Le fichier installation-id.json
   |
   |  b. Copie le ZIP vers l'emplacement choisi par l'utilisateur
   |
4. Le resultat (succes/erreur + chemin) est renvoye a l'interface
```

L'utilisateur peut ensuite transmettre ce fichier ZIP par le moyen de son choix (email, messagerie, partage Nextcloud, etc.).

### Contenu du ZIP exporte

```
clipr-logs-a1b2c3d4.zip
├── logs/
│   ├── main.log           # Log actuel
│   └── main.old.log       # Log precedent (si rotation)
└── installation-id.json   # UUID de l'installation
```

---

## 4. Mise a jour automatique

### Fonctionnement general

Le systeme utilise la librairie `electron-updater` qui s'integre nativement avec Electron et GitHub Releases. Le principe repose sur un fichier `latest.yml` publie avec chaque release sur GitHub, qui contient le numero de version et les informations de telechargement.

### Cycle de vie d'une mise a jour

```
                    Application
                    demarre
                       |
                       v
              +------------------+
              | Attente 5 sec    |    (evite de ralentir le demarrage)
              +------------------+
                       |
                       v
              +------------------+
              | Verification     |    GET https://github.com/.../releases/latest
              | GitHub Releases  |    --> Lit le fichier latest.yml
              +------------------+
                    /         \
                   v           v
          +------------+  +-----------------+
          | A jour     |  | Mise a jour     |
          | (v1.0.0 =  |  | disponible      |
          |  v1.0.0)   |  | (v1.0.0 < 1.1.0)|
          +------------+  +-----------------+
                                  |
                                  v
                          +------------------+
                          | Telechargement   |    Telechargement automatique du .exe
                          | en arriere-plan  |    en arriere-plan avec progression
                          +------------------+
                                  |
                                  v
                          +------------------+
                          | Pret             |    Affichage du bouton "Redemarrer"
                          | a installer      |    dans l'interface
                          +------------------+
                                  |
                           (clic utilisateur)
                                  |
                                  v
                          +------------------+
                          | quitAndInstall   |    L'app se ferme, l'installeur
                          |                  |    s'execute, l'app redemarre
                          +------------------+
```

### Etats de la mise a jour (`UpdateStatus`)

Le service `updater.ts` communique l'etat au renderer via l'evenement IPC `updater:status`. Voici les etats possibles :

| Etat | Signification | Donnees associees |
|---|---|---|
| `checking` | Verification en cours aupres de GitHub | - |
| `available` | Nouvelle version detectee, telechargement lance | `version`, `releaseNotes` |
| `not-available` | L'application est deja a jour | `version` |
| `downloading` | Telechargement en cours | `percent`, `bytesPerSecond`, `transferred`, `total` |
| `downloaded` | Telechargement termine, pret a installer | `version` |
| `error` | Echec (reseau, GitHub inaccessible, etc.) | `message` |

### Configuration dans le code (`electron/services/updater.ts`)

Deux parametres importants :

```typescript
autoUpdater.autoDownload = false    // On controle manuellement le moment du telechargement
autoUpdater.autoInstallOnAppQuit = true  // Si une MaJ est telechargee, elle s'installe a la fermeture
```

`autoDownload = false` permet d'attendre que l'evenement `update-available` soit recu avant de lancer `downloadUpdate()`. Cela donne le controle sur le moment exact du telechargement et permet d'informer l'utilisateur.

### Source des mises a jour

La configuration se trouve dans `package.json`, section `build.publish` :

```json
"publish": [{
  "provider": "github",
  "owner": "King4Kats",
  "repo": "Clipr"
}]
```

`electron-updater` va chercher le fichier `latest.yml` a l'adresse :
`https://github.com/King4Kats/Clipr/releases/latest/download/latest.yml`

Ce fichier est genere automatiquement par `electron-builder` lors du build et contient le hash, la taille et l'URL du fichier d'installation.

---

## 5. Flux IPC detaille

### Logs

```
Renderer (SetupWizard.tsx)
  |
  | window.electron.sendLogs()
  v
Preload (preload.ts)
  |
  | ipcRenderer.invoke('logs:send')
  v
Main (main.ts)
  |
  | 1. dialog.showSaveDialog() --> dialogue "Enregistrer sous"
  | 2. exportLogs(savePath, onProgress)
  v
Service (log-sender.ts)
  |
  | 1. zipLogs() --> archive ZIP dans le dossier temporaire
  | 2. copyFileSync() --> copie vers l'emplacement choisi
  |
  | Progression envoyee via :
  |   mainWindow.webContents.send('logs:sendProgress', { percent, message })
  v
Resultat : { success: boolean, message: string }
```

### Mise a jour

```
Renderer (SetupWizard.tsx)
  |
  | window.electron.checkForUpdates()
  v
Preload (preload.ts)
  |
  | ipcRenderer.invoke('updater:check')
  v
Main (main.ts)
  |
  | checkForUpdates()
  v
Service (updater.ts)
  |
  | autoUpdater.checkForUpdates()
  |   --> Contacte GitHub Releases
  |   --> Evenements : checking -> available -> downloading -> downloaded
  |
  | Chaque evenement envoye via :
  |   mainWindow.webContents.send('updater:status', statusObject)
  v
Renderer recoit les evenements et met a jour l'affichage
```

---

## 6. Interface utilisateur (SetupWizard)

Le composant `SetupWizard.tsx` contient deux sections dediees :

### Section "Mise a jour"

- Affiche la version actuelle de l'application
- Bouton "Verifier" pour lancer une verification manuelle
- Affichage conditionnel selon l'etat :
  - Spinner pendant la verification
  - Barre de progression pendant le telechargement avec pourcentage
  - Bouton "Redemarrer" quand la mise a jour est prete
  - Coche verte si l'application est a jour
  - Message d'erreur en rouge en cas de probleme

### Section "Diagnostic"

- Affichage de l'UUID d'installation (8 premiers caracteres + bouton copier)
- Bouton "Exporter les logs" qui :
  - Ouvre un dialogue "Enregistrer sous"
  - Affiche un spinner pendant la compression
  - Affiche un message de succes/erreur apres l'export

---

## 7. Publication d'une nouvelle version

Resume du processus :

1. Incrementer la version dans `package.json` (suivre le semver : majeur.mineur.patch)
2. Builder l'application : `npm run build`
3. Les fichiers generes se trouvent dans `dist/` :
   - `Clipr-Setup-X.Y.Z.exe` : installeur Windows
   - `latest.yml` : fichier de metadonnees pour l'auto-updater
4. Creer une Release sur GitHub et y joindre ces deux fichiers
5. Les utilisateurs existants recevront la notification automatiquement au prochain lancement

**Point important :** Le fichier `latest.yml` est indispensable. Sans lui, `electron-updater` ne peut pas detecter la mise a jour. Ne jamais publier une release sans ce fichier.

---

## 8. Reference des fichiers

| Fichier | Responsabilite |
|---|---|
| `electron/services/logger.ts` | Configuration du logger : chemin, format, rotation, niveaux. Expose `logger` et `logSystemInfo()`. |
| `electron/services/log-sender.ts` | Generation de l'UUID d'installation, compression des logs en ZIP, export vers un emplacement choisi par l'utilisateur. |
| `electron/services/updater.ts` | Initialisation de l'auto-updater, ecoute des evenements, communication avec le renderer. Expose `initUpdater()`, `checkForUpdates()`, `installUpdate()`. |
| `electron/main.ts` | Enregistrement des handlers IPC pour les logs et les mises a jour. Appel de `logSystemInfo()` et `initUpdater()` au demarrage. |
| `electron/preload.ts` | Expose les fonctions au renderer : `sendLogs()`, `getInstallationId()`, `checkForUpdates()`, `installUpdate()`, `getAppVersion()`, `onUpdateStatus()`, `onLogSendProgress()`. |
| `src/types/index.ts` | Definitions TypeScript : type `UpdateStatus` et signatures des nouvelles methodes de `ElectronAPI`. |
| `src/components/SetupWizard.tsx` | Interface des sections "Mise a jour" et "Diagnostic". |

---

## 9. FAQ

**Ou se trouvent les logs sur la machine de l'utilisateur ?**
Dans `%APPDATA%/decoupeur-video/logs/main.log`. Ce chemin est accessible en tapant `%APPDATA%` dans la barre d'adresse de l'Explorateur Windows.

**Comment identifier une installation specifique ?**
Chaque installation possede un UUID unique stocke dans `%APPDATA%/decoupeur-video/installation-id.json`. Cet identifiant est inclus dans le ZIP exporte et affiche dans la section Diagnostic du SetupWizard.

**La verification de mise a jour ralentit-elle le demarrage ?**
Non. La verification est lancee avec un delai de 5 secondes (`setTimeout`) apres le demarrage, et s'execute en arriere-plan sans bloquer l'interface.

**Que se passe-t-il si GitHub est inaccessible ?**
L'erreur est enregistree dans les logs et l'etat `error` est envoye au renderer. L'application continue de fonctionner normalement. La verification sera retentee au prochain demarrage.

**Les logs contiennent-ils des donnees personnelles ?**
Non. Les logs contiennent uniquement des informations techniques : version de l'application, actions effectuees, erreurs rencontrees, informations systeme (OS, RAM, CPU). Aucun contenu de video ou de transcription n'est enregistre.

**La mise a jour est-elle obligatoire ?**
Non. L'utilisateur peut ignorer la notification. S'il ferme l'application alors qu'une mise a jour est telechargee, elle sera installee silencieusement au prochain lancement (grace a `autoInstallOnAppQuit = true`).

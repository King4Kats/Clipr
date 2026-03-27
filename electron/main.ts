import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu } from 'electron'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import fs from 'fs'

/**
 * MAIN.TS : Processus Principal (Main Process)
 * 
 * Point d'entrée de l'application gérant le cycle de vie des fenêtres
 * et l'enregistrement des canaux de communication IPC. Il orchestre
 * l'interaction entre les services système (FFmpeg, Whisper, Ollama) et l'UI.
 */

// Services
import { logger, logSystemInfo } from './services/logger.js'
import { getInstallationId, exportLogs } from './services/log-sender.js'
import { initUpdater, checkForUpdates, installUpdate } from './services/updater.js'
import { getVideoDuration, extractAudio, cutVideo, concatenateVideos, checkFFmpeg } from './services/ffmpeg.js'
import {
  setMainWindow,
  areModelsReady,
  getModelStatus,
  downloadWhisperModel,
  downloadLLMModel
} from './services/model-manager.js'
import {
  loadWhisperModel,
  transcribe as whisperTranscribe,
  cancelTranscription
} from './services/whisper.js'
import {
  checkOllama,
  listOllamaModels,
  pullOllamaModel,
  analyzeTranscript,
  ensureOllamaRunning,
  downloadAndInstallOllama
} from './services/ollama.js'
import {
  autoSaveProject,
  getProjectHistory,
  manualSaveProject,
  manualLoadProject,
  ProjectData
} from './services/project-history.js'

// Initialisation des logs du processus principal
const __dirname = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null


// Enregistrement d'un protocole personnalisé pour la diffusion des fichiers vidéo locaux.
// Cela permet de contourner les restrictions de sécurité du navigateur pour charger
// des fichiers depuis le disque tout en maintenant une Content Security Policy (CSP) stricte.
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-video', privileges: { stream: true, bypassCSP: true } }
])

/**
 * Configure le gestionnaire de protocole pour 'local-video://'.
 * Transforme les requêtes du rendu en flux de données Node.js.
 */
function registerVideoProtocol() {
  protocol.registerFileProtocol('local-video', (request, callback) => {
    let filePath = decodeURIComponent(request.url.replace('local-video://', ''))
    if (process.platform === 'win32' && filePath.startsWith('/') && filePath.includes(':')) {
      filePath = filePath.slice(1)
    }
    callback({ path: filePath })
  })
}

/**
 * Crée et configure la fenêtre principale de l'application.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false, // Sécurité : Désactivation de Node.js dans le rendu
      contextIsolation: true, // Sécurité : Isolation du contexte
      webSecurity: true
    },
    icon: join(__dirname, '../../src/assets/Clipr.ico'),
    titleBarStyle: 'default',
    show: false // La fenêtre n'est affichée que lorsqu'elle est prête (évite le flash blanc)
  })

  // Injection de la fenêtre dans le gestionnaire de modèles pour les retours de progression
  setMainWindow(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // En mode développement, on utilise le serveur de dev d'electron-vite
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools() // Ouverture automatique des outils de dev
  } else {
    // En production, on charge le fichier index.html généré
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Initialisation de l'application
app.whenReady().then(() => {
  // Logger les infos systeme au demarrage
  logSystemInfo()

  // Supprimer la barre de menu File/Edit/View/Window
  Menu.setApplicationMenu(null)

  registerVideoProtocol()
  createWindow()

  // Initialiser l'auto-updater
  if (mainWindow) {
    initUpdater(mainWindow)

    // Verification silencieuse des mises a jour au demarrage (delai de 5s)
    setTimeout(() => {
      checkForUpdates()
    }, 5000)
  }
})

// Gestion de la fermeture de toutes les fenêtres
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { // Sur macOS, les apps restent actives par convention
    app.quit()
  }
})

// Comportement lors de la réactivation de l'app (notamment sur macOS)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// ============================================
// GESTIONNAIRES IPC (INTER-PROCESS COMMUNICATION)
// ============================================

// --- Dialogues système (Ouverture/Sauvegarde de fichiers) ---

ipcMain.handle('dialog:openVideo', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: 'Vidéos', extensions: ['mp4', 'avi', 'mov', 'mkv', 'mts', 'webm'] }
    ]
  })
  return result.filePaths[0] || null
})

ipcMain.handle('dialog:openVideos', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Vidéos', extensions: ['mp4', 'avi', 'mov', 'mkv', 'mts', 'webm'] }
    ]
  })
  return result.filePaths
})

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory']
  })
  return result.filePaths[0] || null
})

ipcMain.handle('dialog:saveTextFile', async (_, content: string, defaultName: string) => {
  const { writeFileSync } = await import('fs')
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName,
    filters: [
      { name: 'Fichier texte', extensions: ['txt'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  writeFileSync(result.filePath, content, 'utf-8')
  return result.filePath
})

ipcMain.handle('file:readBuffer', async (_, filePath: string) => {
  const { readFileSync } = await import('fs')
  const buffer = readFileSync(filePath)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
})

// --- Opérations sur le système de fichiers et Shell ---

ipcMain.handle('shell:openFolder', async (_, folderPath: string) => {
  return shell.openPath(folderPath)
})

ipcMain.handle('shell:openDocumentation', async () => {
  const docPath = join(app.getAppPath(), 'docs', 'index.html')
  return shell.openPath(docPath)
})

// --- Gestion des chemins de l'application ---

ipcMain.handle('app:getPath', (_, name: 'temp' | 'userData' | 'downloads') => {
  return app.getPath(name)
})

// --- Services FFmpeg (Localisation et Traitement Vidéo) ---

ipcMain.handle('ffmpeg:getDuration', async (_, videoPath: string) => {
  return getVideoDuration(videoPath)
})

ipcMain.handle('ffmpeg:extractAudio', async (_, videoPath: string) => {
  logger.info('Début de l\'extraction audio pour :', videoPath)
  try {
    const result = await extractAudio(videoPath, (percent) => {
      sendProgress(percent, 'Extraction audio...')
    })
    logger.info('Extraction audio terminée :', result)
    return result
  } catch (error) {
    logger.error('Erreur FFmpeg lors de l\'extraction :', error)
    throw error
  }
})

ipcMain.handle('ffmpeg:cut', async (_, input: string, start: number, end: number, output: string) => {
  return cutVideo(input, start, end, output, 23, (percent) => {
    sendProgress(percent, 'Export en cours...')
  })
})

ipcMain.handle('ffmpeg:concatenate', async (_, inputPaths: string[], output: string) => {
  return concatenateVideos(inputPaths, output, (percent) => {
    sendProgress(percent, 'Concaténation en cours...')
  })
})

// --- Gestionnaires des Modèles IA ---

ipcMain.handle('models:getStatus', async () => {
  return getModelStatus()
})

ipcMain.handle('models:areReady', async () => {
  return areModelsReady()
})

ipcMain.handle('models:downloadWhisper', async (_, model?: string) => {
  try {
    await downloadWhisperModel(model)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('models:downloadLLM', async (_, model?: string) => {
  try {
    await downloadLLMModel(model)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// --- Services de Transcription Whisper (via script Python externe) ---

ipcMain.handle('whisper:loadModel', async (_, model: string) => {
  logger.info('Chargement du modèle Whisper :', model)
  await loadWhisperModel(model)
  return true
})

ipcMain.handle('whisper:transcribe', async (_, audioPath: string, language: string) => {
  logger.info('Début de la transcription :', audioPath, 'Langue :', language)

  try {
    sendProgress(10, 'Transcription en cours...')

    const segments = await whisperTranscribe(
      audioPath,
      language,
      (segment) => {
        // Send each segment to the renderer as it comes in
        mainWindow?.webContents.send('whisper:segment', segment)
      },
      (percent) => {
        // Send progress updates
        sendProgress(10 + (percent * 0.8), 'Transcription en cours...')
      }
    )

    sendProgress(100, 'Transcription terminée')
    logger.info(`Transcription terminée : ${segments.length} segments identifiés`)
    return segments
  } catch (error) {
    logger.error('Erreur de transcription :', error)
    throw error
  }
})

ipcMain.handle('whisper:cancel', async () => {
  logger.info('Annulation de la transcription en cours...')
  cancelTranscription()
})

// --- Services d'Analyse LLM (via l'API locale Ollama) ---


ipcMain.handle('ollama:listModels', async () => {
  // Return available models from Ollama
  return listOllamaModels()
})

ipcMain.handle('ollama:pull', async (_, modelName: string) => {
  logger.info('Téléchargement (pull) du modèle Ollama :', modelName)
  return pullOllamaModel(modelName)
})

ipcMain.handle('ollama:analyze', async (_, transcript: string, context: string, model: string) => {
  logger.info('Début de l\'analyse sémantique avec Ollama')
  return analyzeTranscript(transcript, context, model, (chunkIndex, totalChunks, segmentsSoFar, overrideMessage) => {
    const percent = 70 + Math.round(((chunkIndex + 1) / totalChunks) * 18) // 70-88%
    let message = totalChunks > 1
      ? `Analyse IA bloc ${chunkIndex + 1}/${totalChunks} — ${segmentsSoFar} segments trouvés...`
      : `Analyse IA en cours — ${segmentsSoFar} segments trouvés...`

    if (overrideMessage) message = overrideMessage

    sendProgress(percent, message)
  })
})

// --- Gestionnaire de Projet et Historique ---

ipcMain.handle('project:autoSave', async (_, data: Omit<ProjectData, 'timestamp'>) => {
  return autoSaveProject(data)
})

ipcMain.handle('project:getHistory', async () => {
  return getProjectHistory()
})

ipcMain.handle('project:saveManual', async (_, data: ProjectData) => {
  return manualSaveProject(data)
})

ipcMain.handle('project:loadManual', async () => {
  return manualLoadProject()
})

ipcMain.handle('ollama:check', async () => {
  return ensureOllamaRunning()
})

ipcMain.handle('ollama:install', async () => {
  return downloadAndInstallOllama((progress: number, message: string) => {
    sendProgress(progress, message)
  })
})

// --- Configuration et Vérification des Dépendances ---

ipcMain.handle('setup:checkDependencies', async () => {
  const ffmpegOk = await checkFFmpeg()
  const status = getModelStatus()

  return [
    {
      name: 'FFmpeg',
      installed: ffmpegOk,
      version: ffmpegOk ? 'bundled' : undefined
    },
    {
      name: 'Modèle Whisper',
      installed: status.whisper.downloaded,
      version: status.whisper.downloaded ? status.whisper.model : undefined,
      installInstructions: 'Cliquez sur "Télécharger" pour installer le modèle de transcription.'
    },
    {
      name: 'Modèle IA',
      installed: status.llm.downloaded,
      version: status.llm.downloaded ? status.llm.model : undefined,
      installInstructions: 'Cliquez sur "Télécharger" pour installer le modèle d\'analyse.'
    }
  ]
})

ipcMain.handle('setup:installWhisper', async () => {
  try {
    await downloadWhisperModel()
    return { success: true, message: 'Modèle Whisper téléchargé' }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
})

ipcMain.handle('setup:pullOllamaModel', async () => {
  try {
    await downloadLLMModel()
    return { success: true, message: 'Modèle IA téléchargé' }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
})

// --- Mise a jour automatique (Auto-Update) ---

ipcMain.handle('updater:check', async () => {
  await checkForUpdates()
})

ipcMain.handle('updater:install', () => {
  installUpdate()
})

ipcMain.handle('app:getVersion', () => {
  return app.getVersion()
})

// --- Diagnostic et Logs ---

ipcMain.handle('logs:getInstallationId', async () => {
  return getInstallationId()
})

ipcMain.handle('logs:send', async () => {
  const installId = getInstallationId()
  const defaultName = `clipr-logs-${installId.substring(0, 8)}.zip`

  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'Archive ZIP', extensions: ['zip'] }]
  })

  if (result.canceled || !result.filePath) {
    return { success: false, message: 'Export annule' }
  }

  return exportLogs(result.filePath, (percent, message) => {
    mainWindow?.webContents.send('logs:sendProgress', { percent, message })
  })
})

// ============================================
// FONCTIONS UTILITAIRES DE NOTIFICATION
// ============================================

/**
 * Envoie une notification de progression au processus de rendu.
 */
function sendProgress(progress: number, message: string) {
  mainWindow?.webContents.send('processing:progress', { progress, message })
}

export { sendProgress }
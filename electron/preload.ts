import { contextBridge, ipcRenderer } from 'electron'

/**
 * PRELOAD.TS : Pont de communication sécurisé (ContextBridge)
 * 
 * Ce script s'exécute dans un contexte isolé et expose de manière sélective
 * les fonctionnalités du processus principal (Node.js) au rendu (React).
 * Il assure la sécurité en empêchant l'accès direct aux APIs système.
 */

// Définition de l'interface de l'API exposée au frontend
export interface ElectronAPI {
  // --- Fenêtres de dialogue et Système de fichiers ---
  openVideoDialog: () => Promise<string | null>
  openVideosDialog: () => Promise<string[]>
  selectFolderDialog: () => Promise<string | null>
  openFolder: (path: string) => Promise<string>
  getAppPath: (name: 'temp' | 'userData' | 'downloads') => Promise<string>
  saveTextFile: (content: string, defaultName: string) => Promise<string | null>
  readFileBuffer: (filePath: string) => Promise<ArrayBuffer>

  // --- Traitement Vidéo (FFmpeg) ---
  getVideoDuration: (videoPath: string) => Promise<number>
  extractAudio: (videoPath: string) => Promise<string>
  cutVideo: (input: string, start: number, end: number, output: string) => Promise<void>
  convertToMp4: (videoPath: string) => Promise<string>
  concatenateVideos: (inputPaths: string[], output: string) => Promise<void>

  // --- Transcription Audio (Imagine Whisper) ---
  loadWhisperModel: (model: string) => Promise<void>
  transcribe: (audioPath: string, language: string) => Promise<void>
  cancelTranscription: () => Promise<void>

  // --- Analyse Sémantique (Ollama LLM) ---
  checkOllama: () => Promise<boolean>
  listOllamaModels: () => Promise<string[]>
  analyzeTranscript: (transcript: string, context: string, model: string) => Promise<unknown>

  // --- Configuration et Maintenance des Modèles ---
  checkDependencies: () => Promise<{ name: string; installed: boolean; version?: string; installInstructions?: string }[]>
  installWhisper: () => Promise<{ success: boolean; message: string }>
  installLLM: () => Promise<{ success: boolean; message: string }>
  pullOllamaModel: (modelName: string) => Promise<{ success: boolean; message: string }>
  getModelStatus: () => Promise<{ whisper: { model: string; downloaded: boolean }; llm: { model: string; downloaded: boolean } }>
  areModelsReady: () => Promise<boolean>
  installOllama: () => Promise<{ success: boolean; message: string }>

  // --- Gestion de Projet ---
  autoSaveProject: (data: any) => Promise<void>
  getProjectHistory: () => Promise<any[]>
  saveProject: (data: any) => Promise<string | null>
  loadProject: () => Promise<any | null>

  // --- Événements et Réception de Données ---
  onProgress: (callback: (data: { progress: number; message: string }) => void) => () => void
  onSegments: (callback: (segments: unknown[]) => void) => () => void
  onTranscriptSegment: (callback: (segment: unknown) => void) => () => void
  onModelProgress: (callback: (data: { type: 'whisper' | 'llm'; progress: number; message: string }) => void) => () => void

  // --- Mise a jour automatique ---
  checkForUpdates: () => Promise<void>
  installUpdate: () => Promise<void>
  getAppVersion: () => Promise<string>
  onUpdateStatus: (callback: (status: any) => void) => () => void

  // --- Diagnostic et Logs ---
  getInstallationId: () => Promise<string>
  sendLogs: () => Promise<{ success: boolean; message: string }>
  onLogSendProgress: (callback: (data: { percent: number; message: string }) => void) => () => void

  // --- Documentation ---
  openDocumentation: () => Promise<void>
}

const api: ElectronAPI = {
  // --- Implémentation des méthodes de dialogue ---
  openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo'),
  openVideosDialog: () => ipcRenderer.invoke('dialog:openVideos'),
  selectFolderDialog: () => ipcRenderer.invoke('dialog:selectFolder'),
  openFolder: (path) => ipcRenderer.invoke('shell:openFolder', path),
  getAppPath: (name) => ipcRenderer.invoke('app:getPath', name),
  saveTextFile: (content, defaultName) => ipcRenderer.invoke('dialog:saveTextFile', content, defaultName),
  readFileBuffer: (filePath) => ipcRenderer.invoke('file:readBuffer', filePath),

  // --- Implémentation des méthodes FFmpeg ---
  getVideoDuration: (videoPath) => ipcRenderer.invoke('ffmpeg:getDuration', videoPath),
  extractAudio: (videoPath) => ipcRenderer.invoke('ffmpeg:extractAudio', videoPath),
  cutVideo: (input, start, end, output) => ipcRenderer.invoke('ffmpeg:cut', input, start, end, output),
  convertToMp4: (videoPath) => ipcRenderer.invoke('ffmpeg:convertToMp4', videoPath),
  concatenateVideos: (inputPaths, output) => ipcRenderer.invoke('ffmpeg:concatenate', inputPaths, output),

  // --- Implémentation des méthodes Whisper ---
  loadWhisperModel: (model) => ipcRenderer.invoke('whisper:loadModel', model),
  transcribe: (audioPath, language) => ipcRenderer.invoke('whisper:transcribe', audioPath, language),
  cancelTranscription: () => ipcRenderer.invoke('whisper:cancel'),

  // --- Implémentation des méthodes Ollama/LLM ---
  checkOllama: () => ipcRenderer.invoke('ollama:check'),
  listOllamaModels: () => ipcRenderer.invoke('ollama:listModels'),
  analyzeTranscript: (transcript, context, model) =>
    ipcRenderer.invoke('ollama:analyze', transcript, context, model),

  // --- Implémentation des méthodes de Configuration ---
  checkDependencies: () => ipcRenderer.invoke('setup:checkDependencies'),
  installWhisper: () => ipcRenderer.invoke('setup:installWhisper'),
  installLLM: () => ipcRenderer.invoke('setup:pullOllamaModel'),
  pullOllamaModel: async (modelName) => {
    try {
      const ok = await ipcRenderer.invoke('ollama:pull', modelName)
      return { success: ok, message: ok ? 'Modèle téléchargé' : 'Échec du téléchargement' }
    } catch (e: any) {
      return { success: false, message: e.message || 'Erreur' }
    }
  },
  getModelStatus: () => ipcRenderer.invoke('models:getStatus'),
  areModelsReady: () => ipcRenderer.invoke('models:areReady'),
  installOllama: () => ipcRenderer.invoke('ollama:install'),

  // --- Implémentation des méthodes de Projet ---
  autoSaveProject: (data) => ipcRenderer.invoke('project:autoSave', data),
  getProjectHistory: () => ipcRenderer.invoke('project:getHistory'),
  saveProject: (data) => ipcRenderer.invoke('project:saveManual', data),
  loadProject: () => ipcRenderer.invoke('project:loadManual'),

  // --- Gestionnaires d'événements (Flux de données asynchrones) ---
  onProgress: (callback) => {
    const handler = (_: unknown, data: { progress: number; message: string }) => callback(data)
    ipcRenderer.on('processing:progress', handler)
    return () => ipcRenderer.removeListener('processing:progress', handler)
  },
  onSegments: (callback) => {
    const handler = (_: unknown, segments: unknown[]) => callback(segments)
    ipcRenderer.on('processing:segments', handler)
    return () => ipcRenderer.removeListener('processing:segments', handler)
  },
  onTranscriptSegment: (callback) => {
    const handler = (_: unknown, segment: unknown) => callback(segment)
    ipcRenderer.on('whisper:segment', handler)
    return () => ipcRenderer.removeListener('whisper:segment', handler)
  },
  onModelProgress: (callback) => {
    const handler = (_: unknown, data: { type: 'whisper' | 'llm'; progress: number; message: string }) => callback(data)
    ipcRenderer.on('model:progress', handler)
    return () => ipcRenderer.removeListener('model:progress', handler)
  },

  // --- Mise a jour automatique ---
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  onUpdateStatus: (callback) => {
    const handler = (_: unknown, status: any) => callback(status)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },

  // --- Diagnostic et Logs ---
  getInstallationId: () => ipcRenderer.invoke('logs:getInstallationId'),
  sendLogs: () => ipcRenderer.invoke('logs:send'),
  onLogSendProgress: (callback) => {
    const handler = (_: unknown, data: { percent: number; message: string }) => callback(data)
    ipcRenderer.on('logs:sendProgress', handler)
    return () => ipcRenderer.removeListener('logs:sendProgress', handler)
  },

  // --- Documentation ---
  openDocumentation: () => ipcRenderer.invoke('shell:openDocumentation')
}

contextBridge.exposeInMainWorld('electron', api)
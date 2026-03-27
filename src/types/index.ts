/**
 * TYPES/INDEX.TS : Définitions TypeScript de l'application
 *
 * Centralise tous les types et interfaces utilisés dans le frontend.
 * Définit les structures de données pour les vidéos, segments, transcriptions,
 * la configuration de l'application et l'API Electron exposée via le preload.
 */

/** Segment de texte transcrit par Whisper avec marqueurs temporels */
export interface TranscriptSegment {
  id: string
  start: number
  end: number
  text: string
}

/** Segment thématique généré par l'analyse IA (découpage logique) */
export interface VideoSegment {
  id: string
  title: string
  start: number
  end: number
  transcriptSegments: TranscriptSegment[]
  color: string
}

/** Fichier vidéo chargé dans l'application */
export interface VideoFile {
  path: string
  name: string
  duration: number
  size: number
  offset: number // Offset temporel dans la timeline globale (pour multi-vidéos)
}

/** Sous-découpe d'une vidéo pour l'export (un segment peut couvrir plusieurs vidéos) */
export interface VideoClip {
  videoIndex: number
  videoPath: string
  start: number // Temps local dans cette vidéo
  end: number   // Temps local dans cette vidéo
}

/** Étapes du workflow de traitement (machine à états) */
export type ProcessingStep =
  | 'idle'
  | 'extracting-audio'
  | 'transcribing'
  | 'analyzing'
  | 'ready'
  | 'exporting'
  | 'done'
  | 'error'

/** État de progression d'une étape de traitement */
export interface ProcessingProgress {
  step: ProcessingStep
  progress: number
  message: string
  details?: string
}

/** Configuration utilisateur de l'application */
export interface AppConfig {
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large'
  ollamaModel: string
  language: string
  outputQuality: number
  outputFolder: string | null
  context: string // Zone de contexte pour l'analyse IA
}

/** Résultat brut de l'analyse sémantique par Ollama */
export interface OllamaAnalysisResult {
  segments: Array<{
    title: string
    start: number
    end: number
    description?: string
  }>
}

/** État d'une dépendance logicielle (FFmpeg, Python, etc.) */
export interface DependencyStatus {
  name: string
  installed: boolean
  version?: string
  installInstructions?: string
}

/** État de téléchargement des modèles IA */
export interface ModelStatus {
  whisper: { model: string; downloaded: boolean }
  llm: { model: string; downloaded: boolean }
}

/** État du processus de mise à jour automatique */
export type UpdateStatus =
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | { status: 'not-available'; version: string }
  | { status: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

/** Interface de l'API Electron exposée au frontend via le preload script */
export interface ElectronAPI {
  // ─── Boîtes de dialogue système ───
  openVideoDialog: () => Promise<string | null>
  openVideosDialog: () => Promise<string[]>
  selectFolderDialog: () => Promise<string | null>
  openFolder: (path: string) => Promise<string>
  getAppPath: (name: 'temp' | 'userData' | 'downloads') => Promise<string>
  saveTextFile: (content: string, defaultName: string) => Promise<string | null>

  // ─── Lecture de fichiers ───
  readFileBuffer: (filePath: string) => Promise<ArrayBuffer>

  // ─── FFmpeg : manipulation vidéo ───
  getVideoDuration: (videoPath: string) => Promise<number>
  extractAudio: (videoPath: string) => Promise<string>
  cutVideo: (input: string, start: number, end: number, output: string) => Promise<void>
  concatenateVideos: (inputPaths: string[], output: string) => Promise<void>

  // ─── Whisper : transcription audio → texte ───
  loadWhisperModel: (model: string) => Promise<void>
  transcribe: (audioPath: string, language: string) => Promise<TranscriptSegment[]>
  cancelTranscription: () => Promise<void>

  // ─── Ollama/LLM : analyse sémantique du transcript ───
  checkOllama: () => Promise<boolean>
  listOllamaModels: () => Promise<string[]>
  analyzeTranscript: (transcript: string, context: string, model: string) => Promise<OllamaAnalysisResult>

  // ─── Setup & Modèles : vérification et installation des dépendances ───
  checkDependencies: () => Promise<DependencyStatus[]>
  installWhisper: () => Promise<{ success: boolean; message: string }>
  installLLM: () => Promise<{ success: boolean; message: string }>
  pullOllamaModel: (modelName: string) => Promise<{ success: boolean; message: string }>
  installOllama: () => Promise<{ success: boolean; message: string }>
  getModelStatus: () => Promise<ModelStatus>
  areModelsReady: () => Promise<boolean>

  // ─── Projet & Historique : sauvegarde et restauration ───
  autoSaveProject: (data: any) => Promise<void>
  getProjectHistory: () => Promise<any[]>
  saveProject: (data: any) => Promise<string | null>
  loadProject: () => Promise<any | null>

  // ─── Événements IPC : communication temps réel avec le processus principal ───
  onProgress: (callback: (data: { progress: number; message: string }) => void) => () => void
  onSegments: (callback: (segments: VideoSegment[]) => void) => () => void
  onTranscriptSegment: (callback: (segment: TranscriptSegment) => void) => () => void
  onModelProgress: (callback: (data: { type: 'whisper' | 'llm'; progress: number; message: string }) => void) => () => void

  // ─── Mise à jour automatique ───
  checkForUpdates: () => Promise<void>
  installUpdate: () => Promise<void>
  getAppVersion: () => Promise<string>
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void

  // ─── Diagnostic et Logs : support technique ───
  getInstallationId: () => Promise<string>
  sendLogs: () => Promise<{ success: boolean; message: string }>
  onLogSendProgress: (callback: (data: { percent: number; message: string }) => void) => () => void

  // ─── Documentation ───
  openDocumentation: () => Promise<void>
}

// Déclaration globale : rend l'API Electron accessible via window.electron
declare global {
  interface Window {
    electron: ElectronAPI
  }
}

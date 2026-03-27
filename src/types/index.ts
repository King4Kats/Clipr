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
  originalPath: string // Chemin original du fichier (avant conversion éventuelle)
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

/** Mode de travail après import vidéo */
export type WorkMode = 'choose' | 'manual' | 'ai'

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

/** Interface de l'API exposée au frontend via src/api.ts (HTTP + WebSocket) */
export interface CliprAPI {
  // ─── Upload et fichiers ───
  uploadVideos: (files: FileList | File[]) => Promise<any[]>
  readFileBuffer: (filePath: string) => Promise<ArrayBuffer>
  saveTextFile: (content: string, defaultName: string) => Promise<string | null>

  // ─── FFmpeg : manipulation vidéo ───
  getVideoDuration: (videoPath: string) => Promise<number>
  extractAudio: (videoPath: string) => Promise<string>
  cutVideo: (input: string, start: number, end: number, output: string) => Promise<void>
  convertToMp4: (videoPath: string) => Promise<string>
  concatenateVideos: (inputPaths: string[], output: string) => Promise<void>

  // ─── Whisper : transcription audio → texte ───
  loadWhisperModel: (model: string) => Promise<void>
  transcribe: (audioPath: string, language: string) => Promise<TranscriptSegment[]>
  cancelTranscription: () => Promise<void>

  // ─── Ollama/LLM : analyse sémantique ───
  checkOllama: () => Promise<boolean>
  listOllamaModels: () => Promise<string[]>
  analyzeTranscript: (transcript: string, context: string, model: string) => Promise<OllamaAnalysisResult>
  pullOllamaModel: (modelName: string) => Promise<{ success: boolean; message: string }>

  // ─── Setup & dépendances ───
  checkDependencies: () => Promise<DependencyStatus[]>
  installWhisper: () => Promise<{ success: boolean; message: string }>
  installLLM: () => Promise<{ success: boolean; message: string }>
  installOllama: () => Promise<{ success: boolean; message: string }>
  getModelStatus: () => Promise<ModelStatus>
  areModelsReady: () => Promise<boolean>

  // ─── Projet & Historique ───
  autoSaveProject: (data: any) => Promise<void>
  getProjectHistory: () => Promise<any[]>
  saveProject: (data: any) => Promise<string | null>
  loadProject: () => Promise<any | null>

  // ─── Export ───
  exportVideos: (segments: any[], videoFiles: any[], clipsData: any[][]) => Promise<any>

  // ─── Événements temps réel (WebSocket) ───
  onProgress: (callback: (data: { progress: number; message: string }) => void) => () => void
  onSegments: (callback: (segments: VideoSegment[]) => void) => () => void
  onTranscriptSegment: (callback: (segment: TranscriptSegment) => void) => () => void
  onModelProgress: (callback: (data: { type: 'whisper' | 'llm'; progress: number; message: string }) => void) => () => void

  // ─── Mise à jour (Docker rebuild) ───
  checkForUpdates: () => Promise<any>
  triggerUpdate: () => Promise<any>
  getAppVersion: () => Promise<string>
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void

  // ─── Diagnostic ───
  getInstallationId: () => Promise<string>
  sendLogs: () => Promise<{ success: boolean; message: string }>
  onLogSendProgress: (callback: (data: { percent: number; message: string }) => void) => () => void

  // ─── Stubs de compatibilité ───
  openFolder: (path: string) => Promise<string>
  getAppPath: (name: string) => Promise<string>
  selectFolderDialog: () => Promise<string | null>
  openVideoDialog: () => Promise<string | null>
  openVideosDialog: () => Promise<string[]>
  openDocumentation: () => Promise<void>
  installUpdate: () => Promise<void>
}

// Déclaration globale : rend l'API accessible via window.electron (compatibilité)
declare global {
  interface Window {
    electron: CliprAPI
  }
}

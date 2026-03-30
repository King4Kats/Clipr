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
  id?: string // Identifiant du fichier sur le serveur (filename)
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
  | 'queued'
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
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo'
  ollamaModel: string
  language: string
  outputQuality: number
  outputFolder: string | null
  context: string // Zone de contexte pour l'analyse IA
  whisperPrompt: string // Vocabulaire de domaine pour guider la transcription Whisper
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

/** Types pour la file d'attente IA */
export type TaskType = 'analysis' | 'transcription'
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface QueueTask {
  id: string
  user_id: string
  username?: string
  type: TaskType
  status: TaskStatus
  project_id: string | null
  config: any
  result: any | null
  progress: number
  progress_message: string | null
  position: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface QueueState {
  currentTask: QueueTask | null
  userTasks: QueueTask[]
  totalPending: number
}

/** Résultat d'une transcription standalone */
export interface TranscriptionResult {
  id: string
  task_id: string
  filename: string
  language: string
  whisper_model: string
  segments: TranscriptSegment[]
  duration: number
  created_at: string
}

export interface TranscriptionHistoryItem {
  id: string
  filename: string
  language: string
  whisper_model: string
  duration: number
  created_at: string
}

// L'API est exposee via src/api.ts comme window.electron pour compatibilite

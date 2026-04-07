/**
 * TRANSCRIPTION-PIPELINE.TS : Pipeline complet de transcription audio
 *
 * Ce fichier orchestre tout le processus de transcription d'un fichier audio/vidéo :
 *
 * Étapes du pipeline :
 * 1. Détection du format (vidéo ou audio ?)
 * 2. Si c'est une vidéo → extraction de la piste audio avec FFmpeg
 * 3. Transcription de l'audio avec Whisper (IA de reconnaissance vocale d'OpenAI)
 * 4. Sauvegarde de la transcription en base de données
 * 5. Diarisation : identification des différents locuteurs (qui parle quand ?)
 * 6. Identification des noms des locuteurs via Ollama (IA locale)
 *
 * Le résultat est une transcription avec des segments horodatés et des noms
 * de locuteurs, stockée dans la table "transcriptions" de la BDD.
 *
 * Ce fichier fournit aussi des fonctions utilitaires pour récupérer, supprimer
 * et exporter les transcriptions (formats texte et SRT pour les sous-titres).
 */

// extname() extrait l'extension d'un fichier (ex: "/video/test.mp4" → ".mp4")
import { extname } from 'path'
// Service FFmpeg : permet d'extraire l'audio d'une vidéo
import * as ffmpegService from './ffmpeg.js'
// Service Whisper : le moteur de transcription audio → texte
import * as whisperService from './whisper.js'
// Service de diarisation : identifie qui parle dans l'audio
import * as diarizationService from './diarization.js'
// Accès à la base de données SQLite
import { getDb } from './database.js'
// Fonction pour mettre à jour la progression de la tâche dans la queue
import { updateTaskProgress } from './task-queue.js'
// Fonctions de gestion des projets
import { getProject, saveProject, updateProjectStatus } from './project-history.js'
// Génération d'identifiants uniques
import { randomUUID } from 'crypto'
// Logger pour les messages de debug/info dans la console serveur
import { logger } from '../logger.js'

// Import du type QueueTask pour typer le paramètre de la fonction principale
import type { QueueTask } from './task-queue.js'

/**
 * Type de la fonction de broadcast qui envoie des événements en temps réel
 * aux clients connectés via WebSocket. Permet de notifier l'avancement.
 */
type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void

/**
 * Liste des extensions de fichiers vidéo supportées.
 * Si le fichier uploadé est une vidéo, on doit d'abord extraire sa piste audio
 * avant de pouvoir la transcrire avec Whisper.
 */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts']

/**
 * Fonction principale : exécute le pipeline complet de transcription.
 * C'est cette fonction qui est appelée par la task-queue quand une tâche
 * de type 'transcription' est lancée.
 *
 * @param task - La tâche de la queue contenant la configuration (chemin fichier, langue, etc.)
 * @param broadcastFn - Fonction pour envoyer des mises à jour en temps réel au client
 * @returns L'ID de la transcription créée
 */
export async function runTranscriptionPipeline(task: QueueTask, broadcastFn: BroadcastFn): Promise<{ transcriptionId: string }> {
  // On extrait les paramètres de configuration de la tâche
  const { user_id: userId, config } = task
  const filePath: string = config.filePath          // Chemin du fichier audio/vidéo sur le disque
  const filename: string = config.filename || 'audio' // Nom original du fichier (pour l'affichage)
  const language: string = config.language || 'fr'   // Langue de la transcription (français par défaut)
  const whisperModel: string = config.whisperModel || 'large-v3' // Modèle Whisper à utiliser
  const whisperPrompt: string = config.whisperPrompt || '' // Prompt initial pour guider Whisper

  if (!filePath) throw new Error('filePath requis')

  // On détermine si le fichier est une vidéo en regardant son extension
  const ext = extname(filePath).toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.includes(ext)

  // Par défaut, le chemin audio est le fichier lui-même (si c'est déjà un audio)
  let audioPath = filePath

  // ── ÉTAPE 1 : Extraction audio (uniquement si c'est une vidéo) ──
  if (isVideo) {
    // On notifie le client que l'extraction audio commence
    broadcastFn(userId, null, 'transcription:progress', {
      taskId: task.id,
      step: 'extracting-audio',
      progress: 0,
      message: 'Extraction de la piste audio...'
    })

    // FFmpeg extrait la piste audio de la vidéo et retourne le chemin du fichier audio
    // Le callback (percent) met à jour la progression en temps réel
    audioPath = await ffmpegService.extractAudio(filePath, (percent) => {
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'extracting-audio',
        progress: percent,
        message: 'Extraction audio...'
      })
      // L'extraction audio représente 15% de la progression totale (0-15%)
      updateTaskProgress(task.id, percent * 0.15, 'Extraction audio')
    })
  }

  // ── ÉTAPE 2 : Transcription avec Whisper ──
  broadcastFn(userId, null, 'transcription:progress', {
    taskId: task.id,
    step: 'transcribing',
    progress: 0,
    message: 'Transcription en cours...'
  })

  // Chargement du modèle Whisper en mémoire GPU (si pas déjà chargé)
  await whisperService.loadWhisperModel(whisperModel)

  // Tableau qui accumule les segments reçus en streaming (temps réel)
  const allSegments: any[] = []

  // Lancement de la transcription. Whisper envoie les segments un par un
  // via le callback onSegment, ce qui permet l'affichage en temps réel.
  const segments = await whisperService.transcribe(
    audioPath,
    language,
    // Callback appelé pour chaque segment transcrit (streaming)
    (segment) => {
      allSegments.push(segment)
      // On envoie chaque segment au client dès qu'il est prêt
      broadcastFn(userId, null, 'transcription:segment', {
        taskId: task.id,
        segment
      })
    },
    // Callback de progression (pourcentage)
    (percent) => {
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'transcribing',
        progress: percent,
        message: 'Transcription en cours...'
      })
      // La transcription représente 85% de la progression totale (15-100%)
      updateTaskProgress(task.id, 15 + percent * 0.85, 'Transcription')
    },
    whisperPrompt
  )

  // On préfère les segments reçus en streaming (plus fiables car reçus en temps réel)
  // Sinon, on utilise les segments retournés par la promesse
  const finalSegments = allSegments.length > 0 ? allSegments : segments

  // On calcule la durée totale de l'audio à partir du dernier segment
  const duration = finalSegments.length > 0
    ? Math.max(...finalSegments.map((s: any) => s.end || 0))
    : 0

  // ── ÉTAPE 3 : Sauvegarde en base de données ──
  // On sauvegarde AVANT la diarisation pour ne pas perdre la transcription
  // si la diarisation échoue (la diarisation est un bonus, pas essentielle)
  const transcriptionId = randomUUID()
  const db = getDb()

  db.prepare(
    `INSERT INTO transcriptions (id, user_id, task_id, filename, language, whisper_model, segments, duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    transcriptionId,
    userId,
    task.id,
    filename,
    language,
    whisperModel,
    JSON.stringify(finalSegments),
    duration,
    new Date().toISOString()
  )

  logger.info(`[Transcription] Completed: ${transcriptionId}, ${finalSegments.length} segments, ${duration.toFixed(1)}s`)

  // Si la transcription est liée à un projet, on met à jour le statut du fichier
  // dans le projet (passage de 'processing' à 'done')
  const projectId = config.projectId as string | undefined
  if (projectId) {
    const project = getProject(projectId)
    if (project) {
      // On cherche le fichier correspondant dans la liste des items du projet
      const items: any[] = (project.data as any).transcriptionItems || []
      const updatedItems = items.map((item: any) =>
        item.filename === filename
          ? { ...item, transcriptionId, status: 'done', duration }
          : item
      )
      // Si tous les fichiers sont terminés, on marque le projet comme 'done'
      const allDone = updatedItems.every((i: any) => i.status === 'done' || i.status === 'error')
      saveProject(projectId, { ...project.data, transcriptionItems: updatedItems })
      if (allDone) updateProjectStatus(projectId, 'done')
    }
  }

  // Notification au client que la transcription est terminée
  broadcastFn(userId, null, 'transcription:complete', {
    taskId: task.id,
    transcriptionId,
    segmentCount: finalSegments.length,
    duration,
    projectId,
    filename
  })

  // ── ÉTAPE 4 : Diarisation (identification des locuteurs) ──
  // On ne diarise que s'il y a au moins 2 segments (sinon pas d'intérêt)
  // Cette étape est optionnelle : si elle échoue, la transcription reste valide
  if (finalSegments.length >= 2) {
    try {
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'diarizing',
        progress: 0,
        message: 'Identification des locuteurs...'
      })

      // La diarisation analyse l'audio pour détecter les changements de locuteur
      // et associer chaque segment à un locuteur (SPEAKER_0, SPEAKER_1, etc.)
      const diarized = await diarizationService.diarize(
        audioPath,
        finalSegments,
        (percent) => {
          broadcastFn(userId, null, 'transcription:progress', {
            taskId: task.id,
            step: 'diarizing',
            progress: percent,
            message: 'Identification des locuteurs...'
          })
        }
      )

      // On copie les labels de locuteur (speaker) dans nos segments originaux
      for (let i = 0; i < finalSegments.length && i < diarized.length; i++) {
        if (diarized[i].speaker) finalSegments[i].speaker = diarized[i].speaker
      }

      // ── ÉTAPE 5 : Identification des noms via Ollama ──
      // On utilise une IA locale (Ollama) pour deviner les prénoms des locuteurs
      // à partir du contenu de la transcription ("Bonjour, je suis Philippe...")
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'identifying-speakers',
        progress: 0,
        message: 'Detection des noms...'
      })

      const ollamaModel = config.ollamaModel || 'llama3.1'
      // On demande à Ollama d'analyser les premières minutes pour trouver les noms
      const nameMapping = await diarizationService.identifySpeakerNames(finalSegments, ollamaModel)
      // On remplace les SPEAKER_0/SPEAKER_1 par les vrais noms dans les segments
      diarizationService.applySpeakerNames(finalSegments, nameMapping)

      // Mise à jour de la transcription en BDD avec les labels de locuteurs
      db.prepare('UPDATE transcriptions SET segments = ? WHERE id = ?')
        .run(JSON.stringify(finalSegments), transcriptionId)

      logger.info(`[Transcription] Diarization complete: ${Object.values(nameMapping).join(', ')}`)

      // On notifie le client pour qu'il rafraîchisse l'affichage avec les noms
      broadcastFn(userId, null, 'transcription:diarization-complete', {
        taskId: task.id,
        transcriptionId
      })
    } catch (err: any) {
      // Si la diarisation échoue, ce n'est pas grave : la transcription est déjà sauvée
      logger.warn('[Transcription] Diarization failed, transcription saved without speaker labels:', err.message)
      // On notifie quand même le client pour débloquer l'UI
      broadcastFn(userId, null, 'transcription:diarization-complete', {
        taskId: task.id,
        transcriptionId,
        error: err.message
      })
    }
  }

  return { transcriptionId }
}

/**
 * Récupère une transcription par son ID depuis la base de données.
 * Les segments JSON sont parsés pour être utilisables côté client.
 *
 * Contrôle d'accès : un utilisateur ne peut voir que ses propres transcriptions,
 * sauf s'il est admin (accès à toutes les transcriptions).
 *
 * @param id - ID de la transcription
 * @param userId - ID de l'utilisateur qui fait la demande
 * @param userRole - Rôle de l'utilisateur ('admin' ou autre)
 * @returns La transcription avec ses segments, ou null si non trouvée
 */
export function getTranscription(id: string, userId: string, userRole?: string): any | null {
  const db = getDb()
  // Les admins peuvent accéder à toutes les transcriptions
  const row = userRole === 'admin'
    ? db.prepare(`SELECT * FROM transcriptions WHERE id = ?`).get(id) as any
    : db.prepare(`SELECT * FROM transcriptions WHERE id = ? AND user_id = ?`).get(id, userId) as any
  if (!row) return null
  // On parse les segments JSON pour les transformer en tableau JavaScript
  return { ...row, segments: JSON.parse(row.segments) }
}

/**
 * Récupère l'historique des transcriptions d'un utilisateur.
 * Retourne une version allégée (sans les segments) pour l'affichage en liste.
 *
 * @param userId - ID de l'utilisateur
 * @param limit - Nombre maximum de résultats (par défaut 20)
 * @returns Liste des transcriptions triées par date décroissante
 */
export function getTranscriptionHistory(userId: string, limit: number = 20): any[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, filename, language, whisper_model, duration, created_at FROM transcriptions
     WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit) as any[]
  return rows
}

/**
 * Supprime une transcription de la base de données.
 * Seul le propriétaire peut supprimer sa transcription.
 *
 * @param id - ID de la transcription à supprimer
 * @param userId - ID de l'utilisateur qui demande la suppression
 * @returns true si la suppression a réussi, false sinon
 */
export function deleteTranscription(id: string, userId: string): boolean {
  const db = getDb()
  const result = db.prepare(
    `DELETE FROM transcriptions WHERE id = ? AND user_id = ?`
  ).run(id, userId)
  // result.changes vaut 1 si une ligne a été supprimée, 0 sinon
  return result.changes > 0
}

/**
 * Exporte une transcription au format texte lisible.
 * Chaque segment est formaté avec son horodatage et le nom du locuteur.
 * Exemple : "[0:00 → 0:05] Philippe : Bonjour à tous"
 *
 * @param segments - Tableau des segments de la transcription
 * @returns Le texte formaté
 */
export function exportAsText(segments: any[]): string {
  return segments.map((s: any) => {
    const start = formatTime(s.start)
    const end = formatTime(s.end)
    // On ajoute le nom du locuteur seulement s'il est défini
    const speaker = s.speaker ? `${s.speaker} : ` : ''
    return `[${start} → ${end}] ${speaker}${s.text}`
  }).join('\n')
}

/**
 * Exporte une transcription au format SRT (SubRip Subtitle).
 * C'est le format standard pour les sous-titres, compatible avec la plupart
 * des lecteurs vidéo (VLC, YouTube, etc.).
 *
 * Format SRT :
 * 1
 * 00:00:00,000 --> 00:00:05,000
 * Philippe : Bonjour à tous
 *
 * @param segments - Tableau des segments de la transcription
 * @returns Le contenu du fichier SRT
 */
export function exportAsSrt(segments: any[]): string {
  return segments.map((s: any, i: number) => {
    const start = formatSrtTime(s.start)
    const end = formatSrtTime(s.end)
    const speaker = s.speaker ? `${s.speaker} : ` : ''
    // Le format SRT exige un numéro séquentiel pour chaque sous-titre
    return `${i + 1}\n${start} --> ${end}\n${speaker}${s.text.trim()}\n`
  }).join('\n')
}

/**
 * Formate un temps en secondes vers un format lisible "H:MM:SS" ou "M:SS".
 * Utilisé pour l'export texte.
 * Exemple : 3661 → "1:01:01" | 65 → "1:05"
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  // On n'affiche les heures que si nécessaire
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Formate un temps en secondes vers le format SRT "HH:MM:SS,mmm".
 * Le format SRT utilise une virgule (pas un point) pour les millisecondes.
 * Exemple : 3661.5 → "01:01:01,500"
 */
function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  // On extrait les millisecondes à partir de la partie décimale
  const ms = Math.floor((seconds % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

/**
 * TRANSCRIPTION-PIPELINE.TS : Pipeline de transcription audio standalone
 *
 * Exécute : détection format → extraction audio (si vidéo) → transcription Whisper
 * Sauvegarde le résultat dans la table transcriptions.
 */

import { extname } from 'path'
import * as ffmpegService from './ffmpeg.js'
import * as whisperService from './whisper.js'
import * as diarizationService from './diarization.js'
import { getDb } from './database.js'
import { updateTaskProgress } from './task-queue.js'
import { getProject, saveProject, updateProjectStatus } from './project-history.js'
import { randomUUID } from 'crypto'
import { logger } from '../logger.js'

import type { QueueTask } from './task-queue.js'

type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts']

export async function runTranscriptionPipeline(task: QueueTask, broadcastFn: BroadcastFn): Promise<{ transcriptionId: string }> {
  const { user_id: userId, config } = task
  const filePath: string = config.filePath
  const filename: string = config.filename || 'audio'
  const language: string = config.language || 'fr'
  const whisperModel: string = config.whisperModel || 'large-v3'
  const whisperPrompt: string = config.whisperPrompt || ''

  if (!filePath) throw new Error('filePath requis')

  const ext = extname(filePath).toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.includes(ext)

  let audioPath = filePath

  // 1. Extract audio if video file
  if (isVideo) {
    broadcastFn(userId, null, 'transcription:progress', {
      taskId: task.id,
      step: 'extracting-audio',
      progress: 0,
      message: 'Extraction de la piste audio...'
    })

    audioPath = await ffmpegService.extractAudio(filePath, (percent) => {
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'extracting-audio',
        progress: percent,
        message: 'Extraction audio...'
      })
      updateTaskProgress(task.id, percent * 0.15, 'Extraction audio')
    })
  }

  // 2. Transcribe with Whisper
  broadcastFn(userId, null, 'transcription:progress', {
    taskId: task.id,
    step: 'transcribing',
    progress: 0,
    message: 'Transcription en cours...'
  })

  await whisperService.loadWhisperModel(whisperModel)

  const allSegments: any[] = []

  const segments = await whisperService.transcribe(
    audioPath,
    language,
    (segment) => {
      allSegments.push(segment)
      broadcastFn(userId, null, 'transcription:segment', {
        taskId: task.id,
        segment
      })
    },
    (percent) => {
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'transcribing',
        progress: percent,
        message: 'Transcription en cours...'
      })
      updateTaskProgress(task.id, 15 + percent * 0.85, 'Transcription')
    },
    whisperPrompt
  )

  // Use streamed segments if available, otherwise use returned segments
  const finalSegments = allSegments.length > 0 ? allSegments : segments

  // Compute duration from last segment
  const duration = finalSegments.length > 0
    ? Math.max(...finalSegments.map((s: any) => s.end || 0))
    : 0

  // 3. Save to transcriptions table FIRST (so transcription is not lost if diarization fails)
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

  // Mettre à jour le projet associé si présent
  const projectId = config.projectId as string | undefined
  if (projectId) {
    const project = getProject(projectId)
    if (project) {
      const items: any[] = (project.data as any).transcriptionItems || []
      const updatedItems = items.map((item: any) =>
        item.filename === filename
          ? { ...item, transcriptionId, status: 'done', duration }
          : item
      )
      const allDone = updatedItems.every((i: any) => i.status === 'done' || i.status === 'error')
      saveProject(projectId, { ...project.data, transcriptionItems: updatedItems })
      if (allDone) updateProjectStatus(projectId, 'done')
    }
  }

  broadcastFn(userId, null, 'transcription:complete', {
    taskId: task.id,
    transcriptionId,
    segmentCount: finalSegments.length,
    duration,
    projectId,
    filename
  })

  // 4. Speaker diarization (runs AFTER save — transcription is safe even if this fails)
  if (finalSegments.length >= 2) {
    try {
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'diarizing',
        progress: 0,
        message: 'Identification des locuteurs...'
      })

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

      // Copy speaker labels back to finalSegments
      for (let i = 0; i < finalSegments.length && i < diarized.length; i++) {
        if (diarized[i].speaker) finalSegments[i].speaker = diarized[i].speaker
      }

      // 5. Identify speaker names via Ollama
      broadcastFn(userId, null, 'transcription:progress', {
        taskId: task.id,
        step: 'identifying-speakers',
        progress: 0,
        message: 'Detection des noms...'
      })

      const ollamaModel = config.ollamaModel || 'llama3.1'
      const nameMapping = await diarizationService.identifySpeakerNames(finalSegments, ollamaModel)
      diarizationService.applySpeakerNames(finalSegments, nameMapping)

      // Update transcription in DB with speaker labels
      db.prepare('UPDATE transcriptions SET segments = ? WHERE id = ?')
        .run(JSON.stringify(finalSegments), transcriptionId)

      logger.info(`[Transcription] Diarization complete: ${Object.values(nameMapping).join(', ')}`)

      // Notify client to refresh with speaker data
      broadcastFn(userId, null, 'transcription:diarization-complete', {
        taskId: task.id,
        transcriptionId
      })
    } catch (err: any) {
      logger.warn('[Transcription] Diarization failed, transcription saved without speaker labels:', err.message)
      // Notify client diarization is done (even if failed) so UI doesn't stay stuck
      broadcastFn(userId, null, 'transcription:diarization-complete', {
        taskId: task.id,
        transcriptionId,
        error: err.message
      })
    }
  }

  return { transcriptionId }
}

// ── Get transcription result ──
export function getTranscription(id: string, userId: string, userRole?: string): any | null {
  const db = getDb()
  // Admin can access any transcription
  const row = userRole === 'admin'
    ? db.prepare(`SELECT * FROM transcriptions WHERE id = ?`).get(id) as any
    : db.prepare(`SELECT * FROM transcriptions WHERE id = ? AND user_id = ?`).get(id, userId) as any
  if (!row) return null
  return { ...row, segments: JSON.parse(row.segments) }
}

// ── Get transcription history ──
export function getTranscriptionHistory(userId: string, limit: number = 20): any[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, filename, language, whisper_model, duration, created_at FROM transcriptions
     WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit) as any[]
  return rows
}

// ── Delete transcription ──
export function deleteTranscription(id: string, userId: string): boolean {
  const db = getDb()
  const result = db.prepare(
    `DELETE FROM transcriptions WHERE id = ? AND user_id = ?`
  ).run(id, userId)
  return result.changes > 0
}

// ── Export transcription as text ──
export function exportAsText(segments: any[]): string {
  return segments.map((s: any) => {
    const start = formatTime(s.start)
    const end = formatTime(s.end)
    const speaker = s.speaker ? `${s.speaker} : ` : ''
    return `[${start} → ${end}] ${speaker}${s.text}`
  }).join('\n')
}

// ── Export transcription as SRT ──
export function exportAsSrt(segments: any[]): string {
  return segments.map((s: any, i: number) => {
    const start = formatSrtTime(s.start)
    const end = formatSrtTime(s.end)
    const speaker = s.speaker ? `${s.speaker} : ` : ''
    return `${i + 1}\n${start} --> ${end}\n${speaker}${s.text.trim()}\n`
  }).join('\n')
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

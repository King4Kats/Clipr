/**
 * TEXT-IMPORT.TS — Import de fichiers texte (.txt, .docx, .pdf) pour analyse.
 *
 * Extrait le texte d'un fichier uploade et cree une "transcription synthetique"
 * (segments fictifs decoupes par paragraphe) pour la reutiliser dans le flow
 * d'analyse semantique existant. Aucun audio, pas de Whisper.
 */

import { randomUUID } from 'crypto'
import { extname } from 'path'
import { getDb } from './database.js'
import { logger } from '../logger.js'

/**
 * Extrait le texte brut d'un buffer selon l'extension du fichier.
 * - .txt : decode UTF-8
 * - .docx : utilise mammoth (extraction simple sans formatage)
 * - .pdf : utilise pdf-parse
 */
export async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const ext = extname(filename).toLowerCase()
  if (ext === '.txt') {
    return buffer.toString('utf-8')
  }
  if (ext === '.docx') {
    // Import dynamique : evite de charger mammoth si pas utilise
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })
    return result.value
  }
  if (ext === '.pdf') {
    // pdf-parse expose une fonction par defaut
    const pdfParse = (await import('pdf-parse')).default as any
    const result = await pdfParse(buffer)
    return result.text
  }
  throw new Error(`Format non supporte : ${ext} (txt, docx, pdf uniquement)`)
}

/**
 * Decoupe un texte en paragraphes et cree un segment de transcription par
 * paragraphe. Les timestamps sont fictifs (1 paragraphe = 5 sec) — purement
 * indicatifs, l'utilisation est l'analyse, pas la lecture chronologique.
 */
export function textToSegments(text: string): Array<{ id: string; start: number; end: number; text: string; speaker: string }> {
  // Decoupe par double saut de ligne (paragraphes), filtre les vides, trim
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 0)

  // Si aucun double saut de ligne, on a un seul gros paragraphe — decoupe alors par phrase
  const chunks = paragraphs.length > 1 ? paragraphs : (
    text.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ÿ])/).map(s => s.trim()).filter(s => s.length > 0)
  )

  const SECS_PER_CHUNK = 5
  return chunks.map((t, i) => ({
    id: `seg-${i}`,
    start: i * SECS_PER_CHUNK,
    end: (i + 1) * SECS_PER_CHUNK,
    text: t,
    speaker: 'Texte',
  }))
}

/**
 * Cree une transcription synthetique en base a partir d'un texte importe.
 * Renvoie l'id de la transcription, utilisable comme une transcription Whisper.
 */
export function createTextTranscription(args: {
  userId: string
  filename: string
  text: string
}): { transcriptionId: string; segmentCount: number } {
  const db = getDb()
  const segments = textToSegments(args.text)
  const duration = segments.length * 5 // fictif, coherent avec textToSegments

  // Pour respecter la FK transcriptions.task_id, on cree une tache "completed"
  // factice. type='transcription' (autorise par la contrainte CHECK).
  const taskId = randomUUID()
  db.prepare(
    `INSERT INTO task_queue (id, user_id, type, status, config, progress, created_at, completed_at)
     VALUES (?, ?, 'transcription', 'completed', ?, 100, datetime('now'), datetime('now'))`
  ).run(taskId, args.userId, JSON.stringify({ source: 'text-import', filename: args.filename }))

  const transcriptionId = randomUUID()
  db.prepare(
    `INSERT INTO transcriptions (id, user_id, task_id, filename, language, whisper_model, segments, duration, created_at)
     VALUES (?, ?, ?, ?, 'fr', 'text-import', ?, ?, ?)`
  ).run(
    transcriptionId,
    args.userId,
    taskId,
    args.filename,
    JSON.stringify(segments),
    duration,
    new Date().toISOString()
  )

  logger.info(`[TextImport] ${args.filename} → ${segments.length} segments (${args.text.length} chars)`)
  return { transcriptionId, segmentCount: segments.length }
}

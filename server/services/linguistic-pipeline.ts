/**
 * LINGUISTIC-PIPELINE.TS : Pipeline de transcription linguistique
 *
 * Utilise WhisperX (Whisper + pyannote + timestamps mot par mot) :
 *   1. Extraction audio (si video)
 *   2. WhisperX : transcription + diarisation en un seul pass
 *   3. Premier speaker = meneur (francais)
 *   4. Construction des sequences : tours meneur = FR, tours autres = vernaculaire
 *   5. Allosaurus IPA sur les variantes vernaculaires
 *   6. Decoupe clips audio + save DB
 */

import { extname, join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { execSync, spawn } from 'child_process'
import * as ffmpegService from './ffmpeg.js'
import { getDb } from './database.js'
import { updateTaskProgress } from './task-queue.js'
import { getProject, saveProject, updateProjectStatus } from './project-history.js'
import { randomUUID } from 'crypto'
import { logger } from '../logger.js'

import type { QueueTask } from './task-queue.js'

type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts']
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')

interface LinguisticVariant {
  speaker: string
  ipa: string
  ipa_original: string
  audio: { start: number; end: number }
  audio_extract?: string
}

interface LinguisticSequence {
  id: string
  index: number
  french_text: string
  french_audio: { start: number; end: number }
  variants: LinguisticVariant[]
}

// ── Main pipeline ──
export async function runLinguisticPipeline(task: QueueTask, broadcastFn: BroadcastFn): Promise<{ linguisticId: string }> {
  const { user_id: userId, config } = task
  const filePath: string = config.filePath
  const filename: string = config.filename || 'audio'
  const language: string = config.language || 'fr'
  const whisperModel: string = config.whisperModel || 'large-v3'
  const numSpeakers: number = config.numSpeakers || 10

  if (!filePath) throw new Error('filePath requis')

  const ext = extname(filePath).toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.includes(ext)
  let audioPath = filePath

  // ── Step 1 : Extraction audio si video ──
  if (isVideo) {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'extracting-audio', progress: 0, message: 'Extraction audio...'
    })
    audioPath = await ffmpegService.extractAudio(filePath, (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'extracting-audio', progress: percent, message: 'Extraction audio...'
      })
      updateTaskProgress(task.id, percent * 0.05, 'Extraction audio')
    })
  }

  // ── Step 2 : WhisperX (transcription + diarisation en un pass) ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'transcribing', progress: 0, message: 'WhisperX : transcription + diarisation...'
  })

  const whisperxResult = await runWhisperX(audioPath, whisperModel, language, numSpeakers, (percent) => {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'transcribing', progress: percent, message: 'WhisperX...'
    })
    updateTaskProgress(task.id, 5 + percent * 0.45, 'WhisperX')
  })

  if (!whisperxResult || whisperxResult.segments.length === 0) {
    throw new Error('WhisperX n\'a produit aucun segment')
  }

  const allSegments = whisperxResult.segments
  const speakers = whisperxResult.speakers
  const duration = allSegments.length > 0 ? Math.max(...allSegments.map((s: any) => s.end || 0)) : 0

  logger.info(`[Linguistic] WhisperX : ${allSegments.length} segments, ${speakers.length} speakers: ${speakers.join(', ')}`)

  // ── Step 3 : Premier speaker = meneur ──
  const leaderSpeaker = config.leaderSpeaker || allSegments[0]?.speaker || speakers[0] || 'SPEAKER_00'
  logger.info(`[Linguistic] Meneur : ${leaderSpeaker}`)

  // ── Step 4 : Construire les tours de parole ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'segmenting', progress: 0, message: 'Construction des sequences...'
  })

  // Grouper les segments contigus du meme speaker en tours
  interface Turn { speaker: string; start: number; end: number; text: string }
  const turns: Turn[] = []
  for (const seg of allSegments) {
    const sp = seg.speaker || 'UNKNOWN'
    const last = turns[turns.length - 1]
    if (last && last.speaker === sp && seg.start - last.end < 1.5) {
      last.end = seg.end
      last.text += ' ' + (seg.text || '').trim()
    } else {
      turns.push({ speaker: sp, start: seg.start, end: seg.end, text: (seg.text || '').trim() })
    }
  }

  logger.info(`[Linguistic] ${turns.length} tours de parole`)

  // Construire les sequences
  let sequences: LinguisticSequence[] = []
  let currentSeq: LinguisticSequence | null = null

  for (const turn of turns) {
    if (turn.speaker === leaderSpeaker) {
      // Chaque tour du meneur = UNE nouvelle sequence (jamais de merge)
      if (currentSeq) sequences.push(currentSeq)
      currentSeq = {
        id: randomUUID(),
        index: sequences.length,
        french_text: turn.text,
        french_audio: { start: turn.start, end: turn.end },
        variants: []
      }
    } else if (currentSeq && turn.end - turn.start >= 1.0) {
      currentSeq.variants.push({
        speaker: turn.speaker,
        ipa: '',
        ipa_original: '',
        audio: { start: turn.start, end: turn.end }
      })
    }
  }
  if (currentSeq) sequences.push(currentSeq)

  // Filtrer les sequences sans variantes (garder celles avec au moins 1)
  sequences = sequences.filter(s => s.variants.length >= 1)
  sequences.forEach((s, i) => s.index = i)

  logger.info(`[Linguistic] ${sequences.length} sequences (${sequences.reduce((s, q) => s + q.variants.length, 0)} variantes)`)

  updateTaskProgress(task.id, 50, 'IPA')

  // ── Step 5 : Allosaurus IPA sur les variantes ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'phonetizing', progress: 0, message: 'Transcription phonetique (IPA)...'
  })

  const ipaSegments = sequences.flatMap((seq, si) =>
    seq.variants.map((v, vi) => ({ id: `${si}_${vi}`, start: v.audio.start, end: v.audio.end }))
  )

  if (ipaSegments.length > 0) {
    const ipaResults = await runPhonetize(audioPath, ipaSegments, (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'phonetizing', progress: percent, message: 'Transcription IPA...'
      })
      updateTaskProgress(task.id, 50 + percent * 0.25, 'IPA')
    })

    const ipaMap = new Map(ipaResults.map((r: any) => [r.id, r.ipa]))
    for (let si = 0; si < sequences.length; si++) {
      for (let vi = 0; vi < sequences[si].variants.length; vi++) {
        const ipa = ipaMap.get(`${si}_${vi}`) || ''
        sequences[si].variants[vi].ipa = ipa
        sequences[si].variants[vi].ipa_original = ipa
      }
    }
  }

  // ── Step 6 : Extraits audio ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'extracting-clips', progress: 0, message: 'Extraction extraits audio...'
  })

  const linguisticId = randomUUID()
  const clipDir = join(DATA_DIR, 'linguistic', linguisticId)
  mkdirSync(clipDir, { recursive: true })

  for (let si = 0; si < sequences.length; si++) {
    const seq = sequences[si]
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ss ${seq.french_audio.start} -to ${seq.french_audio.end} -ar 16000 -ac 1 "${join(clipDir, `seq_${si}_fr.wav`)}" 2>/dev/null`)
    } catch {}
    for (let vi = 0; vi < seq.variants.length; vi++) {
      const v = seq.variants[vi]
      try {
        execSync(`ffmpeg -y -i "${audioPath}" -ss ${v.audio.start} -to ${v.audio.end} -ar 16000 -ac 1 "${join(clipDir, `seq_${si}_var_${vi}.wav`)}" 2>/dev/null`)
        v.audio_extract = `seq_${si}_var_${vi}.wav`
      } catch {}
    }
  }

  updateTaskProgress(task.id, 90, 'Sauvegarde')

  // ── Step 7 : Save DB ──
  const db = getDb()
  db.prepare(
    `INSERT INTO linguistic_transcriptions (id, user_id, task_id, filename, leader_speaker, sequences, speakers, duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(linguisticId, userId, task.id, filename, leaderSpeaker,
    JSON.stringify(sequences), JSON.stringify(speakers), duration, new Date().toISOString())

  const projectId = config.projectId as string | undefined
  if (projectId) {
    const project = getProject(projectId)
    if (project) {
      saveProject(projectId, { ...project.data, linguisticId, sequenceCount: sequences.length })
      updateProjectStatus(projectId, 'done')
    }
  }

  logger.info(`[Linguistic] Termine : ${linguisticId}, ${sequences.length} sequences, ${duration.toFixed(1)}s`)

  broadcastFn(userId, null, 'linguistic:complete', {
    taskId: task.id, linguisticId, sequenceCount: sequences.length, duration, projectId, filename
  })

  return { linguisticId }
}

// ── Spawn whisperx-diarize.py ──
function runWhisperX(
  audioPath: string, model: string, language: string, numSpeakers: number,
  onProgress: (percent: number) => void
): Promise<{ segments: any[]; speakers: string[] } | null> {
  return new Promise((resolve) => {
    const scriptPath = join(process.cwd(), 'scripts', 'whisperx-diarize.py')
    if (!existsSync(scriptPath)) {
      logger.error('Script whisperx-diarize.py introuvable')
      resolve(null)
      return
    }

    const outputPath = join(DATA_DIR, 'temp', `whisperx_${Date.now()}.json`)
    const hfToken = process.env.HF_TOKEN || ''

    const args = [
      scriptPath, audioPath,
      '--output', outputPath,
      '--model', model,
      '--language', language,
      '--hf-token', hfToken,
      '--num-speakers', String(numSpeakers)
    ]

    logger.info(`=== WhisperX : ${audioPath} | model=${model} | speakers=${numSpeakers} ===`)

    const proc = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdoutData = ''

    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[WhisperX]', line.replace('ERROR:', '').trim())
        } else if (line.startsWith('STATUS:')) {
          logger.info('[WhisperX]', line.trim())
        } else if (line.trim() && !line.includes('UserWarning') && !line.includes('FutureWarning')) {
          logger.info('[WhisperX]', line.trim())
        }
      }
    })

    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    proc.on('close', (code) => {
      try { execSync('sleep 2') } catch {}

      if (code === 0) {
        try {
          const result = JSON.parse(stdoutData.trim())
          if (result.segments) { resolve(result); return }
        } catch {}
        try {
          if (existsSync(outputPath)) {
            const data = JSON.parse(readFileSync(outputPath, 'utf-8'))
            try { unlinkSync(outputPath) } catch {}
            resolve(data)
            return
          }
        } catch {}
      }
      logger.error(`[WhisperX] Code sortie ${code}`)
      resolve(null)
    })

    proc.on('error', () => resolve(null))
  })
}

// ── Spawn phonetize.py ──
function runPhonetize(
  audioPath: string,
  segments: { id: string; start: number; end: number }[],
  onProgress: (percent: number) => void
): Promise<any[]> {
  return new Promise((resolve) => {
    const scriptPath = join(process.cwd(), 'scripts', 'phonetize.py')
    if (!existsSync(scriptPath)) {
      resolve(segments.map(s => ({ id: s.id, ipa: '' })))
      return
    }

    const ts = Date.now()
    const segPath = join(DATA_DIR, 'temp', `phon_input_${ts}.json`)
    const outPath = join(DATA_DIR, 'temp', `phon_output_${ts}.json`)
    writeFileSync(segPath, JSON.stringify(segments), 'utf-8')

    const proc = spawn('python3', [scriptPath, audioPath, '--segments', segPath, '--output', outPath],
      { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdoutData = ''

    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[Phonetize]', line.replace('ERROR:', '').trim())
        } else if (line.trim() && !line.includes('UserWarning')) {
          logger.info('[Phonetize]', line.trim())
        }
      }
    })

    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    proc.on('close', (code) => {
      try { unlinkSync(segPath) } catch {}
      try { execSync('sleep 2') } catch {}
      if (code === 0) {
        try { const r = JSON.parse(stdoutData.trim()); if (Array.isArray(r)) { resolve(r); return } } catch {}
        try { if (existsSync(outPath)) { const d = JSON.parse(readFileSync(outPath, 'utf-8')); try { unlinkSync(outPath) } catch {}; resolve(d); return } } catch {}
      }
      resolve(segments.map(s => ({ id: s.id, ipa: '' })))
    })

    proc.on('error', () => resolve(segments.map(s => ({ id: s.id, ipa: '' }))))
  })
}

// ── CRUD helpers ──
export function getLinguisticTranscription(id: string, userId: string, userRole?: string): any | null {
  const db = getDb()
  const row = userRole === 'admin'
    ? db.prepare('SELECT * FROM linguistic_transcriptions WHERE id = ?').get(id) as any
    : db.prepare('SELECT * FROM linguistic_transcriptions WHERE id = ? AND user_id = ?').get(id, userId) as any
  if (!row) return null
  return { ...row, sequences: JSON.parse(row.sequences), speakers: JSON.parse(row.speakers) }
}

export function getLinguisticHistory(userId: string, limit: number = 20): any[] {
  const db = getDb()
  return db.prepare(
    'SELECT id, filename, leader_speaker, duration, created_at FROM linguistic_transcriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, limit) as any[]
}

export function deleteLinguisticTranscription(id: string, userId: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM linguistic_transcriptions WHERE id = ? AND user_id = ?').run(id, userId)
  try { execSync(`rm -rf "${join(DATA_DIR, 'linguistic', id)}"`) } catch {}
  return result.changes > 0
}

export function updateLinguisticSequence(id: string, seqIdx: number, updates: any): any | null {
  const db = getDb()
  const row = db.prepare('SELECT sequences FROM linguistic_transcriptions WHERE id = ?').get(id) as any
  if (!row) return null
  const sequences = JSON.parse(row.sequences)
  if (seqIdx < 0 || seqIdx >= sequences.length) return null
  if (updates.french_text !== undefined) sequences[seqIdx].french_text = updates.french_text
  if (updates.variant_idx !== undefined && updates.ipa !== undefined) {
    const vi = updates.variant_idx
    if (vi >= 0 && vi < sequences[seqIdx].variants.length) sequences[seqIdx].variants[vi].ipa = updates.ipa
  }
  db.prepare('UPDATE linguistic_transcriptions SET sequences = ? WHERE id = ?').run(JSON.stringify(sequences), id)
  return sequences
}

export function updateLinguisticLeader(id: string, newLeader: string): any | null {
  getDb().prepare('UPDATE linguistic_transcriptions SET leader_speaker = ? WHERE id = ?').run(newLeader, id)
  return { success: true }
}

export function renameLinguisticSpeaker(id: string, oldName: string, newName: string): any | null {
  const db = getDb()
  const row = db.prepare('SELECT sequences, speakers, leader_speaker FROM linguistic_transcriptions WHERE id = ?').get(id) as any
  if (!row) return null
  let sequences = JSON.parse(row.sequences)
  let speakers = JSON.parse(row.speakers)
  let leader = row.leader_speaker
  for (const seq of sequences) { for (const v of seq.variants) { if (v.speaker === oldName) v.speaker = newName } }
  speakers = speakers.map((s: string) => s === oldName ? newName : s)
  if (leader === oldName) leader = newName
  db.prepare('UPDATE linguistic_transcriptions SET sequences = ?, speakers = ?, leader_speaker = ? WHERE id = ?')
    .run(JSON.stringify(sequences), JSON.stringify(speakers), leader, id)
  return { sequences, speakers, leader_speaker: leader }
}

export function exportLinguistic(id: string, format: string = 'json'): { content: string; mime: string; ext: string } {
  const db = getDb()
  const row = db.prepare('SELECT * FROM linguistic_transcriptions WHERE id = ?').get(id) as any
  if (!row) throw new Error('Transcription introuvable')
  const sequences = JSON.parse(row.sequences) as LinguisticSequence[]
  if (format === 'csv') {
    const lines = ['Sequence;Francais;Locuteur;IPA;Debut;Fin']
    for (const seq of sequences) {
      for (const v of seq.variants) {
        lines.push(`${seq.index + 1};"${seq.french_text}";"${v.speaker}";"${v.ipa}";${v.audio.start};${v.audio.end}`)
      }
    }
    return { content: lines.join('\n'), mime: 'text/csv; charset=utf-8', ext: 'csv' }
  }
  return {
    content: JSON.stringify({ filename: row.filename, leader: row.leader_speaker, sequences }, null, 2),
    mime: 'application/json; charset=utf-8', ext: 'json'
  }
}

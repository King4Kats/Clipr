/**
 * LINGUISTIC-PIPELINE.TS : Pipeline de transcription linguistique
 *
 * Approche par detection de silences + diarisation ciblee :
 *   1. Extraction audio (si video)
 *   2. silence-segment.py : decoupe par les silences reels → blocs de parole → sequences
 *   3. Whisper batch sur les blocs meneur (1er bloc de chaque sequence) → texte FR
 *   4. Diarisation (pyannote via WhisperX) sur les variantes → identifier les speakers
 *   5. Allosaurus IPA sur les variantes
 *   6. Decoupe clips audio + save DB
 */

import { extname, join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { execSync, spawn } from 'child_process'
import * as ffmpegService from './ffmpeg.js'
import * as whisperService from './whisper.js'
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

  // ── Step 2 : Segmentation par silences ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'segmenting', progress: 0, message: 'Detection des silences et segmentation...'
  })

  const silenceResult = await runSilenceSegment(audioPath, (percent) => {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'segmenting', progress: percent, message: 'Segmentation par silences...'
    })
    updateTaskProgress(task.id, 5 + percent * 0.10, 'Segmentation')
  })

  if (!silenceResult || silenceResult.sequences.length === 0) {
    throw new Error('Aucune sequence detectee dans l\'audio')
  }

  logger.info(`[Linguistic] Silence detect : ${silenceResult.sequences.length} sequences, ${silenceResult.speech_blocks.length} blocs`)

  // Construire les sequences a partir du silence detect
  let sequences: LinguisticSequence[] = silenceResult.sequences.map((seq: any, i: number) => ({
    id: randomUUID(),
    index: i,
    french_text: '', // sera rempli par Whisper
    french_audio: { start: seq.leader.start, end: seq.leader.end },
    variants: seq.variants.map((v: any) => ({
      speaker: `LOCUTEUR`,
      ipa: '',
      ipa_original: '',
      audio: { start: v.start, end: v.end }
    }))
  }))

  // Filtrer sequences avec au moins 1 variante
  sequences = sequences.filter(s => s.variants.length >= 1)
  sequences.forEach((s, i) => s.index = i)

  const duration = silenceResult.stats?.total_duration || 0
  logger.info(`[Linguistic] ${sequences.length} sequences, ${sequences.reduce((s, q) => s + q.variants.length, 0)} variantes`)

  // ── Step 3 : Whisper batch sur les blocs meneur → texte FR ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'transcribing', progress: 0, message: 'Transcription francais (meneur)...'
  })

  const tempDir = join(DATA_DIR, 'temp')
  const frClips: { id: string; audioPath: string }[] = []

  for (let si = 0; si < sequences.length; si++) {
    const seq = sequences[si]
    const clipPath = join(tempDir, `ling_fr_${task.id}_${si}.wav`)
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ss ${seq.french_audio.start} -to ${seq.french_audio.end} -ar 16000 -ac 1 "${clipPath}" 2>/dev/null`)
      frClips.push({ id: `fr_${si}`, audioPath: clipPath })
    } catch {}
  }

  await whisperService.loadWhisperModel(whisperModel)
  const frResults = await whisperService.transcribeBatch(
    frClips, language,
    (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'transcribing', progress: percent, message: `Transcription FR (${frClips.length} phrases)...`
      })
      updateTaskProgress(task.id, 15 + percent * 0.20, 'Transcription FR')
    }
  )

  // Nettoyer clips + extraire texte
  for (const clip of frClips) { try { unlinkSync(clip.audioPath) } catch {} }
  for (let si = 0; si < sequences.length; si++) {
    const segs = frResults.get(`fr_${si}`)
    sequences[si].french_text = segs && segs.length > 0
      ? segs.map(s => s.text).join(' ').trim()
      : '(transcription echouee)'
  }

  updateTaskProgress(task.id, 35, 'Diarisation')

  // ── Step 4 : Diarisation pyannote sur les variantes → identifier les speakers ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'diarizing', progress: 0, message: 'Identification des locuteurs (pyannote)...'
  })

  // Creer un audio concat de toutes les variantes pour diarisation
  // On utilise WhisperX sur l'audio complet pour avoir les speakers
  const whisperxResult = await runWhisperX(audioPath, 'tiny', language, numSpeakers, (percent) => {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'diarizing', progress: percent, message: 'Diarisation pyannote...'
    })
    updateTaskProgress(task.id, 35 + percent * 0.15, 'Diarisation')
  })

  // Assigner les speakers aux variantes par overlap temporel
  if (whisperxResult && whisperxResult.segments.length > 0) {
    for (const seq of sequences) {
      for (const variant of seq.variants) {
        // Trouver le speaker dominant dans la plage de cette variante
        const overlaps: Record<string, number> = {}
        for (const wxSeg of whisperxResult.segments) {
          const overlap = Math.max(0,
            Math.min(variant.audio.end, wxSeg.end) - Math.max(variant.audio.start, wxSeg.start)
          )
          if (overlap > 0 && wxSeg.speaker) {
            overlaps[wxSeg.speaker] = (overlaps[wxSeg.speaker] || 0) + overlap
          }
        }
        // Speaker avec le plus d'overlap
        const bestSpeaker = Object.entries(overlaps).sort((a, b) => b[1] - a[1])[0]
        if (bestSpeaker) variant.speaker = bestSpeaker[0]
      }
    }
    logger.info(`[Linguistic] Speakers assignes via pyannote`)
  }

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

  // ── Step 6 : Extraits audio (asynchrone pour ne pas bloquer le serveur) ──
  const linguisticId = randomUUID()
  const clipDir = join(DATA_DIR, 'linguistic', linguisticId)
  mkdirSync(clipDir, { recursive: true })

  // Helper asynchrone pour ffmpeg (ne bloque pas le event loop)
  const ffmpegClip = (src: string, start: number, end: number, dest: string): Promise<void> =>
    new Promise((resolve) => {
      const { exec: execAsync } = require('child_process')
      execAsync(`ffmpeg -y -i "${src}" -ss ${start} -to ${end} -ar 16000 -ac 1 "${dest}" 2>/dev/null`, () => resolve())
    })

  // Extraire les clips par lots de 5 pour ne pas saturer
  const allClipJobs: Array<() => Promise<void>> = []

  for (let si = 0; si < sequences.length; si++) {
    const seq = sequences[si]
    allClipJobs.push(() => ffmpegClip(audioPath, seq.french_audio.start, seq.french_audio.end, join(clipDir, `seq_${si}_fr.wav`)))
    for (let vi = 0; vi < seq.variants.length; vi++) {
      const v = seq.variants[vi]
      const clipName = `seq_${si}_var_${vi}.wav`
      allClipJobs.push(async () => {
        await ffmpegClip(audioPath, v.audio.start, v.audio.end, join(clipDir, clipName))
        v.audio_extract = clipName
      })
    }
  }

  // Executer par lots de 5
  for (let i = 0; i < allClipJobs.length; i += 5) {
    await Promise.all(allClipJobs.slice(i, i + 5).map(fn => fn()))
  }

  updateTaskProgress(task.id, 90, 'Sauvegarde')

  // ── Step 7 : Save DB ──
  const speakers = [...new Set(sequences.flatMap(s => s.variants.map(v => v.speaker)))]
  const db = getDb()
  db.prepare(
    `INSERT INTO linguistic_transcriptions (id, user_id, task_id, filename, leader_speaker, sequences, speakers, duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(linguisticId, userId, task.id, filename, 'meneur',
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

// ── Spawn silence-segment.py ──
function runSilenceSegment(
  audioPath: string,
  onProgress: (percent: number) => void
): Promise<any | null> {
  return new Promise((resolve) => {
    const scriptPath = join(process.cwd(), 'scripts', 'silence-segment.py')
    if (!existsSync(scriptPath)) {
      logger.error('Script silence-segment.py introuvable')
      resolve(null)
      return
    }

    const outputPath = join(DATA_DIR, 'temp', `silence_${Date.now()}.json`)

    const proc = spawn('python3', [
      scriptPath, audioPath, '--output', outputPath, '--sequence-gap', '5.0'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdoutData = ''

    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('STATUS:')) {
          logger.info('[SilenceSegment]', line.trim())
        }
      }
    })

    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdoutData.trim())
          resolve(result)
          return
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
      logger.error(`[SilenceSegment] Code sortie ${code}`)
      resolve(null)
    })

    proc.on('error', () => resolve(null))
  })
}

// ── Spawn whisperx-diarize.py (pour la diarisation seulement) ──
function runWhisperX(
  audioPath: string, model: string, language: string, numSpeakers: number,
  onProgress: (percent: number) => void
): Promise<{ segments: any[]; speakers: string[] } | null> {
  return new Promise((resolve) => {
    const scriptPath = join(process.cwd(), 'scripts', 'whisperx-diarize.py')
    if (!existsSync(scriptPath)) {
      resolve(null)
      return
    }

    const outputPath = join(DATA_DIR, 'temp', `whisperx_${Date.now()}.json`)
    const hfToken = process.env.HF_TOKEN || ''

    const proc = spawn('python3', [
      scriptPath, audioPath, '--output', outputPath,
      '--model', model, '--language', language,
      '--hf-token', hfToken, '--num-speakers', String(numSpeakers)
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdoutData = ''

    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('STATUS:')) {
          logger.info('[WhisperX]', line.trim())
        } else if (line.trim() && !line.includes('UserWarning') && !line.includes('FutureWarning') && !line.includes('std =')) {
          logger.info('[WhisperX]', line.trim())
        }
      }
    })

    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    proc.on('close', (code) => {
      try { execSync('sleep 2') } catch {}
      if (code === 0) {
        try { const r = JSON.parse(stdoutData.trim()); if (r.segments) { resolve(r); return } } catch {}
        try { if (existsSync(outputPath)) { const d = JSON.parse(readFileSync(outputPath, 'utf-8')); try { unlinkSync(outputPath) } catch {}; resolve(d); return } } catch {}
      }
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
    if (!existsSync(scriptPath)) { resolve(segments.map(s => ({ id: s.id, ipa: '' }))); return }

    const ts = Date.now()
    const segPath = join(DATA_DIR, 'temp', `phon_input_${ts}.json`)
    const outPath = join(DATA_DIR, 'temp', `phon_output_${ts}.json`)
    writeFileSync(segPath, JSON.stringify(segments), 'utf-8')

    const proc = spawn('python3', [scriptPath, audioPath, '--segments', segPath, '--output', outPath],
      { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdoutData = ''

    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) { const p = parseInt(line.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) }
        else if (line.startsWith('ERROR:')) { logger.error('[Phonetize]', line.replace('ERROR:', '').trim()) }
        else if (line.trim() && !line.includes('UserWarning')) { logger.info('[Phonetize]', line.trim()) }
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

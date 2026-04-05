/**
 * LINGUISTIC-PIPELINE.TS : Pipeline de transcription linguistique
 *
 * Approche hybride : pyannote (QUI parle) + silence detect (QUAND) :
 *   1. Extraction audio (si video)
 *   2. WhisperX/pyannote sur tout l'audio → timeline speakers
 *   3. Silence detect → blocs de parole precis
 *   4. Croiser : chaque bloc + timeline → meneur ou intervenant
 *   5. Grouper en sequences : meneur → variantes → meneur → ...
 *   6. Whisper batch sur blocs meneur → texte FR
 *   7. Allosaurus IPA sur blocs intervenants
 *   8. Clips audio + save DB
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

  // ── Step 2 : Silence detect → blocs de parole ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'segmenting', progress: 0, message: 'Detection des silences...'
  })

  const silenceResult = await runSilenceSegment(audioPath, (percent) => {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'segmenting', progress: percent, message: 'Segmentation par silences...'
    })
    updateTaskProgress(task.id, 5 + percent * 0.05, 'Segmentation')
  })

  if (!silenceResult || silenceResult.speech_blocks.length === 0) {
    throw new Error('Aucun bloc de parole detecte')
  }

  const speechBlocks = silenceResult.speech_blocks
  const duration = silenceResult.stats?.total_duration || 0
  logger.info(`[Linguistic] ${speechBlocks.length} blocs de parole`)

  // ── Step 3 : Detection de langue sur chaque bloc (FR vs vernaculaire) ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'diarizing', progress: 0, message: 'Detection de langue (FR / vernaculaire)...'
  })

  const classifiedBlocks = await runLangClassify(audioPath, speechBlocks, (percent) => {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'diarizing', progress: percent, message: 'Classification linguistique...'
    })
    updateTaskProgress(task.id, 10 + percent * 0.15, 'Detection langue')
  })

  if (!classifiedBlocks || classifiedBlocks.length === 0) {
    throw new Error('Classification de langue echouee')
  }

  let frBlocks = classifiedBlocks.filter((b: any) => b.is_french)
  const vernBlocks = classifiedBlocks.filter((b: any) => !b.is_french)
  logger.info(`[Linguistic] Lang-id : ${frBlocks.length} blocs FR, ${vernBlocks.length} blocs vernaculaires`)

  // ── Step 3.5 : VALIDATION FR — Whisper + Ollama anti-hallucination ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'transcribing', progress: 0, message: 'Validation des blocs francais...'
  })

  // Whisper batch sur tous les blocs FR candidats
  const tempDir = join(DATA_DIR, 'temp')
  const frCandidateClips: { id: string; audioPath: string }[] = []

  for (let i = 0; i < frBlocks.length; i++) {
    const block = frBlocks[i]
    const clipPath = join(tempDir, `ling_validate_${task.id}_${i}.wav`)
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ss ${block.start} -to ${block.end} -ar 16000 -ac 1 "${clipPath}" 2>/dev/null`)
      frCandidateClips.push({ id: `validate_${i}`, audioPath: clipPath })
    } catch {}
  }

  await whisperService.loadWhisperModel(whisperModel)
  const validateResults = await whisperService.transcribeBatch(
    frCandidateClips, language,
    (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'transcribing', progress: Math.round(percent * 0.3),
        message: `Validation FR (${frCandidateClips.length} blocs)...`
      })
      updateTaskProgress(task.id, 25 + percent * 0.10, 'Validation FR')
    }
  )

  // Nettoyer clips
  for (const clip of frCandidateClips) { try { unlinkSync(clip.audioPath) } catch {} }

  // Stocker le texte Whisper dans chaque bloc FR
  for (let i = 0; i < frBlocks.length; i++) {
    const segs = validateResults.get(`validate_${i}`)
    frBlocks[i].whisper_text = segs && segs.length > 0
      ? segs.map((s: any) => s.text).join(' ').trim()
      : ''
  }

  // Ollama : verifier si chaque texte FR est du francais coherent
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'transcribing', progress: 30, message: 'Verification coherence (Ollama)...'
  })

  const textsToValidate = frBlocks.map((b: any) => b.whisper_text).filter((t: string) => t.length > 0)
  const allTexts = frBlocks.map((b: any, i: number) => `${i+1}. "${b.whisper_text}"`).join('\n')

  try {
    const ollamaModel = config.ollamaModel || 'llama3.1'
    const prompt = `Tu analyses une liste de phrases transcrites depuis un enregistrement audio de collectage linguistique. Un meneur dit des phrases en francais, puis des intervenants repetent en patois/dialecte.

Whisper a transcrit TOUS les blocs audio. Certains sont du VRAI francais du meneur (phrases coherentes, descriptions d'objets ou d'actions du quotidien). D'autres sont des HALLUCINATIONS de Whisper sur du patois (charabia, mots inventes, phrases sans sens).

Indices pour identifier les FAUX :
- Si la phrase commence par un prenom/nom de personne ("Pierre Billet...", "Yvette Raballand...", "Renaud Dinorne...") c'est probablement un intervenant qui parle en patois, pas le meneur → FAUX
- Si la phrase contient des mots inventes ou du charabia → FAUX
- Si la phrase est une vraie description en francais courant (ex: "Elle se sert de l'entonnoir de cuisine") → FR
- Les phrases du meneur decrivent des objets, des ustensiles, des actions domestiques

${allTexts}

Pour chaque numero, reponds UNIQUEMENT "FR" ou "FAUX".
Format strict, un par ligne :
1. FR
2. FAUX`

    const ollamaResponse = await ollamaGenerate(ollamaModel, prompt)

    // Parser la reponse Ollama
    const lines = ollamaResponse.split('\n')
    for (const line of lines) {
      const match = line.match(/(\d+)\.\s*(FR|FAUX)/i)
      if (match) {
        const idx = parseInt(match[1]) - 1
        const isFR = match[2].toUpperCase() === 'FR'
        if (idx >= 0 && idx < frBlocks.length) {
          if (!isFR) {
            // Reclasser en vernaculaire
            frBlocks[idx].is_french = false
            frBlocks[idx].validated = false
            logger.info(`[Linguistic] Bloc ${idx} reclasse vernaculaire: "${frBlocks[idx].whisper_text?.substring(0, 40)}"`)
          } else {
            frBlocks[idx].validated = true
          }
        }
      }
    }
  } catch (err: any) {
    logger.warn(`[Linguistic] Ollama validation echouee: ${err.message}. On garde tous les blocs FR.`)
  }

  // Mettre a jour classifiedBlocks avec les reclassifications Ollama
  let validFrCount = frBlocks.filter((b: any) => b.is_french).length
  let reclassifiedCount = frBlocks.filter((b: any) => !b.is_french).length
  logger.info(`[Linguistic] Validation Ollama : ${validFrCount} FR confirmes, ${reclassifiedCount} reclasses`)

  // ── Step 3.7 : Regle des FR consecutifs ──
  // Si plusieurs blocs FR se suivent sans bloc vernaculaire entre eux,
  // seul le PREMIER est le vrai meneur. Les suivants = vernaculaire mal classe.
  // Le meneur dit UNE phrase puis les intervenants parlent en vernaculaire.
  let lastWasFr = false
  for (const block of classifiedBlocks) {
    if (block.is_french) {
      if (lastWasFr) {
        // Deuxieme FR consecutif → reclasser en vernaculaire
        block.is_french = false
        block.reclassified_consecutive = true
        reclassifiedCount++
        validFrCount--
      }
      lastWasFr = true
    } else {
      lastWasFr = false
    }
  }

  logger.info(`[Linguistic] Apres regle consecutifs : ${validFrCount} FR, ${reclassifiedCount} reclasses total`)

  updateTaskProgress(task.id, 35, 'Sequences')

  // ── Step 4 : Construire les sequences par la LANGUE VALIDEE ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'segmenting', progress: 0, message: 'Construction des sequences...'
  })

  let sequences: LinguisticSequence[] = []
  let currentSeq: LinguisticSequence | null = null

  for (const block of classifiedBlocks) {
    if (block.is_french) {
      // Bloc FR valide = nouvelle sequence
      if (currentSeq) sequences.push(currentSeq)
      currentSeq = {
        id: randomUUID(),
        index: sequences.length,
        french_text: block.whisper_text || '',
        french_audio: { start: block.start, end: block.end },
        variants: []
      }
    } else if (currentSeq) {
      // Bloc vernaculaire ou FR reclasse
      // Ignorer les blocs trop courts (<1s) sauf si type='name' (prenom)
      const dur = block.end - block.start
      if (dur >= 1.0 || block.type === 'name') {
        currentSeq.variants.push({
          speaker: 'LOCUTEUR',
          ipa: '',
          ipa_original: '',
          audio: { start: block.start, end: block.end },
          ...(block.type === 'name' ? { _isName: true } : {})
        } as any)
      }
    }
  }
  if (currentSeq) sequences.push(currentSeq)

  sequences = sequences.filter(s => s.variants.length >= 1)
  sequences.forEach((s, i) => s.index = i)

  logger.info(`[Linguistic] ${sequences.length} sequences, ${sequences.reduce((s, q) => s + q.variants.length, 0)} variantes`)

  // Le texte FR est deja rempli par Whisper (step 3.5)
  // Pas besoin de refaire Whisper ici

  updateTaskProgress(task.id, 40, 'IPA')

  // ── Step 5 : Allosaurus IPA sur les variantes (PAS les blocs 'name') ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'phonetizing', progress: 0, message: 'Transcription phonetique (IPA)...'
  })

  // Filtrer : IPA seulement sur les variantes qui ne sont PAS des noms
  const ipaSegments = sequences.flatMap((seq, si) =>
    seq.variants
      .map((v: any, vi: number) => ({ id: `${si}_${vi}`, start: v.audio.start, end: v.audio.end, isName: v._isName }))
      .filter((s: any) => !s.isName)
  )

  if (ipaSegments.length > 0) {
    const ipaResults = await runPhonetize(audioPath, ipaSegments, (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'phonetizing', progress: percent, message: 'Transcription IPA...'
      })
      updateTaskProgress(task.id, 45 + percent * 0.30, 'IPA')
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

  // ── Step 8 : Extraits audio (asynchrone) ──
  const linguisticId = randomUUID()
  const clipDir = join(DATA_DIR, 'linguistic', linguisticId)
  mkdirSync(clipDir, { recursive: true })

  const ffmpegClip = (src: string, start: number, end: number, dest: string): Promise<void> =>
    new Promise((resolve) => {
      const { exec: execAsync } = require('child_process')
      execAsync(`ffmpeg -y -i "${src}" -ss ${start} -to ${end} -ar 16000 -ac 1 "${dest}" 2>/dev/null`, () => resolve())
    })

  const clipJobs: Array<() => Promise<void>> = []
  for (let si = 0; si < sequences.length; si++) {
    const seq = sequences[si]
    clipJobs.push(() => ffmpegClip(audioPath, seq.french_audio.start, seq.french_audio.end, join(clipDir, `seq_${si}_fr.wav`)))
    for (let vi = 0; vi < seq.variants.length; vi++) {
      const v = seq.variants[vi]
      const name = `seq_${si}_var_${vi}.wav`
      clipJobs.push(async () => { await ffmpegClip(audioPath, v.audio.start, v.audio.end, join(clipDir, name)); v.audio_extract = name })
    }
  }
  for (let i = 0; i < clipJobs.length; i += 5) {
    await Promise.all(clipJobs.slice(i, i + 5).map(fn => fn()))
  }

  updateTaskProgress(task.id, 90, 'Sauvegarde')

  // ── Step 9 : Save DB ──
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

// ── Helpers spawn ──

function runLangClassify(
  audioPath: string,
  blocks: Array<{ start: number; end: number }>,
  onProgress: (p: number) => void
): Promise<any[] | null> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'lang-classify.py')
    if (!existsSync(script)) { logger.error('lang-classify.py introuvable'); resolve(null); return }

    const ts = Date.now()
    const blocksPath = join(DATA_DIR, 'temp', `langblocks_${ts}.json`)
    const outPath = join(DATA_DIR, 'temp', `langresult_${ts}.json`)

    writeFileSync(blocksPath, JSON.stringify(blocks), 'utf-8')

    const proc = spawn('python3', [script, audioPath, '--blocks', blocksPath, '--output', outPath],
      { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''

    proc.stderr?.on('data', (d) => {
      for (const l of d.toString().split('\n')) {
        if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) }
        else if (l.startsWith('STATUS:')) logger.info('[LangClassify]', l.trim())
        else if (l.startsWith('ERROR:')) logger.error('[LangClassify]', l.trim())
      }
    })

    proc.stdout?.on('data', (d) => { stdout += d.toString() })

    proc.on('close', (code) => {
      try { unlinkSync(blocksPath) } catch {}
      try { execSync('sleep 2') } catch {}

      if (code === 0) {
        try { const r = JSON.parse(stdout.trim()); if (Array.isArray(r)) { resolve(r); return } } catch {}
        try {
          if (existsSync(outPath)) {
            const d = JSON.parse(readFileSync(outPath, 'utf-8'))
            try { unlinkSync(outPath) } catch {}
            resolve(d); return
          }
        } catch {}
      }
      logger.error(`[LangClassify] Code sortie ${code}`)
      resolve(null)
    })

    proc.on('error', () => resolve(null))
  })
}

function runSilenceSegment(audioPath: string, onProgress: (p: number) => void): Promise<any | null> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'silence-segment.py')
    if (!existsSync(script)) { resolve(null); return }
    const out = join(DATA_DIR, 'temp', `silence_${Date.now()}.json`)
    const proc = spawn('python3', [script, audioPath, '--output', out, '--sequence-gap', '5.0'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stderr?.on('data', d => { for (const l of d.toString().split('\n')) { if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) } else if (l.startsWith('STATUS:')) logger.info('[SilenceSegment]', l.trim()) } })
    proc.stdout?.on('data', d => { stdout += d.toString() })
    proc.on('close', code => { if (code === 0) { try { resolve(JSON.parse(stdout.trim())); return } catch {} try { if (existsSync(out)) { resolve(JSON.parse(readFileSync(out, 'utf-8'))); return } } catch {} } resolve(null) })
    proc.on('error', () => resolve(null))
  })
}

function runWhisperX(audioPath: string, model: string, language: string, numSpeakers: number, onProgress: (p: number) => void): Promise<{ segments: any[]; speakers: string[] } | null> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'whisperx-diarize.py')
    if (!existsSync(script)) { resolve(null); return }
    const out = join(DATA_DIR, 'temp', `whisperx_${Date.now()}.json`)
    const hf = process.env.HF_TOKEN || ''
    const proc = spawn('python3', [script, audioPath, '--output', out, '--model', model, '--language', language, '--hf-token', hf, '--num-speakers', String(numSpeakers)], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stderr?.on('data', (d) => {
      for (const l of d.toString().split('\n')) {
        if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) }
        else if (l.startsWith('STATUS:')) logger.info('[WhisperX]', l.trim())
        else if (l.trim() && !l.includes('UserWarning') && !l.includes('FutureWarning')) logger.info('[WhisperX]', l.trim())
      }
    })
    proc.stdout?.on('data', d => { stdout += d.toString() })
    proc.on('close', code => { try { execSync('sleep 2') } catch {} if (code === 0) { try { const r = JSON.parse(stdout.trim()); if (r.segments) { resolve(r); return } } catch {} try { if (existsSync(out)) { resolve(JSON.parse(readFileSync(out, 'utf-8'))); return } } catch {} } resolve(null) })
    proc.on('error', () => resolve(null))
  })
}

function runPhonetize(audioPath: string, segments: { id: string; start: number; end: number }[], onProgress: (p: number) => void): Promise<any[]> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'phonetize.py')
    if (!existsSync(script)) { resolve(segments.map(s => ({ id: s.id, ipa: '' }))); return }
    const ts = Date.now()
    const segP = join(DATA_DIR, 'temp', `phon_in_${ts}.json`)
    const outP = join(DATA_DIR, 'temp', `phon_out_${ts}.json`)
    writeFileSync(segP, JSON.stringify(segments), 'utf-8')
    const proc = spawn('python3', [script, audioPath, '--segments', segP, '--output', outP], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stderr?.on('data', (d) => {
      for (const l of d.toString().split('\n')) {
        if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) }
        else if (l.startsWith('ERROR:')) logger.error('[Phonetize]', l.replace('ERROR:', '').trim())
        else if (l.trim() && !l.includes('UserWarning')) logger.info('[Phonetize]', l.trim())
      }
    })
    proc.stdout?.on('data', d => { stdout += d.toString() })
    proc.on('close', code => { try { unlinkSync(segP) } catch {} try { execSync('sleep 2') } catch {} if (code === 0) { try { const r = JSON.parse(stdout.trim()); if (Array.isArray(r)) { resolve(r); return } } catch {} try { if (existsSync(outP)) { const d = JSON.parse(readFileSync(outP, 'utf-8')); try { unlinkSync(outP) } catch {} resolve(d); return } } catch {} } resolve(segments.map(s => ({ id: s.id, ipa: '' }))) })
    proc.on('error', () => resolve(segments.map(s => ({ id: s.id, ipa: '' }))))
  })
}

// ── Ollama helper ──
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama'
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434')

function ollamaGenerate(model: string, prompt: string): Promise<string> {
  const http = require('http')
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, prompt, stream: false })
    const req = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 180000
    }, (res: any) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data).response || '') }
        catch { reject(new Error('Reponse Ollama invalide')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')) })
    req.write(body)
    req.end()
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
  return db.prepare('SELECT id, filename, leader_speaker, duration, created_at FROM linguistic_transcriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as any[]
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
    for (const seq of sequences) { for (const v of seq.variants) { lines.push(`${seq.index + 1};"${seq.french_text}";"${v.speaker}";"${v.ipa}";${v.audio.start};${v.audio.end}`) } }
    return { content: lines.join('\n'), mime: 'text/csv; charset=utf-8', ext: 'csv' }
  }
  return { content: JSON.stringify({ filename: row.filename, leader: row.leader_speaker, sequences }, null, 2), mime: 'application/json; charset=utf-8', ext: 'json' }
}

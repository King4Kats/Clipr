/**
 * OLLAMA.TS : Service d'analyse semantique via LLM local (version web/serveur)
 *
 * Identique à la version Electron. Ollama tourne comme service Docker séparé
 * ou sur le host, accessible via OLLAMA_HOST env var.
 */

import http from 'node:http'
import { logger } from '../logger.js'

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1'
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434')

const MAX_CHARS_PER_CHUNK = 30000
const CHUNK_OVERLAP_CHARS = 800

interface SegmentResult {
  title: string
  start: number
  end: number
  description?: string
}

interface AnalysisResult {
  segments: SegmentResult[]
}

function ollamaRequest(method: string, path: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : undefined
    const options: http.RequestOptions = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      },
      timeout: 600000
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data)
        } else {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`))
        }
      })
    })

    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error('Délai d\'attente Ollama dépassé')) })

    if (postData) req.write(postData)
    req.end()
  })
}

export async function checkOllama(): Promise<boolean> {
  try {
    const data = await ollamaRequest('GET', '/api/tags')
    return !!data
  } catch {
    return false
  }
}

export async function ensureOllamaRunning(): Promise<boolean> {
  // En Docker, Ollama est un service séparé, on vérifie juste qu'il répond
  const isRunning = await checkOllama()
  if (isRunning) return true

  logger.warn('Ollama n\'est pas accessible sur ' + OLLAMA_HOST + ':' + OLLAMA_PORT)
  // On attend un peu au cas où le container démarre
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await checkOllama()) {
      logger.info('Ollama est maintenant accessible.')
      return true
    }
  }
  return false
}

export async function listOllamaModels(): Promise<string[]> {
  try {
    const data = await ollamaRequest('GET', '/api/tags')
    const parsed = JSON.parse(data)
    return (parsed.models || []).map((m: { name: string }) => m.name)
  } catch {
    return []
  }
}

export async function pullOllamaModel(modelName: string): Promise<boolean> {
  try {
    logger.info(`Pulling Ollama model: ${modelName}...`)
    const postData = JSON.stringify({ name: modelName, stream: false })

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/pull',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 600000
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          logger.info('Téléchargement terminé :', data.substring(0, 200))
          resolve(res.statusCode === 200)
        })
      })
      req.on('error', (err) => { logger.error('Erreur de pull :', err); reject(err) })
      req.on('timeout', () => { req.destroy(); reject(new Error('Délai de téléchargement dépassé')) })
      req.write(postData)
      req.end()
    })
  } catch (err) {
    logger.error('Failed to pull model:', err)
    return false
  }
}

function splitTranscriptIntoChunks(transcript: string): string[] {
  if (transcript.length <= MAX_CHARS_PER_CHUNK) {
    return [transcript]
  }

  const lines = transcript.split('\n')
  const chunks: string[] = []
  let currentChunk = ''
  let overlapBuffer = ''

  for (const line of lines) {
    const addition = (currentChunk ? '\n' : '') + line

    if (currentChunk.length + addition.length > MAX_CHARS_PER_CHUNK) {
      if (currentChunk) {
        chunks.push(currentChunk)
        overlapBuffer = currentChunk.slice(-CHUNK_OVERLAP_CHARS)
        currentChunk = overlapBuffer + '\n' + line
      } else {
        chunks.push(line.substring(0, MAX_CHARS_PER_CHUNK))
        currentChunk = ''
      }
    } else {
      currentChunk += addition
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk)
  }

  return chunks
}

function extractTimeRange(text: string): { first: number; last: number } | null {
  const matches = text.match(/\[(\d+(?:\.\d+)?)s\]/g)
  if (!matches || matches.length === 0) return null
  const times = matches.map(m => parseFloat(m.replace(/[\[\]s]/g, '')))
  return { first: Math.min(...times), last: Math.max(...times) }
}

async function generateGlobalSummary(
  transcript: string,
  context: string,
  model: string
): Promise<string> {
  const systemPrompt = `Tu es un expert en analyse de contenu vidéo et interview.
Ton but est de comprendre le sujet global d'une vidéo à partir de sa transcription horodatée.
Identifie le thème principal, les intervenants si possible, les points clés abordés et le ton général.
Sois concis mais exhaustif sur les thématiques.
Note : la transcription contient des marqueurs temporels [XXX.Xs].`

  const MAX_SUMMARY_CHARS = 25000
  let transcriptSample: string

  if (transcript.length <= MAX_SUMMARY_CHARS) {
    transcriptSample = transcript
  } else {
    const partSize = Math.floor(MAX_SUMMARY_CHARS / 3)
    const start = transcript.slice(0, partSize)
    const midStart = Math.floor(transcript.length / 2) - Math.floor(partSize / 2)
    const middle = transcript.slice(midStart, midStart + partSize)
    const end = transcript.slice(-partSize)
    transcriptSample = `${start}\n\n[... milieu ...]\n\n${middle}\n\n[... fin ...]\n\n${end}`
  }

  const userPrompt = `${context ? `CONTEXTE: ${context}\n\n` : ''}TRANSCRIPTION (${transcript.length > MAX_SUMMARY_CHARS ? 'échantillonnée — ' + Math.round(transcript.length / 1000) + 'K chars' : 'complète'}):
"""
${transcriptSample}
"""

Analyse cette transcription et fournis un résumé structuré du sujet.`

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    options: { temperature: 0.3, num_ctx: 32768 }
  }

  try {
    const data = await ollamaRequest('POST', '/api/chat', body)
    const response = JSON.parse(data)
    return response.message?.content || 'Aucun résumé généré.'
  } catch (err) {
    logger.error('Erreur résumé global :', err)
    return 'Erreur lors de la génération du résumé.'
  }
}

function extractJsonFromResponse(raw: string): any {
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch { /* le JSON est invalide */ }
    }
    return null
  }
}

async function analyzeChunk(
  chunk: string,
  context: string,
  globalSummary: string,
  model: string,
  chunkIndex: number,
  totalChunks: number,
  previousEndInfo?: { title: string; endTime: number }
): Promise<SegmentResult[]> {
  const timeRange = extractTimeRange(chunk)

  const systemPrompt = `Tu es un expert en montage vidéo d'interviews.
Tu dois découper une transcription horodatée en segments thématiques SÉQUENTIELS.

RÈGLES ABSOLUES — aucune exception :
1. Les segments sont SÉQUENTIELS : le "start" du segment N+1 = le "end" du segment N. ZÉRO chevauchement.
2. COUVERTURE TOTALE : le premier segment commence au tout premier timestamp, le dernier se termine au dernier timestamp.
3. Durée typique : entre 2 et 8 minutes par segment pour une interview. Ni 14 secondes, ni 13 minutes.
4. TITRES PRÉCIS : chaque titre résume le sujet RÉEL discuté dans ce passage (pas le sujet de la vidéo en général).
5. Les timestamps [XXX.Xs] dans le texte donnent le temps en secondes. Utilise-les pour les valeurs start/end.
6. Réponds UNIQUEMENT avec du JSON valide.
7. Vise entre 5 et 15 segments pour un extrait de 20-60 minutes.

EXEMPLE pour un extrait de 0s à 600s:
{"segments":[
  {"title":"Présentation et contexte","start":0,"end":120,"description":"Introduction du sujet"},
  {"title":"Enfance et scolarité","start":120,"end":300,"description":"L'invité parle de sa jeunesse"},
  {"title":"Parcours professionnel","start":300,"end":600,"description":"Évolution de carrière"}
]}`

  const chunkLabel = totalChunks > 1 ? `(partie ${chunkIndex + 1}/${totalChunks}) ` : ''

  const continuityHint = previousEndInfo
    ? `\nATTENTION CONTINUITÉ : Le chunk précédent s'est terminé avec le segment "${previousEndInfo.title}" à ${previousEndInfo.endTime.toFixed(1)}s. Ton premier segment DOIT commencer à ${previousEndInfo.endTime.toFixed(1)}s.\n`
    : ''

  const rangeHint = timeRange
    ? `\nCet extrait couvre de ${timeRange.first.toFixed(1)}s à ~${timeRange.last.toFixed(1)}s.`
    : ''

  const userPrompt = `SUJET DE LA VIDÉO :
"${globalSummary.substring(0, 500)}"
${continuityHint}${rangeHint}
${context ? `CONSIGNES: ${context}\n` : ''}
TRANSCRIPTION ${chunkLabel}:
"""
${chunk}
"""

Découpe en segments thématiques SÉQUENTIELS couvrant tout l'extrait. JSON uniquement :
{"segments":[{"title":"...","start":X,"end":Y,"description":"..."},...]}`

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    format: 'json',
    stream: false,
    options: { temperature: 0.1, num_ctx: 32768 }
  }

  const MAX_RETRIES = 3
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await ollamaRequest('POST', '/api/chat', body)
      const response = JSON.parse(data)
      const content = response.message?.content || '{}'

      const parsed = extractJsonFromResponse(content)
      if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
        logger.warn(`[Ollama] Tentative ${attempt}/${MAX_RETRIES} : pas de segments valides`)
        if (attempt < MAX_RETRIES) continue
        return []
      }

      return parsed.segments
    } catch (err) {
      logger.error(`[Ollama] Tentative ${attempt}/${MAX_RETRIES} échouée :`, err)
      if (attempt >= MAX_RETRIES) return []
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return []
}

export function cleanAndForceSequential(rawSegments: SegmentResult[], totalDuration: number): SegmentResult[] {
  if (rawSegments.length === 0) return []

  const sorted = [...rawSegments]
    .filter(s => s.title && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
    .sort((a, b) => a.start - b.start)

  if (sorted.length === 0) return []

  const deduped: SegmentResult[] = []
  for (const seg of sorted) {
    const existing = deduped.find(d => {
      const overlapStart = Math.max(d.start, seg.start)
      const overlapEnd = Math.min(d.end, seg.end)
      const overlapDuration = Math.max(0, overlapEnd - overlapStart)
      const segDuration = seg.end - seg.start
      const dDuration = d.end - d.start
      return overlapDuration > 0.7 * Math.min(segDuration, dDuration)
    })

    if (!existing) {
      deduped.push({ ...seg })
    } else {
      if (seg.title.length > existing.title.length) {
        existing.title = seg.title
        existing.description = seg.description || existing.description
      }
      existing.start = Math.min(existing.start, seg.start)
      existing.end = Math.max(existing.end, seg.end)
    }
  }

  if (deduped.length === 0) return []

  const sequential: SegmentResult[] = [deduped[0]]
  for (let i = 1; i < deduped.length; i++) {
    const prev = sequential[sequential.length - 1]
    const curr = deduped[i]

    if (curr.start < prev.end) {
      curr.start = prev.end
    }

    if (curr.end > curr.start + 5) {
      sequential.push(curr)
    } else {
      prev.end = Math.max(prev.end, curr.end)
    }
  }

  for (let i = 0; i < sequential.length - 1; i++) {
    const gap = sequential[i + 1].start - sequential[i].end
    if (gap > 0) {
      sequential[i].end = sequential[i + 1].start
    }
  }

  if (totalDuration > 0) {
    const firstStart = Math.min(sequential[0].start, sorted[0].start)
    sequential[0].start = Math.max(0, firstStart)
    sequential[sequential.length - 1].end = Math.max(sequential[sequential.length - 1].end, totalDuration)
  }

  const MIN_DURATION = 30
  const merged: SegmentResult[] = []
  for (const seg of sequential) {
    const duration = seg.end - seg.start
    if (duration < MIN_DURATION && merged.length > 0) {
      merged[merged.length - 1].end = seg.end
    } else {
      merged.push(seg)
    }
  }

  return merged.map(s => ({
    title: s.title.substring(0, 80),
    start: Math.round(s.start * 10) / 10,
    end: Math.round(s.end * 10) / 10,
    description: s.description || ''
  }))
}

export async function analyzeTranscript(
  transcript: string,
  context: string,
  model: string,
  onChunkProgress?: (chunkIndex: number, totalChunks: number, segmentsSoFar: number, message?: string) => void
): Promise<AnalysisResult> {
  const ollamaOk = await ensureOllamaRunning()
  if (!ollamaOk) {
    throw new Error('Impossible de contacter Ollama. Vérifiez que le service est démarré.')
  }

  const globalTimeRange = extractTimeRange(transcript)
  const totalDuration = globalTimeRange ? globalTimeRange.last + 10 : 0

  if (onChunkProgress) onChunkProgress(0, 1, 0, 'Analyse globale du sujet...')
  const globalSummary = await generateGlobalSummary(transcript, context, model)
  logger.info('[Ollama] Résumé global :', globalSummary.substring(0, 200))

  const chunks = splitTranscriptIntoChunks(transcript)
  const allRawSegments: SegmentResult[] = []
  let previousEndInfo: { title: string; endTime: number } | undefined

  logger.info(`[Ollama] ${chunks.length} morceaux à analyser`)

  for (let i = 0; i < chunks.length; i++) {
    if (onChunkProgress) {
      onChunkProgress(i, chunks.length, allRawSegments.length, `Analyse thématique ${i + 1}/${chunks.length}...`)
    }

    const chunkSegments = await analyzeChunk(
      chunks[i], context, globalSummary, model,
      i, chunks.length, previousEndInfo
    )

    if (chunkSegments.length > 0) {
      allRawSegments.push(...chunkSegments)
      const lastSeg = chunkSegments[chunkSegments.length - 1]
      previousEndInfo = {
        title: lastSeg.title,
        endTime: typeof lastSeg.end === 'number' ? lastSeg.end : 0
      }
    } else {
      logger.warn(`[Ollama] Morceau ${i + 1}/${chunks.length} : aucun segment`)
    }
  }

  logger.info(`[Ollama] ${allRawSegments.length} segments bruts, nettoyage...`)

  const cleanSegments = cleanAndForceSequential(allRawSegments, totalDuration)

  logger.info(`[Ollama] ${cleanSegments.length} segments finaux après nettoyage`)

  return { segments: cleanSegments }
}

// Pas de downloadAndInstallOllama en mode web — Ollama est un service Docker

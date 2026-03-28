import http from 'node:http'
import { logger } from '../logger.js'

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama'
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434')

const MAX_CHARS_PER_CHUNK = 30000
const CHUNK_OVERLAP_CHARS = 800

interface SegmentResult { title: string; start: number; end: number; description?: string }
interface AnalysisResult { segments: SegmentResult[] }

function ollamaRequest(method: string, path: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : undefined
    const options: http.RequestOptions = {
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path, method,
      headers: { 'Content-Type': 'application/json', ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}) },
      timeout: 600000
    }
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(data)
        else reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`))
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout Ollama')) })
    if (postData) req.write(postData)
    req.end()
  })
}

export async function checkOllama(): Promise<boolean> {
  try { const d = await ollamaRequest('GET', '/api/tags'); return !!d } catch { return false }
}

export async function listOllamaModels(): Promise<string[]> {
  try {
    const data = await ollamaRequest('GET', '/api/tags')
    return (JSON.parse(data).models || []).map((m: { name: string }) => m.name)
  } catch { return [] }
}

export async function pullOllamaModel(modelName: string): Promise<boolean> {
  try {
    logger.info(`Pull Ollama model: ${modelName}...`)
    const postData = JSON.stringify({ name: modelName, stream: false })
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/pull', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 600000
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => { resolve(res.statusCode === 200) })
      })
      req.on('error', (err) => { logger.error('Pull error:', err); reject(err) })
      req.on('timeout', () => { req.destroy(); reject(new Error('Pull timeout')) })
      req.write(postData)
      req.end()
    })
  } catch { return false }
}

function splitTranscriptIntoChunks(transcript: string): string[] {
  if (transcript.length <= MAX_CHARS_PER_CHUNK) return [transcript]
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
      } else { chunks.push(line.substring(0, MAX_CHARS_PER_CHUNK)); currentChunk = '' }
    } else { currentChunk += addition }
  }
  if (currentChunk.trim()) chunks.push(currentChunk)
  return chunks
}

function extractTimeRange(text: string): { first: number; last: number } | null {
  const matches = text.match(/\[(\d+(?:\.\d+)?)s\]/g)
  if (!matches || matches.length === 0) return null
  const times = matches.map(m => parseFloat(m.replace(/[\[\]s]/g, '')))
  return { first: Math.min(...times), last: Math.max(...times) }
}

async function generateGlobalSummary(transcript: string, context: string, model: string): Promise<string> {
  const systemPrompt = `Tu es un expert en analyse de contenu video et interview.
Ton but est de comprendre le sujet global d'une video a partir de sa transcription horodatee.
Identifie le theme principal, les intervenants si possible, les points cles abordes et le ton general.
Sois concis mais exhaustif sur les thematiques.`

  const MAX_SUMMARY_CHARS = 25000
  let sample: string
  if (transcript.length <= MAX_SUMMARY_CHARS) { sample = transcript }
  else {
    const ps = Math.floor(MAX_SUMMARY_CHARS / 3)
    sample = `${transcript.slice(0, ps)}\n\n[... milieu ...]\n\n${transcript.slice(Math.floor(transcript.length / 2) - Math.floor(ps / 2), Math.floor(transcript.length / 2) + Math.floor(ps / 2))}\n\n[... fin ...]\n\n${transcript.slice(-ps)}`
  }

  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `${context ? `CONTEXTE: ${context}\n\n` : ''}TRANSCRIPTION:\n"""\n${sample}\n"""\n\nAnalyse et fournis un resume structure.` }],
    stream: false, options: { temperature: 0.3, num_ctx: 32768 }
  }
  try {
    const data = await ollamaRequest('POST', '/api/chat', body)
    return JSON.parse(data).message?.content || 'Aucun resume.'
  } catch (err) { logger.error('Erreur resume:', err); return 'Erreur resume.' }
}

function extractJsonFromResponse(raw: string): any {
  try { return JSON.parse(raw) } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) { try { return JSON.parse(match[0]) } catch {} }
    return null
  }
}

async function analyzeChunk(chunk: string, context: string, globalSummary: string, model: string, chunkIndex: number, totalChunks: number, previousEndInfo?: { title: string; endTime: number }): Promise<SegmentResult[]> {
  const timeRange = extractTimeRange(chunk)
  const systemPrompt = `Tu es un expert en montage video d'interviews.
Tu dois decouper une transcription horodatee en segments thematiques SEQUENTIELS.

REGLES ABSOLUES :
1. Les segments sont SEQUENTIELS : le "start" du segment N+1 = le "end" du segment N.
2. COUVERTURE TOTALE : premier segment au premier timestamp, dernier au dernier.
3. Duree typique : 2 a 8 minutes par segment.
4. TITRES PRECIS.
5. Les timestamps [XXX.Xs] donnent le temps en secondes.
6. Reponds UNIQUEMENT avec du JSON valide.
7. Vise 5 a 15 segments pour 20-60 minutes.

{"segments":[{"title":"...","start":X,"end":Y,"description":"..."},...]}`

  const chunkLabel = totalChunks > 1 ? `(partie ${chunkIndex + 1}/${totalChunks}) ` : ''
  const continuityHint = previousEndInfo ? `\nCONTINUITE : chunk precedent termine avec "${previousEndInfo.title}" a ${previousEndInfo.endTime.toFixed(1)}s. Premier segment DOIT commencer a ${previousEndInfo.endTime.toFixed(1)}s.\n` : ''
  const rangeHint = timeRange ? `\nExtrait de ${timeRange.first.toFixed(1)}s a ~${timeRange.last.toFixed(1)}s.` : ''

  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `SUJET:\n"${globalSummary.substring(0, 500)}"\n${continuityHint}${rangeHint}\n${context ? `CONSIGNES: ${context}\n` : ''}TRANSCRIPTION ${chunkLabel}:\n"""\n${chunk}\n"""\n\nDecoupe en segments thematiques SEQUENTIELS. JSON uniquement:\n{"segments":[{"title":"...","start":X,"end":Y,"description":"..."},...]}` }],
    format: 'json', stream: false, options: { temperature: 0.1, num_ctx: 32768 }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await ollamaRequest('POST', '/api/chat', body)
      const content = JSON.parse(data).message?.content || '{}'
      const parsed = extractJsonFromResponse(content)
      if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
        logger.warn(`[Ollama] Tentative ${attempt}/3 : pas de segments valides`)
        if (attempt < 3) continue
        return []
      }
      return parsed.segments
    } catch (err) {
      logger.error(`[Ollama] Tentative ${attempt}/3 echouee:`, err)
      if (attempt >= 3) return []
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return []
}

export function cleanAndForceSequential(rawSegments: SegmentResult[], totalDuration: number): SegmentResult[] {
  if (rawSegments.length === 0) return []
  const sorted = [...rawSegments].filter(s => s.title && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start).sort((a, b) => a.start - b.start)
  if (sorted.length === 0) return []

  // Deduplication
  const deduped: SegmentResult[] = []
  for (const seg of sorted) {
    const existing = deduped.find(d => {
      const os = Math.max(d.start, seg.start), oe = Math.min(d.end, seg.end)
      const od = Math.max(0, oe - os)
      return od > 0.7 * Math.min(seg.end - seg.start, d.end - d.start)
    })
    if (!existing) deduped.push({ ...seg })
    else {
      if (seg.title.length > existing.title.length) { existing.title = seg.title; existing.description = seg.description || existing.description }
      existing.start = Math.min(existing.start, seg.start)
      existing.end = Math.max(existing.end, seg.end)
    }
  }
  if (deduped.length === 0) return []

  // Sequentialisation
  const seq: SegmentResult[] = [deduped[0]]
  for (let i = 1; i < deduped.length; i++) {
    const prev = seq[seq.length - 1], curr = deduped[i]
    if (curr.start < prev.end) curr.start = prev.end
    if (curr.end > curr.start + 5) seq.push(curr)
    else prev.end = Math.max(prev.end, curr.end)
  }

  // Combler les trous
  for (let i = 0; i < seq.length - 1; i++) {
    if (seq[i + 1].start - seq[i].end > 0) seq[i].end = seq[i + 1].start
  }

  // Bornes globales
  if (totalDuration > 0) {
    seq[0].start = Math.max(0, Math.min(seq[0].start, sorted[0].start))
    seq[seq.length - 1].end = Math.max(seq[seq.length - 1].end, totalDuration)
  }

  // Fusion < 30s
  const merged: SegmentResult[] = []
  for (const s of seq) {
    if (s.end - s.start < 30 && merged.length > 0) merged[merged.length - 1].end = s.end
    else merged.push(s)
  }

  return merged.map(s => ({ title: s.title.substring(0, 80), start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, description: s.description || '' }))
}

export async function analyzeTranscript(transcript: string, context: string, model: string, onChunkProgress?: (ci: number, tc: number, sf: number, msg?: string) => void): Promise<AnalysisResult> {
  const ollamaOk = await checkOllama()
  if (!ollamaOk) throw new Error('Ollama non disponible.')

  const globalTimeRange = extractTimeRange(transcript)
  const totalDuration = globalTimeRange ? globalTimeRange.last + 10 : 0

  if (onChunkProgress) onChunkProgress(0, 1, 0, 'Analyse globale du sujet...')
  const globalSummary = await generateGlobalSummary(transcript, context, model)
  logger.info('[Ollama] Resume global:', globalSummary.substring(0, 200))

  const chunks = splitTranscriptIntoChunks(transcript)
  const allRaw: SegmentResult[] = []
  let prevEnd: { title: string; endTime: number } | undefined

  logger.info(`[Ollama] ${chunks.length} morceaux a analyser`)

  for (let i = 0; i < chunks.length; i++) {
    if (onChunkProgress) onChunkProgress(i, chunks.length, allRaw.length, `Analyse thematique ${i + 1}/${chunks.length}...`)
    const chunkSegs = await analyzeChunk(chunks[i], context, globalSummary, model, i, chunks.length, prevEnd)
    if (chunkSegs.length > 0) {
      allRaw.push(...chunkSegs)
      const last = chunkSegs[chunkSegs.length - 1]
      prevEnd = { title: last.title, endTime: typeof last.end === 'number' ? last.end : 0 }
    }
  }

  const clean = cleanAndForceSequential(allRaw, totalDuration)
  logger.info(`[Ollama] ${clean.length} segments finaux`)
  return { segments: clean }
}

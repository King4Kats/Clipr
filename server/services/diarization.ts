/**
 * DIARIZATION.TS : Speaker diarization service
 *
 * 1. Spawns diarize.py to assign SPEAKER_0/SPEAKER_1 labels to Whisper segments
 * 2. Uses Ollama to identify speaker names from the transcript content
 */

import { spawn } from 'child_process'
import { join, extname } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { logger } from '../logger.js'

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama'
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434')

interface TranscriptSegment {
  id: string
  start: number
  end: number
  text: string
  speaker?: string
}

function getDiarizeScriptPath(): string {
  const devPath = join(process.cwd(), 'scripts', 'diarize.py')
  if (existsSync(devPath)) return devPath
  const altPath = join(__dirname, '..', '..', 'scripts', 'diarize.py')
  if (existsSync(altPath)) return altPath
  return devPath
}

/**
 * Run speaker diarization on audio + whisper segments.
 * Returns segments with speaker field added.
 */
export function diarize(
  audioPath: string,
  segments: TranscriptSegment[],
  onProgress: (percent: number) => void,
  numSpeakers: number = 0  // 0 = auto-detect
): Promise<TranscriptSegment[]> {
  return new Promise((resolve, reject) => {
    const scriptPath = getDiarizeScriptPath()
    if (!existsSync(scriptPath)) {
      logger.warn('Diarization script not found, skipping:', scriptPath)
      resolve(segments)
      return
    }

    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const ts = Date.now()
    const segmentsPath = join(DATA_DIR, 'temp', `diar_input_${ts}.json`)
    const outputPath = join(DATA_DIR, 'temp', `diar_output_${ts}.json`)

    // Write segments to temp file for Python script
    writeFileSync(segmentsPath, JSON.stringify(segments), 'utf-8')

    logger.info('=== Demarrage diarisation ===')
    logger.info('Audio:', audioPath, '| Speakers:', numSpeakers)

    const proc = spawn('python3', [
      scriptPath, audioPath,
      '--segments', segmentsPath,
      '--output', outputPath,
      '--num-speakers', String(numSpeakers)
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    const diarizedSegments: TranscriptSegment[] = []

    proc.stderr?.on('data', (data) => {
      const text = data.toString()
      for (const line of text.split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[Diarize]', line.replace('ERROR:', '').trim())
        } else if (line.trim() && !line.includes('UserWarning') && !line.includes('FutureWarning')) {
          logger.info('[Diarize]', line.trim())
        }
      }
    })

    proc.stdout?.on('data', (data) => {
      try {
        const parsed = JSON.parse(data.toString().trim())
        if (Array.isArray(parsed)) diarizedSegments.push(...parsed)
      } catch {}
    })

    proc.on('close', (code) => {
      // Cleanup temp files
      try { unlinkSync(segmentsPath) } catch {}

      // Wait for GPU memory release
      const { execSync } = require('child_process')
      try { execSync('sleep 2') } catch {}

      if (code === 0) {
        if (diarizedSegments.length > 0) {
          resolve(diarizedSegments)
          return
        }
        // Fallback: read from output file
        try {
          if (existsSync(outputPath)) {
            const data = JSON.parse(readFileSync(outputPath, 'utf-8'))
            try { unlinkSync(outputPath) } catch {}
            resolve(data)
          } else {
            logger.warn('Diarization output not found, returning original segments')
            resolve(segments)
          }
        } catch (err) {
          logger.error('Failed to read diarization output:', err)
          resolve(segments)
        }
      } else {
        logger.error(`Diarization failed (code ${code}), returning original segments`)
        resolve(segments) // Don't reject - gracefully degrade
      }
    })

    proc.on('error', (err) => {
      logger.error('Diarization process error:', err)
      resolve(segments) // Graceful degradation
    })
  })
}

/**
 * VAD + Diarisation : segmente par les silences reels, puis identifie les speakers.
 * Retourne des tours de parole propres [{start, end, speaker}]
 */
export function vadDiarize(
  audioPath: string,
  onProgress: (percent: number) => void,
  numSpeakers: number = 0
): Promise<Array<{ start: number; end: number; speaker: string }>> {
  return new Promise((resolve) => {
    const scriptPath = join(process.cwd(), 'scripts', 'vad-diarize.py')
    const altPath = join(__dirname, '..', '..', 'scripts', 'vad-diarize.py')
    const finalScript = existsSync(scriptPath) ? scriptPath : existsSync(altPath) ? altPath : scriptPath

    if (!existsSync(finalScript)) {
      logger.warn('Script vad-diarize.py introuvable:', finalScript)
      resolve([])
      return
    }

    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const outputPath = join(DATA_DIR, 'temp', `vad_diar_${Date.now()}.json`)

    logger.info(`=== VAD+Diarisation : ${audioPath} | speakers=${numSpeakers} ===`)

    const args = [finalScript, audioPath, '--output', outputPath, '--num-speakers', String(numSpeakers)]
    const proc = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdoutData = ''

    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[VAD-Diarize]', line.replace('ERROR:', '').trim())
        } else if (line.trim() && !line.includes('UserWarning') && !line.includes('FutureWarning')) {
          logger.info('[VAD-Diarize]', line.trim())
        }
      }
    })

    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    proc.on('close', (code) => {
      const { execSync } = require('child_process')
      try { execSync('sleep 2') } catch {}

      if (code === 0) {
        try {
          const results = JSON.parse(stdoutData.trim())
          if (Array.isArray(results)) { resolve(results); return }
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
      logger.error(`[VAD-Diarize] Code sortie ${code}`)
      resolve([])
    })

    proc.on('error', () => resolve([]))
  })
}

/**
 * Use Ollama to identify speaker names from transcript content.
 * Analyzes first ~3 minutes of transcript to find names.
 * Returns mapping: { "SPEAKER_0": "Philippe", "SPEAKER_1": "Intervieweur" }
 */
export async function identifySpeakerNames(
  segments: TranscriptSegment[],
  ollamaModel: string = 'llama3.1'
): Promise<Record<string, string>> {
  const defaultMapping: Record<string, string> = {}

  // Collect unique speaker IDs
  const speakerIds = [...new Set(segments.filter(s => s.speaker).map(s => s.speaker!))]
  if (speakerIds.length === 0) return defaultMapping

  // Take first ~3 minutes of transcript
  const firstSegments = segments.filter(s => s.start < 180)
  if (firstSegments.length === 0) return defaultMapping

  const transcript = firstSegments
    .map(s => `${s.speaker || 'UNKNOWN'}: ${s.text}`)
    .join('\n')

  const speakerMapping = speakerIds.map(id => `"${id}": "Prenom ou role"`).join(', ')

  const prompt = `Tu analyses le debut d'une interview ou conversation transcrite. Voici les premieres minutes avec les locuteurs identifies comme ${speakerIds.join(', ')}.

${transcript}

Il y a ${speakerIds.length} locuteurs. Identifie pour chacun:
1. Son prenom s'il est mentionne (presentations, "je suis...", "bonjour X", "je m'appelle...", etc.)
2. Son role si le prenom n'est pas trouve: "Intervieweur" (pose les questions), "Intervenant" (repond), "Intervenant 2", "Intervenant 3", etc.

Reponds UNIQUEMENT en JSON valide, sans texte autour:
{${speakerMapping}}

Si tu ne trouves pas le prenom d'un locuteur, utilise son role.`

  try {
    const response = await ollamaGenerate(ollamaModel, prompt)
    // Extract JSON from response
    const jsonMatch = response.match(/\{[^}]+\}/)
    if (jsonMatch) {
      const mapping = JSON.parse(jsonMatch[0])
      logger.info('[Diarize] Speaker names identified:', mapping)
      return mapping
    }
  } catch (err) {
    logger.warn('[Diarize] Ollama name detection failed, using defaults:', err)
  }

  // Fallback: assign based on speaking ratio
  // The person who talks more is likely the interviewee
  const speakerDurations: Record<string, number> = {}
  for (const seg of segments) {
    if (seg.speaker) {
      speakerDurations[seg.speaker] = (speakerDurations[seg.speaker] || 0) + (seg.end - seg.start)
    }
  }

  const sorted = Object.entries(speakerDurations).sort((a, b) => b[1] - a[1])
  const fallback: Record<string, string> = {}
  // Person who talks most = main speaker, least = interviewer, others = Intervenant N
  for (let i = 0; i < sorted.length; i++) {
    if (i === sorted.length - 1 && sorted.length > 1) {
      fallback[sorted[i][0]] = 'Intervieweur'
    } else if (i === 0) {
      fallback[sorted[i][0]] = 'Intervenant'
    } else {
      fallback[sorted[i][0]] = `Intervenant ${i + 1}`
    }
  }
  logger.info('[Diarize] Using fallback speaker names:', fallback)
  return fallback
}

/**
 * Apply speaker name mapping to segments, replacing SPEAKER_0/1 with names.
 */
export function applySpeakerNames(segments: TranscriptSegment[], mapping: Record<string, string>): void {
  for (const seg of segments) {
    if (seg.speaker && mapping[seg.speaker]) {
      seg.speaker = mapping[seg.speaker]
    }
  }
}

// ── Ollama helper ──
function ollamaGenerate(model: string, prompt: string): Promise<string> {
  const http = require('http')
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, prompt, stream: false })
    const req = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000
    }, (res: any) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve(parsed.response || '')
        } catch { reject(new Error('Invalid Ollama response')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')) })
    req.write(body)
    req.end()
  })
}

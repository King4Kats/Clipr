import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { logger } from '../logger.js'

interface TranscriptSegment {
  id: string
  start: number
  end: number
  text: string
  speaker?: string
}

let whisperProcess: ChildProcess | null = null
let currentModel: string | null = null

function getTranscribeScriptPath(): string {
  const devPath = join(process.cwd(), 'scripts', 'transcribe.py')
  if (existsSync(devPath)) return devPath
  const altPath = join(__dirname, '..', '..', 'scripts', 'transcribe.py')
  if (existsSync(altPath)) return altPath
  return devPath
}

export async function loadWhisperModel(model: string): Promise<void> {
  currentModel = model
}

export function transcribe(
  audioPath: string,
  language: string,
  onSegment: (segment: TranscriptSegment) => void,
  onProgress: (percent: number) => void,
  initialPrompt?: string
): Promise<TranscriptSegment[]> {
  return new Promise(async (resolve, reject) => {
    const model = currentModel || 'large-v3'
    const segments: TranscriptSegment[] = []

    const scriptPath = getTranscribeScriptPath()
    logger.info('Script transcription:', scriptPath, 'existe:', existsSync(scriptPath))

    if (!existsSync(scriptPath)) {
      reject(new Error(`Script de transcription non trouve: ${scriptPath}`))
      return
    }

    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const outputPath = join(DATA_DIR, 'temp', `transcript_${Date.now()}.json`)

    logger.info('=== Demarrage transcription ===')
    logger.info('Audio:', audioPath, '| Modele:', model, '| Langue:', language)

    const args = [scriptPath, audioPath, '--model', model, '--language', language, '--output', outputPath]
    if (initialPrompt) {
      args.push('--prompt', initialPrompt)
      logger.info('Initial prompt:', initialPrompt.substring(0, 100) + '...')
    }

    whisperProcess = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    whisperProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('PROGRESS:')) {
          const progress = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(progress)) onProgress(progress)
        } else if (line.startsWith('SEGMENT:')) {
          try {
            const segData = JSON.parse(line.replace('SEGMENT:', '').trim())
            const segment: TranscriptSegment = {
              id: String(segData.id),
              start: segData.start,
              end: segData.end,
              text: segData.text
            }
            segments.push(segment)
            onSegment(segment)
          } catch {}
        } else if (line.startsWith('ERROR:')) {
          logger.error('[Whisper]', line.replace('ERROR:', '').trim())
        } else if (line.trim() && !line.includes('UserWarning')) {
          logger.info('[Whisper]', line.trim())
        }
      }
    })

    whisperProcess.on('close', (code) => {
      whisperProcess = null
      logger.info('=== Fin Whisper === Code:', code)

      // Wait a moment for CUDA to release GPU memory
      const { execSync } = require('child_process')
      try { execSync('sleep 2') } catch {}


      if (code === 0) {
        if (segments.length > 0) {
          resolve(segments)
          return
        }
        try {
          if (existsSync(outputPath)) {
            const data = JSON.parse(readFileSync(outputPath, 'utf-8'))
            const ts: TranscriptSegment[] = (data.segments || []).map((s: any, i: number) => ({
              id: String(s.id || i), start: s.start || 0, end: s.end || 0, text: (s.text || '').trim()
            }))
            ts.forEach(onSegment)
            resolve(ts)
          } else {
            reject(new Error('Fichier de sortie introuvable'))
          }
        } catch (err) { reject(err) }
      } else {
        reject(new Error(`Transcription echouee (code ${code})`))
      }
    })

    whisperProcess.on('error', (err) => {
      whisperProcess = null
      reject(err)
    })
  })
}

/**
 * Transcription batch : charge le modele UNE FOIS, transcrit N clips.
 * Evite de recharger le modele a chaque clip (gain ~6s par clip).
 */
export function transcribeBatch(
  clips: { id: string; audioPath: string }[],
  language: string,
  onProgress: (percent: number) => void
): Promise<Map<string, TranscriptSegment[]>> {
  return new Promise((resolve, reject) => {
    // Trouver le script batch
    const scriptPath = join(process.cwd(), 'scripts', 'transcribe-batch.py')
    const altPath = join(__dirname, '..', '..', 'scripts', 'transcribe-batch.py')
    const finalScript = existsSync(scriptPath) ? scriptPath : existsSync(altPath) ? altPath : scriptPath

    if (!existsSync(finalScript)) {
      logger.warn('Script transcribe-batch.py introuvable, fallback sequentiel')
      resolve(new Map())
      return
    }

    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const ts = Date.now()
    const manifestPath = join(DATA_DIR, 'temp', `batch_manifest_${ts}.json`)
    const outputPath = join(DATA_DIR, 'temp', `batch_output_${ts}.json`)

    // Ecrire le manifest
    const manifest = clips.map(c => ({ id: c.id, path: c.audioPath }))
    const { writeFileSync, unlinkSync: ul } = require('fs')
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8')

    const model = currentModel || 'large-v3'
    logger.info(`=== Transcription batch : ${clips.length} clips, modele ${model} ===`)

    const proc = spawn('python3', [
      finalScript, '--manifest', manifestPath, '--model', model,
      '--language', language, '--output', outputPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdoutData = ''

    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[Whisper-Batch]', line.replace('ERROR:', '').trim())
        } else if (line.startsWith('SEGMENT:')) {
          // Log de progression par clip
          logger.info('[Whisper-Batch]', line.replace('SEGMENT:', '').trim().substring(0, 80))
        } else if (line.trim() && !line.includes('UserWarning')) {
          logger.info('[Whisper-Batch]', line.trim())
        }
      }
    })

    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    proc.on('close', (code) => {
      try { ul(manifestPath) } catch {}
      const { execSync: ex } = require('child_process')
      try { ex('sleep 2') } catch {} // Attendre liberation GPU

      const resultMap = new Map<string, TranscriptSegment[]>()

      if (code === 0) {
        try {
          let results: any[] = []
          // Essayer stdout d'abord
          try { results = JSON.parse(stdoutData.trim()) } catch {}
          // Sinon lire le fichier
          if (results.length === 0 && existsSync(outputPath)) {
            results = JSON.parse(readFileSync(outputPath, 'utf-8'))
          }

          for (const r of results) {
            const segs: TranscriptSegment[] = (r.segments || []).map((s: any, i: number) => ({
              id: String(s.id || i), start: s.start || 0, end: s.end || 0, text: (s.text || '').trim()
            }))
            resultMap.set(r.id, segs)
          }
        } catch (err) {
          logger.error('[Whisper-Batch] Erreur parsing resultats:', err)
        }
      } else {
        logger.error(`[Whisper-Batch] Script termine avec code ${code}`)
      }

      try { ul(outputPath) } catch {}
      logger.info(`=== Fin batch Whisper : ${resultMap.size}/${clips.length} clips ===`)
      resolve(resultMap)
    })

    proc.on('error', (err) => {
      logger.error('[Whisper-Batch] Erreur process:', err)
      resolve(new Map())
    })
  })
}

export function cancelTranscription(): void {
  if (whisperProcess) {
    logger.info('Annulation transcription...')
    whisperProcess.kill()
    whisperProcess = null
  }
}

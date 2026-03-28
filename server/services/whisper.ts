import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { logger } from '../logger.js'

interface TranscriptSegment {
  id: string
  start: number
  end: number
  text: string
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
  onProgress: (percent: number) => void
): Promise<TranscriptSegment[]> {
  return new Promise(async (resolve, reject) => {
    const model = currentModel || 'medium'
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

export function cancelTranscription(): void {
  if (whisperProcess) {
    logger.info('Annulation transcription...')
    whisperProcess.kill()
    whisperProcess = null
  }
}

import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { logger, getDataDir } from '../logger.js'

/**
 * WHISPER.TS : Service de reconnaissance vocale (version web/serveur)
 *
 * Identique à la version Electron, sans dépendances Electron.
 */

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
  if (existsSync(devPath)) {
    return devPath
  }
  return devPath
}

async function getPythonCommand(): Promise<string | null> {
  const commands = ['python3', 'python', 'py']

  for (const cmd of commands) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        const proc = spawn(cmd, ['--version'])
        proc.on('close', (code) => resolve(code === 0))
        proc.on('error', () => resolve(false))
      })
      if (result) return cmd
    } catch {
      continue
    }
  }
  return null
}

export async function loadWhisperModel(model: string): Promise<void> {
  currentModel = model
  return Promise.resolve()
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

    const pythonCmd = await getPythonCommand()
    if (!pythonCmd) {
      logger.error('Python non trouvé')
      reject(new Error('Python non trouvé. Veuillez installer Python 3.'))
      return
    }

    const scriptPath = getTranscribeScriptPath()
    logger.info('Chemin du script :', scriptPath, 'existe :', existsSync(scriptPath))

    if (!existsSync(scriptPath)) {
      logger.error('Script de transcription non trouvé :', scriptPath)
      reject(new Error(`Script de transcription non trouvé : ${scriptPath}`))
      return
    }

    const tempDir = join(getDataDir(), 'temp')
    const outputPath = join(tempDir, `transcript_${Date.now()}.json`)

    logger.info('=== Démarrage de la transcription ===')
    logger.info('Python :', pythonCmd)
    logger.info('Script :', scriptPath)
    logger.info('Audio :', audioPath)
    logger.info('Modèle :', model, '| Langue :', language)
    logger.info('Sortie :', outputPath)

    const args = [
      scriptPath,
      audioPath,
      '--model', model,
      '--language', language,
      '--output', outputPath
    ]

    whisperProcess = spawn(pythonCmd, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdoutData = ''

    whisperProcess.stdout?.on('data', (data) => {
      stdoutData += data.toString()
    })

    whisperProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('PROGRESS:')) {
          const progress = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(progress)) {
            onProgress(progress)
          }
        } else if (line.startsWith('STATUS:')) {
          logger.info('[Whisper]', line.replace('STATUS:', '').trim())
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
          } catch (e) {
            // Ignorer les erreurs de parsing JSON partiel
          }
        } else if (line.startsWith('WHISPER_ENGINE:')) {
          logger.info('[Whisper] Moteur :', line.replace('WHISPER_ENGINE:', '').trim())
        } else if (line.startsWith('ERROR:')) {
          logger.error('[Whisper] Erreur :', line.replace('ERROR:', '').trim())
        } else if (line.trim() && !line.includes('UserWarning')) {
          logger.info('[Whisper]', line.trim())
        }
      }
    })

    whisperProcess.on('close', (code) => {
      whisperProcess = null
      logger.info('=== Fin du processus Whisper ===', 'Code :', code)

      if (code === 0) {
        if (segments.length > 0) {
          logger.info(`Transcription terminée : ${segments.length} segments reçus via flux`)
          resolve(segments)
          return
        }

        try {
          if (existsSync(outputPath)) {
            const data = JSON.parse(readFileSync(outputPath, 'utf-8'))
            const transcriptSegments: TranscriptSegment[] = (data.segments || []).map(
              (s: any, i: number) => ({
                id: String(s.id || i),
                start: s.start || 0,
                end: s.end || 0,
                text: (s.text || '').trim()
              })
            )
            transcriptSegments.forEach(onSegment)
            logger.info(`Transcription terminée : ${transcriptSegments.length} segments lus depuis fichier`)
            resolve(transcriptSegments)
          } else {
            logger.error('Fichier de sortie non trouvé :', outputPath)
            reject(new Error('Fichier de sortie de transcription introuvable'))
          }
        } catch (err) {
          logger.error('Erreur lors de la lecture du JSON de transcription :', err)
          reject(err)
        }
      } else {
        reject(new Error(`La transcription a échoué avec le code ${code}`))
      }
    })

    whisperProcess.on('error', (err) => {
      whisperProcess = null
      logger.error('Erreur fatale du processus Whisper :', err)
      reject(err)
    })
  })
}

export function cancelTranscription(): void {
  if (whisperProcess) {
    logger.info('Annulation de la transcription...')
    whisperProcess.kill()
    whisperProcess = null
  }
}

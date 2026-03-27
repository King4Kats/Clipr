import { spawn, ChildProcess } from 'child_process'
import path, { join } from 'path'
import fs, { existsSync, readFileSync } from 'fs'
import { app } from 'electron'
import { logger } from './logger.js'

/**
 * WHISPER.TS : Service de reconnaissance vocale (ASR)
 * 
 * Interface de pilotage du moteur de transcription basé sur faster-whisper.
 * Ce service exécute un processus enfant Python pour traiter les fichiers audio
 * et renvoyer les segments textuels horodatés au format JSON.
 */

/**
 * Structure représentant un segment de texte transcrit avec ses marqueurs temporels.
 */
interface TranscriptSegment {
  id: string
  start: number // Début en secondes
  end: number   // Fin en secondes
  text: string  // Contenu textuel
}

// Instance du processus enfant Python
let whisperProcess: ChildProcess | null = null
// Nom du modèle actuellement chargé (tiny, base, small, medium)
let currentModel: string | null = null

/**
 * Identifie le chemin vers le script Python de transcription.
 * Gère les différents contextes d'exécution (développement, packagé, resources).
 */
function getTranscribeScriptPath(): string {
  // Contexte développement
  const devPath = join(process.cwd(), 'scripts', 'transcribe.py')
  if (existsSync(devPath)) {
    return devPath
  }

  // Contexte production (fichiers asar ou copiés)
  const prodPath = join(app.getAppPath(), 'scripts', 'transcribe.py')
  if (existsSync(prodPath)) {
    return prodPath
  }

  // Contexte production (extraResources dans l'installeur)
  const resourcesPath = join(process.resourcesPath, 'scripts', 'transcribe.py')
  if (existsSync(resourcesPath)) {
    return resourcesPath
  }

  return devPath
}

/**
 * Tente de localiser un interpréteur Python disponible sur le système.
 */
async function getPythonCommand(): Promise<string | null> {
  const commands = ['python', 'python3', 'py']

  for (const cmd of commands) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        const proc = spawn(cmd, ['--version'], { windowsHide: true })
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

/**
 * Définit le modèle Whisper à utiliser pour les prochaines transcriptions.
 */
export async function loadWhisperModel(model: string): Promise<void> {
  currentModel = model
  return Promise.resolve()
}

/**
 * Lance la transcription d'un fichier audio via le script Python.
 * Utilise faster-whisper pour optimiser les performances d'inférence locale.
 */
export function transcribe(
  audioPath: string,
  language: string,
  onSegment: (segment: TranscriptSegment) => void,
  onProgress: (percent: number) => void
): Promise<TranscriptSegment[]> {
  return new Promise(async (resolve, reject) => {
    const model = currentModel || 'medium'
    const segments: TranscriptSegment[] = []

    // Localisation de l'exécutable Python
    const pythonCmd = await getPythonCommand()
    if (!pythonCmd) {
      logger.error('Python non trouvé')
      reject(new Error('Python non trouvé. Veuillez installer Python 3.'))
      return
    }

    // Localisation du script de traitement
    const scriptPath = getTranscribeScriptPath()
    logger.info('Chemin du script :', scriptPath, 'existe :', existsSync(scriptPath))

    if (!existsSync(scriptPath)) {
      logger.error('Script de transcription non trouvé :', scriptPath)
      reject(new Error(`Script de transcription non trouvé : ${scriptPath}`))
      return
    }

    // Configuration de la sortie JSON temporaire
    const tempDir = join(app.getPath('temp'), 'decoupeur-video')
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

    // Exécution du processus enfant sans fenêtre CMD et sans shell intermédiaire
    whisperProcess = spawn(pythonCmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdoutData = ''

    // Capture des logs standards
    whisperProcess.stdout?.on('data', (data) => {
      stdoutData += data.toString()
    })

    // Analyse du flux d'erreur (utilisé pour le retour d'état en temps réel)
    whisperProcess.stderr?.on('data', (data) => {
      const text = data.toString()

      // Découpage par ligne pour traiter les ordres PROGRESS, STATUS et SEGMENT
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
          // Journalisation des autres sorties en ignorant les avertissements Python
          logger.info('[Whisper]', line.trim())
        }
      }
    })

    // Gestion de la fin du processus
    whisperProcess.on('close', (code) => {
      whisperProcess = null
      logger.info('=== Fin du processus Whisper ===', 'Code :', code)

      if (code === 0) {
        // Priorité aux segments capturés via le stream stderr
        if (segments.length > 0) {
          logger.info(`Transcription terminée : ${segments.length} segments reçus via flux`)
          resolve(segments)
          return
        }

        // Tentative de lecture du fichier JSON final en cas d'absence de stream
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

/**
 * Interrompt le processus de transcription en cours.
 */
export function cancelTranscription(): void {
  if (whisperProcess) {
    logger.info('Annulation de la transcription...')
    whisperProcess.kill()
    whisperProcess = null
  }
}

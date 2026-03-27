import ffmpeg from 'fluent-ffmpeg'
import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { logger } from './logger.js'

/**
 * FFMPEG.TS : Service de traitement vidéo
 * 
 * Wrapper technique autour de l'utilitaire FFmpeg gérant l'initialisation
 * des binaires, l'extraction de flux audio (PCM 16k mono pour Whisper),
 * et les opérations de montage (découpe sans réencodage, concaténation).
 */

// Chemins d'accès aux binaires FFmpeg et FFprobe
let ffmpegPath: string | null = null
let ffprobePath: string | null = null

/**
 * Initialisation des chemins FFmpeg.
 * Tente de localiser les binaires packagés (production), puis les installeurs npm (développement),
 * et enfin les emplacements système standard en cas d'échec.
 */
function initFFmpeg(): void {
  try {
    // Cas de l'application packagée (fichiers dans extraResources)
    if (app.isPackaged) {
      const resourcesPath = process.resourcesPath
      const bundledFfmpeg = join(resourcesPath, 'ffmpeg', 'ffmpeg.exe')
      const bundledFfprobe = join(resourcesPath, 'ffprobe', 'ffprobe.exe')

      if (existsSync(bundledFfmpeg)) {
        ffmpegPath = bundledFfmpeg
        logger.info('Utilisation de FFmpeg packagé :', ffmpegPath)
      }
      if (existsSync(bundledFfprobe)) {
        ffprobePath = bundledFfprobe
        logger.info('Utilisation de FFprobe packagé :', ffprobePath)
      }
    }

    // En mode développement, tentative d'utilisation de @ffmpeg-installer
    if (!ffmpegPath) {
      try {
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg')
        const ffprobeInstaller = require('@ffprobe-installer/ffprobe')
        ffmpegPath = ffmpegInstaller.path
        ffprobePath = ffprobeInstaller.path
        logger.info('Utilisation de @ffmpeg-installer :', ffmpegPath)
      } catch (e) {
        logger.info('@ffmpeg-installer non disponible')
      }
    }

    // Solution de secours : vérification des emplacements Windows standards
    if (!ffmpegPath) {
      const possiblePaths = [
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin', 'ffmpeg.exe')
      ]

      for (const p of possiblePaths) {
        if (existsSync(p)) {
          ffmpegPath = p
          ffprobePath = p.replace('ffmpeg.exe', 'ffprobe.exe')
          logger.info('Utilisation de FFmpeg système :', ffmpegPath)
          break
        }
      }
    }

    // Configuration des chemins si trouvés
    if (ffmpegPath && existsSync(ffmpegPath)) {
      ffmpeg.setFfmpegPath(ffmpegPath)
    }
    if (ffprobePath && existsSync(ffprobePath)) {
      ffmpeg.setFfprobePath(ffprobePath)
    }

    // Si aucun binaire n'est localisé, on se base sur la variable d'environnement PATH
    if (!ffmpegPath) {
      logger.info('FFmpeg non trouvé, utilisation du PATH système')
    }
  } catch (e) {
    logger.info('Erreur d\'initialisation FFmpeg :', e)
  }
}

// Initialisation au chargement du module
initFFmpeg()

/**
 * Retourne le chemin du répertoire temporaire dédié à l'application.
 * Crée le répertoire s'il n'existe pas.
 */
function getTempDir(): string {
  const tempDir = join(app.getPath('temp'), 'decoupeur-video')
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }
  return tempDir
}

/**
 * Vérifie la disponibilité de FFmpeg.
 */
export async function checkFFmpeg(): Promise<boolean> {
  try {
    const cmd = ffmpegPath || 'ffmpeg'
    const result = spawnSync(cmd, ['-version'], { windowsHide: true })
    return result.status === 0
  } catch (e) {
    return false
  }
}

/**
 * Récupère la durée de la vidéo en secondes via ffprobe.
 * Utilise un spawn manuel avec windowsHide pour éviter le flash CMD sur Windows.
 */
export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const cmd = ffprobePath || 'ffprobe'
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', videoPath]

    const proc = spawn(cmd, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`))
        return
      }
      try {
        const data = JSON.parse(stdout)
        const duration = parseFloat(data.format?.duration) || 0
        resolve(duration)
      } catch (e) {
        reject(new Error(`Impossible de lire la sortie ffprobe: ${stdout}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Erreur ffprobe: ${err.message}`))
    })
  })
}

/**
 * Applique windowsHide sur un objet fluent-ffmpeg pour éviter le flash CMD.
 */
function hideWindow(command: any): void {
  if (typeof command.spawnOptions === 'function') {
    command.spawnOptions({ windowsHide: true })
  }
  // Fallback : écriture directe sur la propriété interne
  if (!command.options) command.options = {}
  command.options.spawnOptions = { windowsHide: true }
}

/**
 * Extrait la piste audio d'une vidéo et la convertit au format WAV (PCM 16kHz mono).
 * Ce format est requis pour une transcription optimale par Whisper.
 */
export function extractAudio(
  videoPath: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tempDir = getTempDir()
    const outputPath = join(tempDir, `audio_${Date.now()}.wav`)
    const command = ffmpeg(videoPath) as any;
    hideWindow(command)

    command
      .toFormat('wav')
      .audioFrequency(16000)
      .audioChannels(1)
      .on('progress', (progress: any) => {
        if (progress.percent && onProgress) {
          onProgress(progress.percent)
        }
      })
      .on('end', () => {
        resolve(outputPath)
      })
      .on('error', (err: any) => {
        reject(err)
      })
      .save(outputPath)
  })
}

/**
 * Découpe un segment de la vidéo source vers un nouveau fichier.
 * Utilise le codec libx264 avec un facteur de qualité (CRF) ajustable.
 */
export function cutVideo(
  inputPath: string,
  start: number,
  end: number,
  outputPath: string,
  quality: number = 23,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = end - start

    const command = ffmpeg(inputPath) as any;
    hideWindow(command)
    command
      .setStartTime(start)
      .setDuration(duration)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('192k')
      .addOption('-crf', String(quality))
      .addOption('-preset', 'medium')
      .addOption('-movflags', '+faststart')
      .on('progress', (progress: any) => {
        if (progress.percent && onProgress) {
          onProgress(progress.percent)
        }
      })
      .on('end', () => {
        resolve()
      })
      .on('error', (err: any) => {
        reject(err)
      })
      .save(outputPath)
  })
}

/**
 * Concatène plusieurs fichiers vidéo en un seul fichier de sortie.
 * FFmpeg fusionne les flux dans l'ordre de la liste fournie.
 */
export function concatenateVideos(
  inputPaths: string[],
  outputPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg()

    inputPaths.forEach((path) => {
      command.input(path)
    })

    const cmdAny = command as any;
    hideWindow(cmdAny)

    cmdAny
      .audioCodec('aac')
      .audioBitrate('192k')
      .on('progress', (progress: any) => {
        if (progress.percent && onProgress) {
          onProgress(progress.percent)
        }
      })
      .on('end', () => {
        resolve()
      })
      .on('error', (err: any) => {
        reject(err)
      })
      .mergeToFile(outputPath, getTempDir())
  })
}
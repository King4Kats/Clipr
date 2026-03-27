import ffmpeg from 'fluent-ffmpeg'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { logger, getDataDir } from '../logger.js'

/**
 * FFMPEG.TS : Service de traitement vidéo (version web/serveur)
 *
 * Identique à la version Electron, mais sans dépendances Electron.
 * Les binaires FFmpeg sont cherchés dans le PATH système ou dans les
 * emplacements standards Linux/Docker.
 */

let ffmpegPath: string | null = null
let ffprobePath: string | null = null

function initFFmpeg(): void {
  try {
    // En Docker/Linux, ffmpeg est dans le PATH
    const result = spawnSync('which', ['ffmpeg'], { encoding: 'utf-8' })
    if (result.status === 0 && result.stdout.trim()) {
      ffmpegPath = result.stdout.trim()
      logger.info('FFmpeg trouvé :', ffmpegPath)
    }

    const result2 = spawnSync('which', ['ffprobe'], { encoding: 'utf-8' })
    if (result2.status === 0 && result2.stdout.trim()) {
      ffprobePath = result2.stdout.trim()
      logger.info('FFprobe trouvé :', ffprobePath)
    }

    // Essayer @ffmpeg-installer en fallback (npm)
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

    if (ffmpegPath && existsSync(ffmpegPath)) {
      ffmpeg.setFfmpegPath(ffmpegPath)
    }
    if (ffprobePath && existsSync(ffprobePath)) {
      ffmpeg.setFfprobePath(ffprobePath)
    }

    if (!ffmpegPath) {
      logger.info('FFmpeg non trouvé, utilisation du PATH système')
    }
  } catch (e) {
    logger.info('Erreur d\'initialisation FFmpeg :', e)
  }
}

initFFmpeg()

function getTempDir(): string {
  const tempDir = join(getDataDir(), 'temp')
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }
  return tempDir
}

export function getUploadsDir(): string {
  const uploadsDir = join(getDataDir(), 'uploads')
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true })
  }
  return uploadsDir
}

export function getExportsDir(): string {
  const exportsDir = join(getDataDir(), 'exports')
  if (!existsSync(exportsDir)) {
    mkdirSync(exportsDir, { recursive: true })
  }
  return exportsDir
}

export async function checkFFmpeg(): Promise<boolean> {
  try {
    const cmd = ffmpegPath || 'ffmpeg'
    const result = spawnSync(cmd, ['-version'])
    return result.status === 0
  } catch (e) {
    return false
  }
}

export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const cmd = ffprobePath || 'ffprobe'
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', videoPath]

    const proc = spawn(cmd, args, {
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

export function extractAudio(
  videoPath: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tempDir = getTempDir()
    const outputPath = join(tempDir, `audio_${Date.now()}.wav`)
    const command = ffmpeg(videoPath) as any

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

    const command = ffmpeg(inputPath) as any
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

export function convertToMp4(
  inputPath: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tempDir = getTempDir()
    const outputPath = join(tempDir, `preview_${Date.now()}.mp4`)
    const command = ffmpeg(inputPath) as any

    command
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('192k')
      .addOption('-crf', '23')
      .addOption('-preset', 'fast')
      .addOption('-movflags', '+faststart')
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

    const cmdAny = command as any

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

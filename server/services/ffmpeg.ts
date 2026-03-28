import ffmpeg from 'fluent-ffmpeg'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { spawn } from 'child_process'
import { logger } from '../logger.js'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const TEMP_DIR = join(DATA_DIR, 'temp')

if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })

export function getTempDir(): string {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })
  return TEMP_DIR
}

export async function checkFFmpeg(): Promise<boolean> {
  try {
    const result = require('child_process').spawnSync('ffmpeg', ['-version'])
    return result.status === 0
  } catch { return false }
}

export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', videoPath]
    const proc = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffprobe code ${code}: ${stderr}`)); return }
      try {
        const data = JSON.parse(stdout)
        resolve(parseFloat(data.format?.duration) || 0)
      } catch { reject(new Error(`Impossible de lire la sortie ffprobe: ${stdout}`)) }
    })
    proc.on('error', (err) => reject(new Error(`Erreur ffprobe: ${err.message}`)))
  })
}

export function extractAudio(videoPath: string, onProgress?: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const outputPath = join(TEMP_DIR, `audio_${Date.now()}.wav`)
    ffmpeg(videoPath)
      .toFormat('wav')
      .audioFrequency(16000)
      .audioChannels(1)
      .on('progress', (p: any) => { if (p.percent && onProgress) onProgress(p.percent) })
      .on('end', () => resolve(outputPath))
      .on('error', (err: any) => reject(err))
      .save(outputPath)
  })
}

export function cutVideo(inputPath: string, start: number, end: number, outputPath: string, quality: number = 23): Promise<void> {
  return new Promise((resolve, reject) => {
    const dir = require('path').dirname(outputPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(end - start)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('192k')
      .addOption('-crf', String(quality))
      .addOption('-preset', 'medium')
      .addOption('-movflags', '+faststart')
      .on('end', () => resolve())
      .on('error', (err: any) => reject(err))
      .save(outputPath)
  })
}

export function concatenateVideos(inputPaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg()
    inputPaths.forEach(p => command.input(p))

    command
      .audioCodec('aac')
      .audioBitrate('192k')
      .on('end', () => resolve())
      .on('error', (err: any) => reject(err))
      .mergeToFile(outputPath, TEMP_DIR)
  })
}

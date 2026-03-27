import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from 'fs'
import { app, BrowserWindow } from 'electron'
import https from 'https'
import { logger } from './logger.js'

export interface ModelStatus {
  whisper: {
    model: string
    downloaded: boolean
    downloading: boolean
    progress: number
  }
  llm: {
    model: string
    downloaded: boolean
    downloading: boolean
    progress: number
  }
}

// Modèles par défaut utilisés par l'application
const DEFAULT_WHISPER_MODEL = 'base' // 142MB - bon compromis vitesse/précision
const DEFAULT_LLM_MODEL = 'Qwen2.5-3B' // 2.1GB - performant et rapide

// Définitions des modèles disponibles
const WHISPER_MODELS: Record<string, { url: string; size: number }> = {
  'tiny': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin', size: 75 },
  'base': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', size: 142 },
  'small': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', size: 466 },
  'medium': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin', size: 1500 }
}

const LLM_MODELS: Record<string, { url: string; size: number; filename: string }> = {
  'Qwen2.5-3B': {
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    size: 2100,
    filename: 'qwen2.5-3b-instruct-q4_k_m.gguf'
  },
  'Phi-3-mini': {
    url: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
    size: 2300,
    filename: 'phi-3-mini-4k-instruct-q4.gguf'
  }
}

let mainWindow: BrowserWindow | null = null

/**
 * Associe la fenêtre principale pour permettre l'envoi de notifications de progression.
 */
export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window
}

/**
 * Détermine le répertoire de stockage des modèles en fonction du type (whisper ou llm).
 * Utilise le répertoire de données utilisateur en production et le répertoire courant en développement.
 */
function getModelsDir(type: 'whisper' | 'llm'): string {
  const modelsDir = app.isPackaged
    ? join(app.getPath('userData'), 'models', type)
    : join(process.cwd(), 'models', type)

  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true })
  }
  return modelsDir
}

/**
 * Retourne le chemin complet vers un modèle Whisper spécifié.
 */
export function getWhisperModelPath(model: string): string {
  return join(getModelsDir('whisper'), `ggml-${model}.bin`)
}

/**
 * Retourne le chemin complet vers un modèle LLM spécifié.
 */
export function getLLMModelPath(model: string): string {
  const modelInfo = LLM_MODELS[model]
  return join(getModelsDir('llm'), modelInfo?.filename || 'model.gguf')
}

/**
 * Vérifie si un modèle Whisper est présent sur le disque.
 */
export function isWhisperModelDownloaded(model: string = DEFAULT_WHISPER_MODEL): boolean {
  return existsSync(getWhisperModelPath(model))
}

/**
 * Vérifie si un modèle LLM est présent sur le disque.
 */
export function isLLMModelDownloaded(model: string = DEFAULT_LLM_MODEL): boolean {
  return existsSync(getLLMModelPath(model))
}

/**
 * Vérifie si l'ensemble des modèles requis est disponible pour le traitement.
 */
export function areModelsReady(): boolean {
  return isWhisperModelDownloaded() && isLLMModelDownloaded()
}

/**
 * Envoie une mise à jour de progression du téléchargement au processus de rendu.
 */
function sendProgress(type: 'whisper' | 'llm', progress: number, message: string): void {
  if (mainWindow) {
    mainWindow.webContents.send('model:progress', { type, progress, message })
  }
}

/**
 * Gère le téléchargement sécurisé d'un fichier via HTTPS avec support des redirections.
 */
function downloadFile(url: string, destPath: string, expectedSizeMB: number, type: 'whisper' | 'llm'): Promise<void> {
  return new Promise((resolve, reject) => {
    // Suppression du fichier partiel s'il existe déjà
    if (existsSync(destPath)) {
      unlinkSync(destPath)
    }

    const file = createWriteStream(destPath)
    const expectedSize = expectedSizeMB * 1024 * 1024

    const downloadWithRedirect = (downloadUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Trop de redirections'))
        return
      }

      const protocol = downloadUrl.startsWith('https') ? https : require('http')

      protocol.get(downloadUrl, (response: any) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            downloadWithRedirect(redirectUrl, redirectCount + 1)
            return
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Échec du téléchargement : HTTP ${response.statusCode}`))
          return
        }

        let downloaded = 0

        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          const percent = Math.round((downloaded / expectedSize) * 100)
          const downloadedMB = Math.round(downloaded / 1024 / 1024)
          sendProgress(type, Math.min(percent, 99), `${downloadedMB}MB / ${expectedSizeMB}MB`)
        })

        response.pipe(file)

        file.on('finish', () => {
          file.close()
          sendProgress(type, 100, 'Terminé')
          resolve()
        })

        file.on('error', (err: Error) => {
          unlinkSync(destPath)
          reject(err)
        })
      }).on('error', (err: Error) => {
        unlinkSync(destPath)
        reject(err)
      })
    }

    downloadWithRedirect(url)
  })
}

/**
 * Initie le téléchargement du modèle Whisper spécifié.
 */
export async function downloadWhisperModel(model: string = DEFAULT_WHISPER_MODEL): Promise<void> {
  const modelInfo = WHISPER_MODELS[model]
  if (!modelInfo) {
    throw new Error(`Modèle Whisper inconnu : ${model}`)
  }

  const destPath = getWhisperModelPath(model)

  if (existsSync(destPath)) {
    logger.info(`Le modèle Whisper ${model} est déjà présent`)
    return
  }

  logger.info(`Téléchargement du modèle Whisper ${model}...`)
  sendProgress('whisper', 0, `Téléchargement du modèle Whisper ${model}...`)

  await downloadFile(modelInfo.url, destPath, modelInfo.size, 'whisper')
  logger.info(`Modèle Whisper ${model} téléchargé avec succès`)
}

/**
 * Initie le téléchargement du modèle LLM spécifié.
 */
export async function downloadLLMModel(model: string = DEFAULT_LLM_MODEL): Promise<void> {
  const modelInfo = LLM_MODELS[model]
  if (!modelInfo) {
    throw new Error(`Modèle LLM inconnu : ${model}`)
  }

  const destPath = getLLMModelPath(model)

  if (existsSync(destPath)) {
    logger.info(`Le modèle LLM ${model} est déjà présent`)
    return
  }

  logger.info(`Téléchargement du modèle LLM ${model}...`)
  sendProgress('llm', 0, `Téléchargement du modèle IA ${model}...`)

  await downloadFile(modelInfo.url, destPath, modelInfo.size, 'llm')
  logger.info(`Modèle LLM ${model} téléchargé avec succès`)
}

/**
 * S'assure que tous les modèles requis sont téléchargés sur le système.
 */
export async function ensureModelsDownloaded(): Promise<void> {
  const tasks: Promise<void>[] = []

  if (!isWhisperModelDownloaded()) {
    tasks.push(downloadWhisperModel())
  }

  if (!isLLMModelDownloaded()) {
    tasks.push(downloadLLMModel())
  }

  if (tasks.length > 0) {
    await Promise.all(tasks)
  }
}

/**
 * Retourne l'état actuel de disponibilité des modèles.
 */
export function getModelStatus(): ModelStatus {
  return {
    whisper: {
      model: DEFAULT_WHISPER_MODEL,
      downloaded: isWhisperModelDownloaded(),
      downloading: false,
      progress: isWhisperModelDownloaded() ? 100 : 0
    },
    llm: {
      model: DEFAULT_LLM_MODEL,
      downloaded: isLLMModelDownloaded(),
      downloading: false,
      progress: isLLMModelDownloaded() ? 100 : 0
    }
  }
}
/**
 * WHISPER-NATIVE.TS : Moteur de transcription natif (whisper-node)
 *
 * Alternative au script Python, ce service utilise directement whisper-node
 * pour transcrire les fichiers audio en texte. Il gere le telechargement
 * des modeles GGML depuis Hugging Face et la transcription locale.
 *
 * Fonctionnalites principales :
 * - Telechargement automatique des modeles Whisper (tiny -> large)
 * - Chargement du module whisper-node a la demande
 * - Transcription avec suivi de progression et emission de segments
 * - Gestion de l'annulation de transcription
 */

import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import https from 'https'
import fs from 'fs'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Types et interfaces pour la transcription
// ---------------------------------------------------------------------------

/** Segment de transcription avec identifiant, bornes temporelles et texte */
interface TranscriptSegment {
  id: string
  start: number
  end: number
  text: string
}

/** Resultat brut retourne par whisper-node */
interface WhisperResult {
  segments: Array<{
    start: number
    end: number
    text: string
  }>
}

// ---------------------------------------------------------------------------
// Variables d'etat du module
// ---------------------------------------------------------------------------

/** Instance du module whisper-node (charge dynamiquement) */
let whisperModule: any = null

/** Chemin du modele actuellement charge en memoire */
let currentModelPath: string | null = null

/** Indicateur de transcription en cours (empeche les executions simultanees) */
let isTranscribing = false

// ---------------------------------------------------------------------------
// URLs de telechargement des modeles (Hugging Face)
// ---------------------------------------------------------------------------

/** URLs des fichiers GGML pour chaque taille de modele Whisper */
const MODEL_URLS: Record<string, string> = {
  'tiny': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  'base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  'medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
  'large': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
}

/** Taille approximative de chaque modele en megaoctets (pour le calcul de progression) */
const MODEL_SIZES: Record<string, number> = {
  'tiny': 75,      // Mo
  'base': 142,
  'small': 466,
  'medium': 1500,
  'large': 3100
}

// ---------------------------------------------------------------------------
// Gestion des chemins et verification des modeles
// ---------------------------------------------------------------------------

/**
 * Retourne le chemin du repertoire de stockage des modeles Whisper.
 * En production, utilise le dossier userData d'Electron.
 * En developpement, utilise le dossier courant du projet.
 * Cree le repertoire s'il n'existe pas.
 */
function getModelsDir(): string {
  // En production, utiliser le repertoire de donnees de l'application
  const modelsDir = app.isPackaged
    ? join(app.getPath('userData'), 'models', 'whisper')
    : join(process.cwd(), 'models', 'whisper')

  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true })
  }
  return modelsDir
}

/**
 * Construit le chemin complet du fichier modele a partir de son nom.
 * @param modelName - Nom du modele (ex: 'tiny', 'base', 'small', etc.)
 * @returns Chemin absolu vers le fichier .bin du modele
 */
function getModelPath(modelName: string): string {
  return join(getModelsDir(), `ggml-${modelName}.bin`)
}

/**
 * Verifie si un modele Whisper est deja telecharge sur le disque.
 * @param modelName - Nom du modele a verifier
 * @returns true si le fichier du modele existe
 */
export function isModelDownloaded(modelName: string): boolean {
  return existsSync(getModelPath(modelName))
}

// ---------------------------------------------------------------------------
// Telechargement des modeles depuis Hugging Face
// ---------------------------------------------------------------------------

/**
 * Telecharge un modele Whisper depuis Hugging Face avec suivi de progression.
 * Gere les redirections HTTP (codes 301/302) automatiquement.
 * Si le modele est deja present, retourne immediatement son chemin.
 *
 * @param modelName - Nom du modele a telecharger (ex: 'small', 'medium')
 * @param onProgress - Callback de progression (pourcentage et message)
 * @returns Promesse resolue avec le chemin du fichier telecharge
 */
export function downloadModel(
  modelName: string,
  onProgress: (percent: number, message: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = MODEL_URLS[modelName]
    if (!url) {
      reject(new Error(`Unknown model: ${modelName}`))
      return
    }

    const modelPath = getModelPath(modelName)

    // Verification si le modele est deja telecharge
    if (existsSync(modelPath)) {
      resolve(modelPath)
      return
    }

    onProgress(0, `Téléchargement du modèle ${modelName}...`)

    // Creation du flux d'ecriture vers le fichier destination
    const file = fs.createWriteStream(modelPath)
    const expectedSize = MODEL_SIZES[modelName] * 1024 * 1024 // Conversion en octets

    // Fonction recursive pour gerer les redirections HTTP
    const downloadWithRedirect = (downloadUrl: string) => {
      https.get(downloadUrl, (response) => {
        // Gestion des redirections HTTP (Hugging Face redirige souvent)
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            downloadWithRedirect(redirectUrl)
            return
          }
        }

        // Verification du code de reponse HTTP
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: ${response.statusCode}`))
          return
        }

        // Suivi de la progression du telechargement
        let downloaded = 0

        response.on('data', (chunk) => {
          downloaded += chunk.length
          const percent = Math.round((downloaded / expectedSize) * 100)
          onProgress(Math.min(percent, 99), `Téléchargement ${modelName}: ${Math.round(downloaded / 1024 / 1024)}MB`)
        })

        // Ecriture du flux de donnees dans le fichier
        response.pipe(file)

        // Fin du telechargement : fermeture du fichier et notification
        file.on('finish', () => {
          file.close()
          onProgress(100, `Modèle ${modelName} téléchargé`)
          resolve(modelPath)
        })

        // Erreur d'ecriture : suppression du fichier partiel
        file.on('error', (err) => {
          fs.unlink(modelPath, () => {}) // Supprimer le fichier incomplet
          reject(err)
        })
      }).on('error', reject)
    }

    downloadWithRedirect(url)
  })
}

// ---------------------------------------------------------------------------
// Chargement du modele Whisper en memoire
// ---------------------------------------------------------------------------

/**
 * Charge un modele Whisper en memoire pour la transcription.
 * Telecharge le modele automatiquement s'il n'est pas present et qu'un
 * callback de progression est fourni.
 *
 * @param modelName - Nom du modele a charger
 * @param onProgress - Callback optionnel de progression (pour le telechargement)
 * @throws Erreur si le modele n'est pas trouve et aucun callback de progression n'est fourni
 */
export async function loadWhisperModel(
  modelName: string,
  onProgress?: (percent: number, message: string) => void
): Promise<void> {
  const modelPath = getModelPath(modelName)

  // Telechargement automatique si le modele est absent
  if (!existsSync(modelPath)) {
    if (onProgress) {
      await downloadModel(modelName, onProgress)
    } else {
      throw new Error(`Model ${modelName} not found. Please download it first.`)
    }
  }

  currentModelPath = modelPath

  // Chargement dynamique du module whisper-node (une seule fois)
  if (!whisperModule) {
    try {
      whisperModule = await import('whisper-node')
    } catch (error) {
      logger.error('Failed to load whisper-node:', error)
      throw new Error('whisper-node module not available')
    }
  }
}

// ---------------------------------------------------------------------------
// Transcription audio -> texte
// ---------------------------------------------------------------------------

/**
 * Transcrit un fichier audio en texte en utilisant whisper-node.
 * Emet chaque segment au fur et a mesure via le callback onSegment.
 * Une seule transcription peut etre en cours a la fois.
 *
 * @param audioPath - Chemin du fichier audio a transcrire (WAV recommande)
 * @param language - Code langue ('fr', 'en', etc.)
 * @param onSegment - Callback appele pour chaque segment transcrit
 * @param onProgress - Callback de progression (0 a 100)
 * @returns Tableau de tous les segments transcrits
 * @throws Erreur si aucun modele n'est charge ou si une transcription est deja en cours
 */
export async function transcribe(
  audioPath: string,
  language: string,
  onSegment: (segment: TranscriptSegment) => void,
  onProgress: (percent: number) => void
): Promise<TranscriptSegment[]> {
  if (!currentModelPath) {
    throw new Error('No model loaded. Call loadWhisperModel first.')
  }

  if (isTranscribing) {
    throw new Error('Transcription already in progress')
  }

  isTranscribing = true
  onProgress(0)

  try {
    const whisper = whisperModule.default || whisperModule

    // Configuration des options de Whisper (langue et timestamps par mot)
    const options = {
      modelPath: currentModelPath,
      whisperOptions: {
        language: language === 'fr' ? 'french' : language === 'en' ? 'english' : language,
        word_timestamps: true
      }
    }

    onProgress(10)

    // Lancement de la transcription
    const result: WhisperResult = await whisper(audioPath, options)

    onProgress(90)

    // Conversion du resultat brut vers notre format de segments
    const segments: TranscriptSegment[] = (result.segments || []).map((seg, i) => ({
      id: String(i),
      start: seg.start,
      end: seg.end,
      text: seg.text.trim()
    }))

    // Emission de chaque segment vers l'appelant
    segments.forEach(onSegment)

    onProgress(100)
    isTranscribing = false

    return segments
  } catch (error) {
    isTranscribing = false
    throw error
  }
}

// ---------------------------------------------------------------------------
// Annulation de transcription
// ---------------------------------------------------------------------------

/**
 * Annule la transcription en cours.
 * Note : whisper-node ne supporte pas l'annulation directe,
 * ce drapeau empeche simplement le lancement de nouvelles transcriptions.
 */
export function cancelTranscription(): void {
  // whisper-node ne permet pas d'annuler une transcription en cours
  // On remet le drapeau a false pour autoriser de futures transcriptions
  isTranscribing = false
}

// ---------------------------------------------------------------------------
// Informations sur les modeles disponibles
// ---------------------------------------------------------------------------

/**
 * Retourne la liste des modeles Whisper disponibles avec leur statut.
 * @returns Tableau d'objets contenant le nom, la taille (Mo) et l'etat de telechargement
 */
export function getAvailableModels(): Array<{ name: string; size: number; downloaded: boolean }> {
  return Object.keys(MODEL_URLS).map(name => ({
    name,
    size: MODEL_SIZES[name],
    downloaded: isModelDownloaded(name)
  }))
}

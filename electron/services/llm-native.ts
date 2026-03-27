/**
 * LLM-NATIVE.TS : Moteur d'analyse IA natif (node-llama-cpp)
 *
 * Alternative a Ollama, ce service charge et execute directement des modeles
 * GGUF (Qwen, Phi-3) via node-llama-cpp pour l'analyse semantique des
 * transcriptions. Gere le telechargement, le chargement en memoire et l'inference.
 *
 * Avantages par rapport a Ollama :
 * - Pas besoin d'installer un serveur externe
 * - Controle direct sur le chargement/dechargement des modeles
 * - Integration plus legere pour les petits modeles GGUF
 */

import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream } from 'fs'
import { app } from 'electron'
import https from 'https'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Types et interfaces pour les modeles LLM
// ---------------------------------------------------------------------------

/** Description d'un modele LLM disponible au telechargement */
interface ModelInfo {
  name: string
  url: string
  size: number // Taille en Mo
  filename: string
}

// ---------------------------------------------------------------------------
// Catalogue des modeles GGUF disponibles
// ---------------------------------------------------------------------------

/** Liste des modeles legers compatibles, heberges sur Hugging Face */
const AVAILABLE_MODELS: ModelInfo[] = [
  {
    name: 'Qwen2.5-3B',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    size: 2100,
    filename: 'qwen2.5-3b-instruct-q4_k_m.gguf'
  },
  {
    name: 'Phi-3-mini',
    url: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf',
    size: 2300,
    filename: 'phi-3-mini-4k-instruct-q4.gguf'
  }
]

// ---------------------------------------------------------------------------
// Variables d'etat du module
// ---------------------------------------------------------------------------

/** Instance du module node-llama-cpp (charge dynamiquement) */
let llamaModule: any = null

/** Modele LLM actuellement charge en memoire */
let currentModel: any = null

/** Contexte d'inference du modele charge */
let currentContext: any = null

// ---------------------------------------------------------------------------
// Gestion des chemins et verification des modeles
// ---------------------------------------------------------------------------

/**
 * Retourne le chemin du repertoire de stockage des modeles LLM.
 * En production, utilise le dossier userData d'Electron.
 * En developpement, utilise le dossier courant du projet.
 * Cree le repertoire s'il n'existe pas.
 */
function getModelsDir(): string {
  const modelsDir = app.isPackaged
    ? join(app.getPath('userData'), 'models', 'llm')
    : join(process.cwd(), 'models', 'llm')

  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true })
  }
  return modelsDir
}

/**
 * Construit le chemin complet du fichier modele a partir de son nom de fichier.
 * @param filename - Nom du fichier GGUF (ex: 'qwen2.5-3b-instruct-q4_k_m.gguf')
 * @returns Chemin absolu vers le fichier modele
 */
function getModelPath(filename: string): string {
  return join(getModelsDir(), filename)
}

/**
 * Verifie si un modele LLM est deja telecharge sur le disque.
 * @param modelName - Nom du modele a verifier (ex: 'Qwen2.5-3B')
 * @returns true si le fichier GGUF du modele existe
 */
export function isModelDownloaded(modelName: string): boolean {
  const model = AVAILABLE_MODELS.find(m => m.name === modelName)
  if (!model) return false
  return existsSync(getModelPath(model.filename))
}

// ---------------------------------------------------------------------------
// Telechargement des modeles depuis Hugging Face
// ---------------------------------------------------------------------------

/**
 * Telecharge un modele LLM au format GGUF depuis Hugging Face.
 * Gere les redirections HTTP (codes 301/302) automatiquement.
 * Si le modele est deja present, retourne immediatement son chemin.
 *
 * @param modelName - Nom du modele a telecharger (ex: 'Qwen2.5-3B', 'Phi-3-mini')
 * @param onProgress - Callback de progression (pourcentage et message)
 * @returns Promesse resolue avec le chemin du fichier telecharge
 */
export function downloadModel(
  modelName: string,
  onProgress: (percent: number, message: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const model = AVAILABLE_MODELS.find(m => m.name === modelName)
    if (!model) {
      reject(new Error(`Unknown model: ${modelName}`))
      return
    }

    const modelPath = getModelPath(model.filename)

    // Verification si le modele est deja telecharge
    if (existsSync(modelPath)) {
      resolve(modelPath)
      return
    }

    onProgress(0, `Téléchargement du modèle ${modelName}...`)

    // Creation du flux d'ecriture vers le fichier destination
    const file = createWriteStream(modelPath)
    const expectedSize = model.size * 1024 * 1024 // Conversion en octets

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
          onProgress(Math.min(percent, 99), `Téléchargement ${modelName}: ${Math.round(downloaded / 1024 / 1024)}MB / ${model.size}MB`)
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
          require('fs').unlink(modelPath, () => {})
          reject(err)
        })
      }).on('error', reject)
    }

    downloadWithRedirect(model.url)
  })
}

// ---------------------------------------------------------------------------
// Chargement et initialisation du modele LLM
// ---------------------------------------------------------------------------

/**
 * Charge un modele LLM en memoire via node-llama-cpp.
 * Telecharge le modele automatiquement s'il n'est pas present et qu'un
 * callback de progression est fourni.
 * Initialise egalement le contexte d'inference pour les sessions de chat.
 *
 * @param modelName - Nom du modele a charger (ex: 'Qwen2.5-3B')
 * @param onProgress - Callback optionnel de progression
 * @throws Erreur si le modele n'est pas trouve ou si node-llama-cpp n'est pas disponible
 */
export async function loadModel(
  modelName: string,
  onProgress?: (percent: number, message: string) => void
): Promise<void> {
  const model = AVAILABLE_MODELS.find(m => m.name === modelName) || AVAILABLE_MODELS[0]
  const modelPath = getModelPath(model.filename)

  // Telechargement automatique si le modele est absent
  if (!existsSync(modelPath)) {
    if (onProgress) {
      await downloadModel(model.name, onProgress)
    } else {
      throw new Error(`Model ${modelName} not found. Please download it first.`)
    }
  }

  // Chargement dynamique du module node-llama-cpp (une seule fois)
  if (!llamaModule) {
    try {
      llamaModule = await import('node-llama-cpp')
    } catch (error) {
      logger.error('Failed to load node-llama-cpp:', error)
      throw new Error('node-llama-cpp module not available')
    }
  }

  if (onProgress) onProgress(50, 'Chargement du modèle...')

  // Initialisation de llama : chargement du modele et creation du contexte
  const { getLlama, LlamaChatSession } = llamaModule

  const llama = await getLlama()
  currentModel = await llama.loadModel({ modelPath })
  currentContext = await currentModel.createContext()

  if (onProgress) onProgress(100, 'Modèle chargé')
}

// ---------------------------------------------------------------------------
// Analyse semantique de la transcription
// ---------------------------------------------------------------------------

/**
 * Analyse une transcription en utilisant le LLM charge pour identifier
 * les segments thematiques (sujets abordes, timestamps, descriptions).
 * Utilise un prompt systeme en francais avec des consignes strictes
 * pour obtenir un JSON structure en reponse.
 *
 * @param transcript - Texte de la transcription a analyser
 * @param context - Contexte supplementaire fourni par l'utilisateur
 * @returns Objet contenant un tableau de segments identifies
 */
export async function analyzeTranscript(
  transcript: string,
  context: string
): Promise<{ segments: Array<{ title: string; start: number; end: number; description?: string }> }> {
  // Si aucun modele n'est charge, tenter de charger le modele par defaut
  if (!currentModel || !currentContext) {
    await loadModel(AVAILABLE_MODELS[0].name)
  }

  // Creation d'une session de chat pour l'inference
  const { LlamaChatSession } = llamaModule
  const session = new LlamaChatSession({
    contextSequence: currentContext.getSequence()
  })

  // Prompt systeme : instructions pour l'analyse thematique
  const systemPrompt = `Tu es un assistant expert en analyse de contenu vidéo.
Ton rôle est d'identifier les différents sujets/thèmes abordés dans une transcription.

Instructions:
1. Identifie TOUS les sujets distincts abordés
2. Pour chaque sujet, donne un titre court et descriptif
3. Indique les timestamps de début et fin en SECONDES
4. Réponds UNIQUEMENT en JSON valide

${context ? `Contexte: ${context}` : ''}

Format de réponse (JSON uniquement):
{"segments":[{"title":"...","start":0,"end":120},{"title":"...","start":120,"end":300}]}`

  // Prompt utilisateur : la transcription a analyser
  const userPrompt = `Analyse cette transcription et identifie les segments thématiques:\n\n${transcript}`

  try {
    const response = await session.prompt(userPrompt, {
      systemPrompt,
      maxTokens: 2048
    })

    // Extraction du JSON depuis la reponse du LLM
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0])
      return result
    }

    throw new Error('Invalid response format')
  } catch (error) {
    logger.error('LLM analysis error:', error)
    // En cas d'erreur, retourner un resultat vide
    return { segments: [] }
  }
}

// ---------------------------------------------------------------------------
// Verification de la disponibilite du LLM
// ---------------------------------------------------------------------------

/**
 * Verifie si le moteur LLM natif est utilisable :
 * - Au moins un modele est telecharge
 * - Le module node-llama-cpp peut etre charge
 *
 * @returns true si le LLM natif est disponible et pret a l'emploi
 */
export async function checkLLM(): Promise<boolean> {
  try {
    // Verifier si au moins un modele est present sur le disque
    const hasModel = AVAILABLE_MODELS.some(m => existsSync(getModelPath(m.filename)))
    if (!hasModel) return false

    // Verifier que le module peut etre charge
    if (!llamaModule) {
      llamaModule = await import('node-llama-cpp')
    }
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Informations sur les modeles disponibles
// ---------------------------------------------------------------------------

/**
 * Retourne la liste des modeles LLM disponibles avec leur statut.
 * @returns Tableau d'objets contenant le nom, la taille (Mo) et l'etat de telechargement
 */
export function getAvailableModels(): Array<{ name: string; size: number; downloaded: boolean }> {
  return AVAILABLE_MODELS.map(m => ({
    name: m.name,
    size: m.size,
    downloaded: existsSync(getModelPath(m.filename))
  }))
}

// ---------------------------------------------------------------------------
// Liberation de la memoire
// ---------------------------------------------------------------------------

/**
 * Decharge le modele actuel et libere la memoire associee.
 * Doit etre appele lorsque le LLM n'est plus necessaire,
 * par exemple a la fermeture de l'application ou au changement de modele.
 */
export async function unloadModel(): Promise<void> {
  // Liberer le contexte d'inference en premier
  if (currentContext) {
    await currentContext.dispose()
    currentContext = null
  }
  // Puis liberer le modele lui-meme
  if (currentModel) {
    await currentModel.dispose()
    currentModel = null
  }
}

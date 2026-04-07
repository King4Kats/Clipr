/**
 * WHISPER.TS : Service de transcription audio via OpenAI Whisper
 *
 * Ce fichier fait le lien entre le serveur Node.js et le script Python
 * qui exécute Whisper (modèle d'IA de reconnaissance vocale d'OpenAI).
 *
 * Whisper tourne sur le GPU via un script Python (transcribe.py).
 * La communication se fait via stdin/stdout/stderr du processus fils :
 * - stderr : messages de progression (PROGRESS:XX), segments (SEGMENT:{...}), erreurs
 * - stdout : pas utilisé en mode streaming
 * - fichier de sortie JSON : fallback si le streaming ne fonctionne pas
 *
 * Ce fichier propose deux modes de transcription :
 * 1. transcribe() : transcription d'un seul fichier audio (mode standard)
 * 2. transcribeBatch() : transcription de plusieurs fichiers en une seule session
 *    (le modèle est chargé une seule fois, ce qui économise ~6s par fichier)
 */

// spawn : permet de lancer un processus fils (ici : python3 transcribe.py)
// ChildProcess : type TypeScript pour un processus fils
import { spawn, ChildProcess } from 'child_process'
// join : construit des chemins de fichiers de manière portable (Linux/Mac/Windows)
import { join } from 'path'
// existsSync : vérifie si un fichier existe | readFileSync : lit un fichier
import { existsSync, readFileSync } from 'fs'
// Logger pour les messages de debug dans la console serveur
import { logger } from '../logger.js'

/**
 * Interface décrivant un segment de transcription.
 * Un segment = une phrase ou portion de texte avec son timing.
 * Exemple : { id: "0", start: 0.0, end: 3.5, text: "Bonjour à tous", speaker: "Philippe" }
 */
interface TranscriptSegment {
  id: string        // Identifiant du segment (numéro séquentiel)
  start: number     // Temps de début en secondes
  end: number       // Temps de fin en secondes
  text: string      // Texte transcrit
  speaker?: string  // Nom du locuteur (ajouté après diarisation, optionnel)
}

// Référence vers le processus Whisper en cours (null si aucun)
// Utilisé pour pouvoir annuler une transcription en cours
let whisperProcess: ChildProcess | null = null

// Nom du modèle Whisper actuellement sélectionné
let currentModel: string | null = null

/**
 * Trouve le chemin du script Python de transcription.
 * Le script peut être à deux endroits selon qu'on est en développement
 * ou en production :
 * - En dev : ./scripts/transcribe.py (racine du projet)
 * - En prod : ../../scripts/transcribe.py (relatif au dossier compilé)
 */
function getTranscribeScriptPath(): string {
  const devPath = join(process.cwd(), 'scripts', 'transcribe.py')
  if (existsSync(devPath)) return devPath
  const altPath = join(__dirname, '..', '..', 'scripts', 'transcribe.py')
  if (existsSync(altPath)) return altPath
  return devPath // Retourne le chemin dev par défaut même s'il n'existe pas
}

/**
 * "Charge" le modèle Whisper. En réalité, cette fonction ne fait que mémoriser
 * le nom du modèle choisi. Le vrai chargement se fait dans le script Python
 * au moment de la transcription.
 *
 * Modèles disponibles : tiny, base, small, medium, large-v2, large-v3
 * Plus le modèle est gros, meilleure est la qualité mais plus c'est lent.
 *
 * @param model - Nom du modèle Whisper (ex: "large-v3")
 */
export async function loadWhisperModel(model: string): Promise<void> {
  currentModel = model
}

/**
 * Transcrit un fichier audio en texte via le script Python Whisper.
 *
 * Le processus fonctionne en streaming : les segments arrivent un par un
 * via stderr pendant que Whisper traite l'audio. Cela permet d'afficher
 * la transcription en temps réel dans l'interface.
 *
 * @param audioPath - Chemin vers le fichier audio à transcrire
 * @param language - Code langue (ex: "fr", "en", "es")
 * @param onSegment - Callback appelé pour chaque segment transcrit (temps réel)
 * @param onProgress - Callback appelé avec le pourcentage de progression
 * @param initialPrompt - Texte optionnel pour guider Whisper (noms propres, vocabulaire technique)
 * @returns Promesse qui résout avec le tableau complet des segments
 */
export function transcribe(
  audioPath: string,
  language: string,
  onSegment: (segment: TranscriptSegment) => void,
  onProgress: (percent: number) => void,
  initialPrompt?: string
): Promise<TranscriptSegment[]> {
  return new Promise(async (resolve, reject) => {
    const model = currentModel || 'large-v3'
    // Tableau qui accumule les segments reçus en streaming
    const segments: TranscriptSegment[] = []

    // Vérification que le script Python existe
    const scriptPath = getTranscribeScriptPath()
    logger.info('Script transcription:', scriptPath, 'existe:', existsSync(scriptPath))

    if (!existsSync(scriptPath)) {
      reject(new Error(`Script de transcription non trouve: ${scriptPath}`))
      return
    }

    // Dossier temporaire pour le fichier de sortie JSON (fallback)
    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const outputPath = join(DATA_DIR, 'temp', `transcript_${Date.now()}.json`)

    logger.info('=== Demarrage transcription ===')
    logger.info('Audio:', audioPath, '| Modele:', model, '| Langue:', language)

    // Construction des arguments pour le script Python
    const args = [scriptPath, audioPath, '--model', model, '--language', language, '--output', outputPath]
    // Le prompt initial aide Whisper à reconnaître des mots spécifiques
    // (noms propres, termes techniques, etc.)
    if (initialPrompt) {
      args.push('--prompt', initialPrompt)
      logger.info('Initial prompt:', initialPrompt.substring(0, 100) + '...')
    }

    // Lancement du processus Python. stdio: ['pipe', 'pipe', 'pipe'] signifie
    // qu'on peut communiquer via stdin, stdout et stderr
    whisperProcess = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    // Écoute de stderr : c'est par là que le script Python envoie les données
    // en streaming (progression, segments, erreurs)
    whisperProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('PROGRESS:')) {
          // Message de progression : "PROGRESS:42" → 42%
          const progress = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(progress)) onProgress(progress)
        } else if (line.startsWith('SEGMENT:')) {
          // Nouveau segment transcrit : "SEGMENT:{id:0, start:0.0, end:3.5, text:"Bonjour"}"
          try {
            const segData = JSON.parse(line.replace('SEGMENT:', '').trim())
            const segment: TranscriptSegment = {
              id: String(segData.id),
              start: segData.start,
              end: segData.end,
              text: segData.text
            }
            segments.push(segment)
            // On notifie immédiatement le client pour l'affichage en temps réel
            onSegment(segment)
          } catch {} // On ignore les erreurs de parsing JSON
        } else if (line.startsWith('ERROR:')) {
          // Message d'erreur du script Python
          logger.error('[Whisper]', line.replace('ERROR:', '').trim())
        } else if (line.trim() && !line.includes('UserWarning')) {
          // Autres messages (infos, warnings Python sauf les UserWarning inoffensifs)
          logger.info('[Whisper]', line.trim())
        }
      }
    })

    // Quand le processus Python se termine
    whisperProcess.on('close', (code) => {
      whisperProcess = null
      logger.info('=== Fin Whisper === Code:', code)

      // Petite pause pour laisser le GPU libérer sa mémoire VRAM
      // (sinon la tâche suivante pourrait manquer de mémoire)
      const { execSync } = require('child_process')
      try { execSync('sleep 2') } catch {}


      if (code === 0) {
        // Succès : code de sortie 0

        // Si on a reçu des segments en streaming, on les utilise directement
        if (segments.length > 0) {
          resolve(segments)
          return
        }

        // Fallback : si le streaming n'a pas fonctionné, on lit le fichier de sortie JSON
        try {
          if (existsSync(outputPath)) {
            const data = JSON.parse(readFileSync(outputPath, 'utf-8'))
            const ts: TranscriptSegment[] = (data.segments || []).map((s: any, i: number) => ({
              id: String(s.id || i), start: s.start || 0, end: s.end || 0, text: (s.text || '').trim()
            }))
            // On envoie chaque segment au callback (même si pas en temps réel)
            ts.forEach(onSegment)
            resolve(ts)
          } else {
            reject(new Error('Fichier de sortie introuvable'))
          }
        } catch (err) { reject(err) }
      } else {
        // Échec : code de sortie non-0
        reject(new Error(`Transcription echouee (code ${code})`))
      }
    })

    // Gestion des erreurs de lancement du processus (ex: python3 non trouvé)
    whisperProcess.on('error', (err) => {
      whisperProcess = null
      reject(err)
    })
  })
}

/**
 * Transcription batch : transcrit plusieurs fichiers audio en une seule session.
 *
 * Avantage : le modèle Whisper est chargé UNE SEULE FOIS en mémoire GPU,
 * puis on transcrit tous les clips l'un après l'autre. Cela économise ~6 secondes
 * par clip (temps de chargement du modèle).
 *
 * Utilise un "manifest" (fichier JSON temporaire) pour passer la liste des
 * fichiers au script Python.
 *
 * @param clips - Tableau de fichiers à transcrire { id, audioPath }
 * @param language - Code langue (ex: "fr")
 * @param onProgress - Callback de progression globale
 * @returns Map associant chaque ID de clip à ses segments transcrits
 */
export function transcribeBatch(
  clips: { id: string; audioPath: string }[],
  language: string,
  onProgress: (percent: number) => void
): Promise<Map<string, TranscriptSegment[]>> {
  return new Promise((resolve, reject) => {
    // Recherche du script Python de transcription batch
    const scriptPath = join(process.cwd(), 'scripts', 'transcribe-batch.py')
    const altPath = join(__dirname, '..', '..', 'scripts', 'transcribe-batch.py')
    const finalScript = existsSync(scriptPath) ? scriptPath : existsSync(altPath) ? altPath : scriptPath

    // Si le script n'existe pas, on retourne une Map vide
    // (le code appelant fera un fallback vers la transcription séquentielle)
    if (!existsSync(finalScript)) {
      logger.warn('Script transcribe-batch.py introuvable, fallback sequentiel')
      resolve(new Map())
      return
    }

    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const ts = Date.now()
    // Fichier manifest : contient la liste des clips à transcrire
    const manifestPath = join(DATA_DIR, 'temp', `batch_manifest_${ts}.json`)
    // Fichier de sortie : contiendra les résultats de toutes les transcriptions
    const outputPath = join(DATA_DIR, 'temp', `batch_output_${ts}.json`)

    // Écriture du manifest JSON pour le script Python
    const manifest = clips.map(c => ({ id: c.id, path: c.audioPath }))
    const { writeFileSync, unlinkSync: ul } = require('fs')
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8')

    const model = currentModel || 'large-v3'
    logger.info(`=== Transcription batch : ${clips.length} clips, modele ${model} ===`)

    // Lancement du script Python batch
    const proc = spawn('python3', [
      finalScript, '--manifest', manifestPath, '--model', model,
      '--language', language, '--output', outputPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    // Buffer pour accumuler la sortie stdout (résultats JSON)
    let stdoutData = ''

    // Lecture de stderr pour la progression et les logs
    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[Whisper-Batch]', line.replace('ERROR:', '').trim())
        } else if (line.startsWith('SEGMENT:')) {
          // Log de progression par clip (on tronque à 80 caractères)
          logger.info('[Whisper-Batch]', line.replace('SEGMENT:', '').trim().substring(0, 80))
        } else if (line.trim() && !line.includes('UserWarning')) {
          logger.info('[Whisper-Batch]', line.trim())
        }
      }
    })

    // Accumulation de stdout (contient le JSON des résultats)
    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    // Quand le processus se termine
    proc.on('close', (code) => {
      // Nettoyage du fichier manifest temporaire
      try { ul(manifestPath) } catch {}
      // Pause pour libérer la mémoire GPU
      const { execSync: ex } = require('child_process')
      try { ex('sleep 2') } catch {}

      // Map pour stocker les résultats : clipId → segments[]
      const resultMap = new Map<string, TranscriptSegment[]>()

      if (code === 0) {
        try {
          let results: any[] = []
          // On essaie d'abord de lire les résultats depuis stdout
          try { results = JSON.parse(stdoutData.trim()) } catch {}
          // Sinon, on lit le fichier de sortie JSON
          if (results.length === 0 && existsSync(outputPath)) {
            results = JSON.parse(readFileSync(outputPath, 'utf-8'))
          }

          // On parcourt les résultats et on construit la Map clipId → segments
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

      // Nettoyage du fichier de sortie temporaire
      try { ul(outputPath) } catch {}
      logger.info(`=== Fin batch Whisper : ${resultMap.size}/${clips.length} clips ===`)
      resolve(resultMap)
    })

    // Erreur de lancement du processus (ex: python3 introuvable)
    proc.on('error', (err) => {
      logger.error('[Whisper-Batch] Erreur process:', err)
      // On retourne une Map vide plutôt que de rejeter, pour permettre un fallback
      resolve(new Map())
    })
  })
}

/**
 * Annule la transcription en cours en tuant le processus Python Whisper.
 * Appelée quand l'utilisateur clique sur "Annuler" dans l'interface,
 * ou quand une tâche est annulée via cancelTask() dans task-queue.ts.
 */
export function cancelTranscription(): void {
  if (whisperProcess) {
    logger.info('Annulation transcription...')
    // kill() envoie un signal SIGTERM au processus Python pour l'arrêter
    whisperProcess.kill()
    whisperProcess = null
  }
}

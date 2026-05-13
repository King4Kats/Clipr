/**
 * DIARIZATION.TS : Service de diarisation (identification des locuteurs)
 *
 * La diarisation, c'est le processus qui détermine "qui parle quand" dans un audio.
 * Par exemple, dans une interview, elle distingue l'intervieweur de l'interviewé.
 *
 * Ce fichier propose trois fonctionnalités principales :
 *
 * 1. diarize() : Prend un audio + les segments Whisper, et ajoute un label
 *    de locuteur (SPEAKER_0, SPEAKER_1, etc.) à chaque segment.
 *    Utilise le script Python diarize.py basé sur pyannote.audio.
 *
 * 2. vadDiarize() : Version "VAD + Diarisation" qui segmente l'audio par les
 *    silences réels (Voice Activity Detection) puis identifie les locuteurs.
 *    Retourne des tours de parole propres.
 *
 * 3. identifySpeakerNames() + applySpeakerNames() : Utilise Ollama (IA locale)
 *    pour deviner les vrais noms des locuteurs à partir du contenu de la transcription.
 *    Ex: SPEAKER_0 → "Philippe", SPEAKER_1 → "Intervieweur"
 *
 * Architecture : Node.js → spawn Python → pyannote.audio (GPU) → résultats JSON
 */

// spawn : lance un processus fils (ici : le script Python de diarisation)
import { spawn } from 'child_process'
// join : construit des chemins de fichiers | extname : extrait l'extension
import { join, extname } from 'path'
// Fonctions de gestion de fichiers (vérifier existence, lire, écrire, supprimer)
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
// Logger pour les messages de debug/info dans la console serveur
import { logger } from '../logger.js'

// Configuration de connexion à Ollama (serveur d'IA locale)
// OLLAMA_HOST : nom d'hôte du serveur Ollama (par défaut 'ollama' pour Docker)
// OLLAMA_PORT : port du serveur Ollama (par défaut 11434)
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama'
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434')

/**
 * Interface décrivant un segment de transcription.
 * Identique à celle de whisper.ts — chaque segment est une phrase avec timing.
 */
interface TranscriptSegment {
  id: string        // Identifiant du segment
  start: number     // Temps de début en secondes
  end: number       // Temps de fin en secondes
  text: string      // Texte transcrit
  speaker?: string  // Label du locuteur (ex: "SPEAKER_0", puis "Philippe" après identification)
}

/**
 * Trouve le chemin du script Python de diarisation.
 * Deux emplacements possibles : développement et production.
 */
function getDiarizeScriptPath(): string {
  const devPath = join(process.cwd(), 'scripts', 'diarize.py')
  if (existsSync(devPath)) return devPath
  const altPath = join(__dirname, '..', '..', 'scripts', 'diarize.py')
  if (existsSync(altPath)) return altPath
  return devPath
}

/**
 * Exécute la diarisation sur un fichier audio + les segments Whisper.
 *
 * Fonctionnement :
 * 1. On écrit les segments Whisper dans un fichier JSON temporaire
 * 2. On lance le script Python diarize.py qui utilise pyannote.audio
 * 3. Le script analyse l'audio et associe chaque segment à un locuteur
 * 4. On récupère les résultats (segments avec champ "speaker" ajouté)
 *
 * En cas d'échec, la fonction retourne les segments originaux (sans locuteur)
 * au lieu de rejeter la promesse — c'est une dégradation gracieuse.
 *
 * @param audioPath - Chemin vers le fichier audio
 * @param segments - Les segments de transcription Whisper
 * @param onProgress - Callback de progression (0-100)
 * @param numSpeakers - Nombre de locuteurs attendu (0 = détection automatique)
 * @returns Les segments enrichis avec les labels de locuteurs
 */
export function diarize(
  audioPath: string,
  segments: TranscriptSegment[],
  onProgress: (percent: number) => void,
  numSpeakers: number = 0  // 0 = auto-detect
): Promise<TranscriptSegment[]> {
  return new Promise((resolve, reject) => {
    const scriptPath = getDiarizeScriptPath()
    // Si le script n'existe pas, on retourne les segments tels quels (sans locuteur)
    if (!existsSync(scriptPath)) {
      logger.warn('Diarization script not found, skipping:', scriptPath)
      resolve(segments)
      return
    }

    // Préparation des fichiers temporaires pour communiquer avec le script Python
    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const ts = Date.now()
    const segmentsPath = join(DATA_DIR, 'temp', `diar_input_${ts}.json`)  // Entrée : segments Whisper
    const outputPath = join(DATA_DIR, 'temp', `diar_output_${ts}.json`)   // Sortie : segments diarisés

    // On écrit les segments Whisper dans un fichier temporaire pour que le script Python les lise
    writeFileSync(segmentsPath, JSON.stringify(segments), 'utf-8')

    logger.info('=== Demarrage diarisation ===')
    logger.info('Audio:', audioPath, '| Speakers:', numSpeakers)

    // Lancement du script Python avec les arguments nécessaires
    const proc = spawn('python3', [
      scriptPath, audioPath,
      '--segments', segmentsPath,  // Fichier des segments Whisper en entrée
      '--output', outputPath,      // Fichier de sortie
      '--num-speakers', String(numSpeakers)  // Nombre de locuteurs (0 = auto)
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    // Tableau pour accumuler les segments diarisés reçus via stdout
    const diarizedSegments: TranscriptSegment[] = []
    // On capture les dernieres lignes pertinentes de stderr pour pouvoir
    // remonter une raison d'echec lisible dans l'UI si le processus plante.
    const stderrTail: string[] = []
    const STDERR_TAIL_LIMIT = 8

    // Lecture de stderr : progression et messages de log du script Python
    proc.stderr?.on('data', (data) => {
      const text = data.toString()
      for (const line of text.split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[Diarize]', line.replace('ERROR:', '').trim())
          stderrTail.push(line.trim())
        } else if (line.trim() && !line.includes('UserWarning') && !line.includes('FutureWarning')) {
          logger.info('[Diarize]', line.trim())
          stderrTail.push(line.trim())
        }
        // Garde uniquement les N dernieres lignes pour limiter la taille du message d'erreur
        if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail.shift()
      }
    })

    // Lecture de stdout : le script Python peut envoyer directement les résultats JSON
    proc.stdout?.on('data', (data) => {
      try {
        const parsed = JSON.parse(data.toString().trim())
        if (Array.isArray(parsed)) diarizedSegments.push(...parsed)
      } catch {} // On ignore les erreurs de parsing (données partielles)
    })

    // Quand le processus Python se termine
    proc.on('close', (code) => {
      // Nettoyage du fichier d'entrée temporaire
      try { unlinkSync(segmentsPath) } catch {}

      // Pause pour libérer la mémoire GPU après l'exécution de pyannote
      const { execSync } = require('child_process')
      try { execSync('sleep 2') } catch {}

      // Helper : extrait une raison lisible des dernieres lignes de stderr Python
      const extractReason = (): string => {
        // Cherche une LibsndfileError typique (format audio non supporte)
        const sf = stderrTail.find(l => l.includes('LibsndfileError') || l.includes('Format not recognised'))
        if (sf) return 'Format audio non supporte par le module de diarisation (essayer .wav ou .flac)'
        // Sinon, derniere ligne non vide qui ressemble a une exception
        const exc = [...stderrTail].reverse().find(l => /Error|Exception|Traceback/i.test(l))
        if (exc) return exc.slice(0, 200)
        return stderrTail.slice(-2).join(' | ').slice(0, 200) || 'Echec du script Python'
      }

      if (code === 0) {
        // Succès : on utilise les segments reçus en streaming si disponibles
        if (diarizedSegments.length > 0) {
          resolve(diarizedSegments)
          return
        }
        // Fallback : lecture du fichier de sortie JSON
        try {
          if (existsSync(outputPath)) {
            const data = JSON.parse(readFileSync(outputPath, 'utf-8'))
            try { unlinkSync(outputPath) } catch {}
            resolve(data)
          } else {
            // Code 0 mais pas de sortie : on rejette pour que le pipeline notifie l'UI
            reject(new Error(`Diarisation : sortie vide (${extractReason()})`))
          }
        } catch (err: any) {
          reject(new Error(`Diarisation : lecture sortie impossible (${err.message})`))
        }
      } else {
        // Échec : on rejette avec une raison lisible — le pipeline catch et broadcast
        // l'erreur via 'transcription:diarization-complete' (champ error)
        const reason = extractReason()
        logger.error(`Diarization failed (code ${code}): ${reason}`)
        reject(new Error(`Diarisation echouee : ${reason}`))
      }
    })

    // Erreur de lancement du processus (ex: python3 introuvable)
    proc.on('error', (err) => {
      logger.error('Diarization process error:', err)
      reject(new Error(`Impossible de lancer la diarisation : ${err.message}`))
    })
  })
}

/**
 * VAD + Diarisation : segmente l'audio par les silences réels, puis identifie les locuteurs.
 *
 * VAD = Voice Activity Detection (détection d'activité vocale).
 * Contrairement à diarize() qui travaille sur des segments Whisper existants,
 * cette fonction segmente l'audio elle-même en se basant sur les silences.
 *
 * Retourne des "tours de parole" propres : [{ start, end, speaker }]
 * Utile pour des cas où on veut d'abord segmenter par locuteur avant de transcrire.
 *
 * @param audioPath - Chemin vers le fichier audio
 * @param onProgress - Callback de progression
 * @param numSpeakers - Nombre de locuteurs attendu (0 = auto)
 * @returns Tableau de tours de parole { start, end, speaker }
 */
export function vadDiarize(
  audioPath: string,
  onProgress: (percent: number) => void,
  numSpeakers: number = 0
): Promise<Array<{ start: number; end: number; speaker: string }>> {
  return new Promise((resolve) => {
    // Recherche du script Python vad-diarize.py (deux emplacements possibles)
    const scriptPath = join(process.cwd(), 'scripts', 'vad-diarize.py')
    const altPath = join(__dirname, '..', '..', 'scripts', 'vad-diarize.py')
    const finalScript = existsSync(scriptPath) ? scriptPath : existsSync(altPath) ? altPath : scriptPath

    if (!existsSync(finalScript)) {
      logger.warn('Script vad-diarize.py introuvable:', finalScript)
      resolve([]) // Retourne un tableau vide si le script n'existe pas
      return
    }

    const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
    const outputPath = join(DATA_DIR, 'temp', `vad_diar_${Date.now()}.json`)

    logger.info(`=== VAD+Diarisation : ${audioPath} | speakers=${numSpeakers} ===`)

    // Lancement du script Python vad-diarize.py
    const args = [finalScript, audioPath, '--output', outputPath, '--num-speakers', String(numSpeakers)]
    const proc = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    // Buffer pour accumuler la sortie stdout
    let stdoutData = ''

    // Écoute de stderr pour progression et logs
    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('PROGRESS:')) {
          const p = parseInt(line.replace('PROGRESS:', '').trim())
          if (!isNaN(p)) onProgress(p)
        } else if (line.startsWith('ERROR:')) {
          logger.error('[VAD-Diarize]', line.replace('ERROR:', '').trim())
        } else if (line.trim() && !line.includes('UserWarning') && !line.includes('FutureWarning')) {
          logger.info('[VAD-Diarize]', line.trim())
        }
      }
    })

    // Accumulation de stdout (résultats JSON)
    proc.stdout?.on('data', (data) => { stdoutData += data.toString() })

    // Quand le processus se termine
    proc.on('close', (code) => {
      // Pause pour libérer la mémoire GPU
      const { execSync } = require('child_process')
      try { execSync('sleep 2') } catch {}

      if (code === 0) {
        // Essai 1 : lire les résultats depuis stdout
        try {
          const results = JSON.parse(stdoutData.trim())
          if (Array.isArray(results)) { resolve(results); return }
        } catch {} // stdout vide ou JSON invalide

        // Essai 2 : lire les résultats depuis le fichier de sortie
        try {
          if (existsSync(outputPath)) {
            const data = JSON.parse(readFileSync(outputPath, 'utf-8'))
            try { unlinkSync(outputPath) } catch {}
            resolve(data)
            return
          }
        } catch {} // Fichier introuvable ou JSON invalide
      }

      // En cas d'échec, on retourne un tableau vide
      logger.error(`[VAD-Diarize] Code sortie ${code}`)
      resolve([])
    })

    // Erreur de lancement → tableau vide (dégradation gracieuse)
    proc.on('error', () => resolve([]))
  })
}

/**
 * Utilise Ollama (IA locale, type LLaMA) pour identifier les noms des locuteurs
 * à partir du contenu de la transcription.
 *
 * L'IA analyse les premières ~3 minutes de la transcription et cherche des indices :
 * - Présentations : "Je suis Philippe", "Je m'appelle Marie"
 * - Salutations : "Bonjour Pierre"
 * - Contexte : qui pose les questions (intervieweur) vs qui répond (intervenant)
 *
 * Si l'IA ne trouve pas de noms, un fallback est utilisé :
 * le locuteur qui parle le plus = "Intervenant", celui qui parle le moins = "Intervieweur"
 *
 * @param segments - Les segments de transcription avec labels SPEAKER_0, SPEAKER_1, etc.
 * @param ollamaModel - Le modèle Ollama à utiliser (ex: "qwen2.5:14b")
 * @returns Un dictionnaire de correspondance : { "SPEAKER_0": "Philippe", "SPEAKER_1": "Intervieweur" }
 */
export async function identifySpeakerNames(
  segments: TranscriptSegment[],
  ollamaModel: string = 'qwen2.5:14b'
): Promise<Record<string, string>> {
  const defaultMapping: Record<string, string> = {}

  // On collecte la liste des identifiants uniques de locuteurs (SPEAKER_0, SPEAKER_1, etc.)
  const speakerIds = [...new Set(segments.filter(s => s.speaker).map(s => s.speaker!))]
  if (speakerIds.length === 0) return defaultMapping

  // On ne prend que les 3 premières minutes de transcription
  // (suffisant pour trouver les présentations, et ça limite le coût IA)
  const firstSegments = segments.filter(s => s.start < 180)
  if (firstSegments.length === 0) return defaultMapping

  // Construction du texte de transcription pour l'IA
  const transcript = firstSegments
    .map(s => `${s.speaker || 'UNKNOWN'}: ${s.text}`)
    .join('\n')

  // Construction de la structure JSON attendue dans la réponse
  const speakerMapping = speakerIds.map(id => `"${id}": "Prenom ou role"`).join(', ')

  // Prompt envoyé à Ollama : on lui demande d'identifier les locuteurs
  const prompt = `Tu analyses le debut d'une interview ou conversation transcrite. Voici les premieres minutes avec les locuteurs identifies comme ${speakerIds.join(', ')}.

${transcript}

Il y a ${speakerIds.length} locuteurs. Identifie pour chacun:
1. Son prenom s'il est mentionne (presentations, "je suis...", "bonjour X", "je m'appelle...", etc.)
2. Son role si le prenom n'est pas trouve: "Intervieweur" (pose les questions), "Intervenant" (repond), "Intervenant 2", "Intervenant 3", etc.

Reponds UNIQUEMENT en JSON valide, sans texte autour:
{${speakerMapping}}

Si tu ne trouves pas le prenom d'un locuteur, utilise son role.`

  try {
    // Appel à Ollama pour obtenir la réponse de l'IA
    const response = await ollamaGenerate(ollamaModel, prompt)
    // Extraction du JSON de la réponse (l'IA peut ajouter du texte autour)
    const jsonMatch = response.match(/\{[^}]+\}/)
    if (jsonMatch) {
      const mapping = JSON.parse(jsonMatch[0])
      logger.info('[Diarize] Speaker names identified:', mapping)
      return mapping
    }
  } catch (err) {
    logger.warn('[Diarize] Ollama name detection failed, using defaults:', err)
  }

  // ── Fallback : attribution de rôles basée sur le temps de parole ──
  // Si Ollama échoue ou n'est pas disponible, on devine les rôles :
  // - Celui qui parle le plus longtemps = l'intervenant principal
  // - Celui qui parle le moins = l'intervieweur (pose des questions courtes)

  // Calcul de la durée totale de parole pour chaque locuteur
  const speakerDurations: Record<string, number> = {}
  for (const seg of segments) {
    if (seg.speaker) {
      speakerDurations[seg.speaker] = (speakerDurations[seg.speaker] || 0) + (seg.end - seg.start)
    }
  }

  // Tri par durée décroissante (celui qui parle le plus en premier)
  const sorted = Object.entries(speakerDurations).sort((a, b) => b[1] - a[1])
  const fallback: Record<string, string> = {}

  // Attribution des rôles :
  // - Le premier (parle le plus) = "Intervenant"
  // - Le dernier (parle le moins, s'il y en a plusieurs) = "Intervieweur"
  // - Les intermédiaires = "Intervenant 2", "Intervenant 3", etc.
  for (let i = 0; i < sorted.length; i++) {
    if (i === sorted.length - 1 && sorted.length > 1) {
      fallback[sorted[i][0]] = 'Intervieweur'
    } else if (i === 0) {
      fallback[sorted[i][0]] = 'Intervenant'
    } else {
      fallback[sorted[i][0]] = `Intervenant ${i + 1}`
    }
  }
  logger.info('[Diarize] Using fallback speaker names:', fallback)
  return fallback
}

/**
 * Applique le mapping de noms aux segments de transcription.
 * Remplace les labels génériques (SPEAKER_0, SPEAKER_1) par les vrais noms
 * trouvés par identifySpeakerNames().
 *
 * Attention : cette fonction MODIFIE les segments en place (mutation directe).
 *
 * @param segments - Les segments à modifier
 * @param mapping - Le dictionnaire de correspondance (ex: { "SPEAKER_0": "Philippe" })
 */
export function applySpeakerNames(segments: TranscriptSegment[], mapping: Record<string, string>): void {
  for (const seg of segments) {
    // Si le segment a un locuteur ET qu'on a un nom pour ce locuteur, on le remplace
    if (seg.speaker && mapping[seg.speaker]) {
      seg.speaker = mapping[seg.speaker]
    }
  }
}

/**
 * Fonction utilitaire interne : envoie une requête de génération de texte à Ollama.
 *
 * Ollama est un serveur d'IA locale qui fait tourner des modèles comme LLaMA.
 * On lui envoie un prompt et il retourne le texte généré.
 *
 * La communication se fait via HTTP (API REST) sur le port 11434.
 * Le timeout est fixé à 2 minutes (les modèles peuvent être lents).
 *
 * @param model - Le modèle à utiliser (ex: "qwen2.5:14b")
 * @param prompt - Le texte à envoyer au modèle
 * @returns Le texte généré par le modèle
 */
function ollamaGenerate(model: string, prompt: string): Promise<string> {
  const http = require('http')
  return new Promise((resolve, reject) => {
    // Construction du corps de la requête HTTP (format JSON)
    // stream: false signifie qu'on veut la réponse complète d'un coup (pas en streaming)
    const body = JSON.stringify({ model, prompt, stream: false })

    // Envoi de la requête POST à l'API Ollama
    const req = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000 // Timeout de 2 minutes
    }, (res: any) => {
      // Accumulation de la réponse
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try {
          // La réponse Ollama contient un champ "response" avec le texte généré
          const parsed = JSON.parse(data)
          resolve(parsed.response || '')
        } catch { reject(new Error('Invalid Ollama response')) }
      })
    })
    // Gestion des erreurs réseau et timeout
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')) })
    // Envoi du corps de la requête
    req.write(body)
    req.end()
  })
}

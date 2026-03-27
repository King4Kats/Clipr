/**
 * OLLAMA.TS : Service d'analyse semantique via LLM local (Ollama)
 *
 * Ce service orchestre l'analyse intelligente des transcriptions video en utilisant
 * l'API locale d'Ollama. Il gere le cycle complet : verification du serveur,
 * decouverte et telechargement des modeles, decoupage de la transcription en
 * morceaux, analyse par le LLM avec prompts specialises, et post-traitement
 * pour garantir des segments sequentiels sans trous ni chevauchements.
 *
 * Architecture du pipeline d'analyse :
 * 1. Verification/demarrage du serveur Ollama
 * 2. Generation d'un resume global de la video
 * 3. Decoupage de la transcription en chunks gereables
 * 4. Analyse thematique de chaque chunk par le LLM
 * 5. Post-traitement : deduplication, sequentialisation, fusion
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import https from 'node:https'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Configuration et constantes
// ---------------------------------------------------------------------------

/** Adresse du serveur Ollama (toujours en local) */
const OLLAMA_HOST = '127.0.0.1'

/** Port par defaut du serveur Ollama */
const OLLAMA_PORT = 11434

// On monte la taille max pour reduire le nombre de chunks (moins de doublons)
/** Nombre maximum de caracteres par morceau de transcription */
const MAX_CHARS_PER_CHUNK = 30000

/** Nombre de caracteres de chevauchement entre deux morceaux consecutifs */
const CHUNK_OVERLAP_CHARS = 800

// ---------------------------------------------------------------------------
// Types et interfaces
// ---------------------------------------------------------------------------

/** Resultat d'un segment thematique identifie par le LLM */
interface SegmentResult {
  title: string
  start: number
  end: number
  description?: string
}

/** Resultat complet de l'analyse contenant tous les segments */
interface AnalysisResult {
  segments: SegmentResult[]
}

// =========================================================================
// --- Communication HTTP avec le serveur Ollama ---
// =========================================================================

/**
 * Effectue une requete HTTP vers l'API locale d'Ollama.
 * Gere la serialisation JSON, les en-tetes et le timeout (10 min).
 *
 * @param method - Methode HTTP ('GET', 'POST')
 * @param path - Chemin de l'endpoint (ex: '/api/chat', '/api/tags')
 * @param body - Corps de la requete (sera serialise en JSON)
 * @returns Reponse brute sous forme de chaine
 * @throws Erreur HTTP ou timeout
 */
function ollamaRequest(method: string, path: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : undefined
    const options: http.RequestOptions = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      },
      timeout: 600000 // 10 minutes
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data)
        } else {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`))
        }
      })
    })

    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error('Délai d\'attente de la requête Ollama dépassé')) })

    if (postData) req.write(postData)
    req.end()
  })
}

// =========================================================================
// --- Verification et demarrage du serveur Ollama ---
// =========================================================================

/**
 * Verifie si le serveur Ollama est accessible en interrogeant l'API /api/tags.
 * @returns true si Ollama repond correctement
 */
export async function checkOllama(): Promise<boolean> {
  try {
    const data = await ollamaRequest('GET', '/api/tags')
    return !!data
  } catch {
    return false
  }
}

/** Promesse partagee pour eviter les demarrages multiples simultanes */
let ollamaStartingPromise: Promise<boolean> | null = null

/**
 * S'assure que le serveur Ollama est en cours d'execution.
 * Si Ollama n'est pas lance, tente de le demarrer automatiquement
 * en cherchant l'executable dans les emplacements Windows courants.
 * Attend jusqu'a 10 secondes que le serveur soit pret.
 *
 * @returns true si Ollama est pret, false sinon
 */
export async function ensureOllamaRunning(): Promise<boolean> {
  const isRunning = await checkOllama()
  if (isRunning) return true

  // Eviter les demarrages multiples en parallele
  if (ollamaStartingPromise) {
    return ollamaStartingPromise
  }

  ollamaStartingPromise = (async () => {
    logger.info('Ollama n\'est pas lancé. Tentative de démarrage...')

    // Recherche de l'executable Ollama dans les emplacements typiques Windows
    const possiblePaths = [
      join(process.env.LOCALAPPDATA || '', 'Ollama', 'ollama.exe'),
      join(process.env['ProgramFiles'] || '', 'Ollama', 'ollama.exe'),
      'ollama.exe' // Fallback : presente dans le PATH systeme
    ]

    let ollamaPath = ''
    for (const path of possiblePaths) {
      if (path === 'ollama.exe' || existsSync(path)) {
        ollamaPath = path
        break
      }
    }

    if (!ollamaPath) {
      logger.error('Exécutable Ollama non trouvé.')
      return false
    }

    try {
      // Lancement du serveur Ollama en processus detache
      const child = spawn(ollamaPath, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()

      // Attente active : verifier toutes les 500ms pendant 10 secondes
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500))
        if (await checkOllama()) {
          logger.info('Ollama a démarré avec succès.')
          return true
        }
      }
      return false
    } catch (err) {
      logger.error('Erreur lors du lancement d\'Ollama :', err)
      return false
    } finally {
      ollamaStartingPromise = null
    }
  })()

  return ollamaStartingPromise
}

// =========================================================================
// --- Installation automatique d'Ollama ---
// =========================================================================

/**
 * Telecharge et lance l'installeur d'Ollama depuis le site officiel.
 * Le telechargement se fait via HTTPS avec suivi de progression.
 * L'installeur est lance automatiquement une fois telecharge.
 *
 * @param onProgress - Callback optionnel de progression (pourcentage et message)
 * @returns true si le telechargement et le lancement ont reussi
 */
export async function downloadAndInstallOllama(onProgress?: (progress: number, message: string) => void): Promise<boolean> {
  const setupUrl = 'https://ollama.com/download/OllamaSetup.exe'
  const tempPath = join(app.getPath('temp'), 'OllamaSetup.exe')

  if (onProgress) onProgress(0, 'Téléchargement de l\'installeur Ollama...')

  return new Promise((resolve) => {
    const file = createWriteStream(tempPath)
    https.get(setupUrl, (res) => {
      const totalSize = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0

      // Suivi de la progression du telechargement
      res.on('data', (chunk) => {
        downloaded += chunk.length
        if (onProgress && totalSize > 0) {
          const percent = Math.round((downloaded / totalSize) * 100)
          onProgress(percent, `Téléchargement : ${percent}%`)
        }
      })

      res.pipe(file)

      // Fin du telechargement : lancement de l'installeur
      file.on('finish', () => {
        file.close()
        if (onProgress) onProgress(100, 'Lancement de l\'installation...')
        const installerProc = spawn(tempPath, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        installerProc.unref()
        resolve(true)
      })
    }).on('error', (err) => {
      logger.error('Erreur téléchargement Ollama :', err)
      resolve(false)
    })
  })
}

// =========================================================================
// --- Gestion des modeles Ollama ---
// =========================================================================

/**
 * Liste les modeles actuellement installes dans Ollama.
 * @returns Tableau des noms de modeles disponibles (ex: ['qwen2.5:3b', 'llama3.2:3b'])
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const data = await ollamaRequest('GET', '/api/tags')
    const parsed = JSON.parse(data)
    return (parsed.models || []).map((m: { name: string }) => m.name)
  } catch {
    return []
  }
}

/**
 * Telecharge (pull) un modele depuis le registre Ollama.
 * Attention : cette operation peut prendre plusieurs minutes selon la taille du modele.
 *
 * @param modelName - Nom du modele a telecharger (ex: 'qwen2.5:3b')
 * @returns true si le telechargement a reussi
 */
export async function pullOllamaModel(modelName: string): Promise<boolean> {
  try {
    logger.info(`Pulling Ollama model: ${modelName}...`)
    const postData = JSON.stringify({ name: modelName, stream: false })

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/pull',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 600000 // 10 minutes
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          logger.info('Téléchargement terminé :', data.substring(0, 200))
          resolve(res.statusCode === 200)
        })
      })
      req.on('error', (err) => { logger.error('Erreur de téléchargement (pull) :', err); reject(err) })
      req.on('timeout', () => { req.destroy(); reject(new Error('Délai de téléchargement dépassé')) })
      req.write(postData)
      req.end()
    })
  } catch (err) {
    logger.error('Failed to pull model:', err)
    return false
  }
}

// =========================================================================
// --- Decoupage de la transcription en morceaux ---
// =========================================================================

/**
 * Decoupe une transcription longue en morceaux gereables pour le LLM.
 * Chaque morceau respecte la limite MAX_CHARS_PER_CHUNK et inclut un
 * chevauchement (CHUNK_OVERLAP_CHARS) avec le morceau precedent pour
 * assurer la continuite du contexte aux frontieres.
 *
 * @param transcript - Transcription complete a decouper
 * @returns Tableau de morceaux de transcription
 */
function splitTranscriptIntoChunks(transcript: string): string[] {
  // Si la transcription tient en un seul morceau, pas besoin de decouper
  if (transcript.length <= MAX_CHARS_PER_CHUNK) {
    return [transcript]
  }

  const lines = transcript.split('\n')
  const chunks: string[] = []
  let currentChunk = ''
  let overlapBuffer = ''

  for (const line of lines) {
    const addition = (currentChunk ? '\n' : '') + line

    // Si l'ajout depasse la limite, sauvegarder le morceau actuel
    if (currentChunk.length + addition.length > MAX_CHARS_PER_CHUNK) {
      if (currentChunk) {
        chunks.push(currentChunk)
        // Conserver la fin du morceau comme chevauchement pour le suivant
        overlapBuffer = currentChunk.slice(-CHUNK_OVERLAP_CHARS)
        currentChunk = overlapBuffer + '\n' + line
      } else {
        // Ligne unique trop longue : tronquer
        chunks.push(line.substring(0, MAX_CHARS_PER_CHUNK))
        currentChunk = ''
      }
    } else {
      currentChunk += addition
    }
  }

  // Ajouter le dernier morceau s'il contient du texte
  if (currentChunk.trim()) {
    chunks.push(currentChunk)
  }

  return chunks
}

// =========================================================================
// --- Extraction des timestamps ---
// =========================================================================

/**
 * Extrait le premier et le dernier timestamp [XXX.Xs] d'un texte.
 * Les timestamps sont au format [123.4s] dans la transcription.
 *
 * @param text - Texte contenant des marqueurs temporels
 * @returns Objet avec le premier et dernier timestamp, ou null si aucun trouve
 */
function extractTimeRange(text: string): { first: number; last: number } | null {
  const matches = text.match(/\[(\d+(?:\.\d+)?)s\]/g)
  if (!matches || matches.length === 0) return null
  const times = matches.map(m => parseFloat(m.replace(/[\[\]s]/g, '')))
  return { first: Math.min(...times), last: Math.max(...times) }
}

// =========================================================================
// --- Generation du resume global ---
// =========================================================================

/**
 * Genere un resume global de la video a partir de sa transcription.
 * Ce resume sert de contexte pour l'analyse thematique des morceaux.
 * Pour les longues transcriptions, un echantillon representatif est utilise
 * (debut, milieu, fin) pour rester dans les limites du contexte LLM.
 *
 * @param transcript - Transcription complete (ou echantillon)
 * @param context - Contexte supplementaire fourni par l'utilisateur
 * @param model - Nom du modele Ollama a utiliser
 * @returns Resume textuel du contenu de la video
 */
export async function generateGlobalSummary(
  transcript: string,
  context: string,
  model: string
): Promise<string> {
  // Prompt systeme : expert en analyse de contenu video
  const systemPrompt = `Tu es un expert en analyse de contenu vidéo et interview.
Ton but est de comprendre le sujet global d'une vidéo à partir de sa transcription horodatée.
Identifie le thème principal, les intervenants si possible, les points clés abordés et le ton général.
Sois concis mais exhaustif sur les thématiques.
Note : la transcription contient des marqueurs temporels [XXX.Xs].`

  // Limite de caracteres pour l'echantillon envoye au LLM
  const MAX_SUMMARY_CHARS = 25000
  let transcriptSample: string

  if (transcript.length <= MAX_SUMMARY_CHARS) {
    // Transcription courte : envoi integral
    transcriptSample = transcript
  } else {
    // Transcription longue : echantillonnage debut/milieu/fin
    const partSize = Math.floor(MAX_SUMMARY_CHARS / 3)
    const start = transcript.slice(0, partSize)
    const midStart = Math.floor(transcript.length / 2) - Math.floor(partSize / 2)
    const middle = transcript.slice(midStart, midStart + partSize)
    const end = transcript.slice(-partSize)
    transcriptSample = `${start}\n\n[... milieu ...]\n\n${middle}\n\n[... fin ...]\n\n${end}`
  }

  const userPrompt = `${context ? `CONTEXTE: ${context}\n\n` : ''}TRANSCRIPTION (${transcript.length > MAX_SUMMARY_CHARS ? 'échantillonnée — ' + Math.round(transcript.length / 1000) + 'K chars' : 'complète'}):
"""
${transcriptSample}
"""

Analyse cette transcription et fournis un résumé structuré du sujet.`

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    options: { temperature: 0.3, num_ctx: 32768 }
  }

  try {
    const data = await ollamaRequest('POST', '/api/chat', body)
    const response = JSON.parse(data)
    return response.message?.content || 'Aucun résumé généré.'
  } catch (err) {
    logger.error('Erreur résumé global :', err)
    return 'Erreur lors de la génération du résumé.'
  }
}

// =========================================================================
// --- Extraction JSON depuis la reponse du LLM ---
// =========================================================================

/**
 * Tente d'extraire un objet JSON valide depuis la reponse brute du LLM.
 * Essaie d'abord un parsing direct, puis cherche un bloc JSON dans le texte.
 *
 * @param raw - Reponse brute du LLM
 * @returns Objet JSON parse ou null si l'extraction echoue
 */
function extractJsonFromResponse(raw: string): any {
  // Tentative de parsing direct
  try {
    return JSON.parse(raw)
  } catch {
    // Recherche d'un bloc JSON dans la reponse (entre accolades)
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch { /* le JSON est invalide, on retourne null */ }
    }
    return null
  }
}

// =========================================================================
// --- Analyse thematique d'un morceau ---
// =========================================================================

/**
 * Analyse un morceau (chunk) de transcription via Ollama pour identifier
 * les segments thematiques. Utilise un prompt detaille avec des regles
 * strictes pour obtenir des segments sequentiels et bien delimites.
 *
 * La continuite entre morceaux est assuree par le parametre previousEndInfo
 * qui indique ou le morceau precedent s'est arrete.
 *
 * Inclut un mecanisme de retry (3 tentatives max) en cas d'echec.
 *
 * @param chunk - Morceau de transcription a analyser
 * @param context - Contexte utilisateur
 * @param globalSummary - Resume global de la video (pour le contexte thematique)
 * @param model - Nom du modele Ollama
 * @param chunkIndex - Index du morceau actuel (base 0)
 * @param totalChunks - Nombre total de morceaux
 * @param previousEndInfo - Info du dernier segment du morceau precedent (pour la continuite)
 * @returns Tableau de segments identifies dans ce morceau
 */
async function analyzeChunk(
  chunk: string,
  context: string,
  globalSummary: string,
  model: string,
  chunkIndex: number,
  totalChunks: number,
  previousEndInfo?: { title: string; endTime: number }
): Promise<SegmentResult[]> {

  // Extraction de la plage temporelle couverte par ce morceau
  const timeRange = extractTimeRange(chunk)

  // Prompt systeme : regles strictes pour le decoupage thematique
  const systemPrompt = `Tu es un expert en montage vidéo d'interviews.
Tu dois découper une transcription horodatée en segments thématiques SÉQUENTIELS.

RÈGLES ABSOLUES — aucune exception :
1. Les segments sont SÉQUENTIELS : le "start" du segment N+1 = le "end" du segment N. ZÉRO chevauchement.
2. COUVERTURE TOTALE : le premier segment commence au tout premier timestamp, le dernier se termine au dernier timestamp.
3. Durée typique : entre 2 et 8 minutes par segment pour une interview. Ni 14 secondes, ni 13 minutes.
4. TITRES PRÉCIS : chaque titre résume le sujet RÉEL discuté dans ce passage (pas le sujet de la vidéo en général).
5. Les timestamps [XXX.Xs] dans le texte donnent le temps en secondes. Utilise-les pour les valeurs start/end.
6. Réponds UNIQUEMENT avec du JSON valide.
7. Vise entre 5 et 15 segments pour un extrait de 20-60 minutes.

EXEMPLE pour un extrait de 0s à 600s:
{"segments":[
  {"title":"Présentation et contexte","start":0,"end":120,"description":"Introduction du sujet"},
  {"title":"Enfance et scolarité","start":120,"end":300,"description":"L'invité parle de sa jeunesse"},
  {"title":"Parcours professionnel","start":300,"end":600,"description":"Évolution de carrière"}
]}`

  // Construction du prompt utilisateur avec indicateurs de contexte
  const chunkLabel = totalChunks > 1 ? `(partie ${chunkIndex + 1}/${totalChunks}) ` : ''

  // Indication de continuite avec le morceau precedent
  const continuityHint = previousEndInfo
    ? `\nATTENTION CONTINUITÉ : Le chunk précédent s'est terminé avec le segment "${previousEndInfo.title}" à ${previousEndInfo.endTime.toFixed(1)}s. Ton premier segment DOIT commencer à ${previousEndInfo.endTime.toFixed(1)}s.\n`
    : ''

  // Indication de la plage temporelle couverte
  const rangeHint = timeRange
    ? `\nCet extrait couvre de ${timeRange.first.toFixed(1)}s à ~${timeRange.last.toFixed(1)}s.`
    : ''

  const userPrompt = `SUJET DE LA VIDÉO :
"${globalSummary.substring(0, 500)}"
${continuityHint}${rangeHint}
${context ? `CONSIGNES: ${context}\n` : ''}
TRANSCRIPTION ${chunkLabel}:
"""
${chunk}
"""

Découpe en segments thématiques SÉQUENTIELS couvrant tout l'extrait. JSON uniquement :
{"segments":[{"title":"...","start":X,"end":Y,"description":"..."},...]}`

  // Corps de la requete Ollama avec format JSON force
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    format: 'json',
    stream: false,
    options: { temperature: 0.1, num_ctx: 32768 }
  }

  // Mecanisme de retry : jusqu'a 3 tentatives en cas d'echec
  const MAX_RETRIES = 3
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await ollamaRequest('POST', '/api/chat', body)
      const response = JSON.parse(data)
      const content = response.message?.content || '{}'

      // Extraction et validation du JSON de la reponse
      const parsed = extractJsonFromResponse(content)
      if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
        logger.warn(`[Ollama] Tentative ${attempt}/${MAX_RETRIES} : pas de segments valides`)
        if (attempt < MAX_RETRIES) continue
        return []
      }

      return parsed.segments
    } catch (err) {
      logger.error(`[Ollama] Tentative ${attempt}/${MAX_RETRIES} échouée :`, err)
      if (attempt >= MAX_RETRIES) return []
      // Attente avant la prochaine tentative
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return []
}

// =========================================================================
// --- Post-traitement : nettoyage et sequentialisation ---
// =========================================================================

/**
 * Post-traitement robuste des segments bruts retournes par le LLM.
 * Garantit des segments sequentiels, sans chevauchement et sans trous.
 *
 * Etapes du traitement :
 * 1. Tri par timestamp de debut
 * 2. Deduplication des segments avec chevauchement > 70%
 * 3. Sequentialisation : le start du N+1 = le end du N
 * 4. Comblement des trous entre segments
 * 5. Ajustement des bornes globales (debut et fin de la video)
 * 6. Fusion des segments trop courts (< 30s)
 * 7. Arrondissement des timestamps a 0.1s
 *
 * @param rawSegments - Segments bruts issus de l'analyse LLM
 * @param totalDuration - Duree totale de la video en secondes
 * @returns Segments nettoyes et sequentiels
 */
export function cleanAndForceSequential(rawSegments: SegmentResult[], totalDuration: number): SegmentResult[] {
  if (rawSegments.length === 0) return []

  // Etape 1 : Tri par timestamp de debut et filtrage des segments invalides
  const sorted = [...rawSegments]
    .filter(s => s.title && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
    .sort((a, b) => a.start - b.start)

  if (sorted.length === 0) return []

  // Etape 2 : Deduplication — si deux segments couvrent presque le meme intervalle,
  // garder celui avec le meilleur titre (le plus descriptif)
  const deduped: SegmentResult[] = []
  for (const seg of sorted) {
    const existing = deduped.find(d => {
      const overlapStart = Math.max(d.start, seg.start)
      const overlapEnd = Math.min(d.end, seg.end)
      const overlapDuration = Math.max(0, overlapEnd - overlapStart)
      const segDuration = seg.end - seg.start
      const dDuration = d.end - d.start
      // Si > 70% de chevauchement par rapport au plus petit, c'est un doublon
      return overlapDuration > 0.7 * Math.min(segDuration, dDuration)
    })

    if (!existing) {
      deduped.push({ ...seg })
    } else {
      // Garder le segment avec le titre le plus long (souvent plus descriptif)
      if (seg.title.length > existing.title.length) {
        existing.title = seg.title
        existing.description = seg.description || existing.description
      }
      // Etendre les bornes si besoin
      existing.start = Math.min(existing.start, seg.start)
      existing.end = Math.max(existing.end, seg.end)
    }
  }

  if (deduped.length === 0) return []

  // Etape 3 : Sequentialisation — le start du N+1 = end du N
  const sequential: SegmentResult[] = [deduped[0]]
  for (let i = 1; i < deduped.length; i++) {
    const prev = sequential[sequential.length - 1]
    const curr = deduped[i]

    // Si chevauchement, on fait commencer le segment a la fin du precedent
    if (curr.start < prev.end) {
      curr.start = prev.end
    }

    // Verifier que le segment a encore une duree positive (minimum 5 secondes)
    if (curr.end > curr.start + 5) {
      sequential.push(curr)
    } else {
      // Segment trop court apres ajustement : absorber dans le precedent
      prev.end = Math.max(prev.end, curr.end)
    }
  }

  // Etape 4 : Comblement des trous — etendre le segment precedent pour combler
  for (let i = 0; i < sequential.length - 1; i++) {
    const gap = sequential[i + 1].start - sequential[i].end
    if (gap > 0) {
      sequential[i].end = sequential[i + 1].start
    }
  }

  // Etape 5 : Ajustement des bornes globales
  if (totalDuration > 0) {
    const firstStart = Math.min(sequential[0].start, sorted[0].start)
    sequential[0].start = Math.max(0, firstStart)
    sequential[sequential.length - 1].end = Math.max(sequential[sequential.length - 1].end, totalDuration)
  }

  // Etape 6 : Fusion des segments trop courts (< 30 secondes) avec le precedent
  const MIN_DURATION = 30
  const merged: SegmentResult[] = []
  for (const seg of sequential) {
    const duration = seg.end - seg.start
    if (duration < MIN_DURATION && merged.length > 0) {
      // Absorber dans le segment precedent
      merged[merged.length - 1].end = seg.end
    } else {
      merged.push(seg)
    }
  }

  // Etape 7 : Arrondissement des timestamps a 0.1s et troncature des titres
  return merged.map(s => ({
    title: s.title.substring(0, 80),
    start: Math.round(s.start * 10) / 10,
    end: Math.round(s.end * 10) / 10,
    description: s.description || ''
  }))
}

/**
 * @deprecated Conserve pour la compatibilite ascendante.
 * Utiliser cleanAndForceSequential a la place.
 */
export function mergeAndDeduplicateSegments(allSegments: SegmentResult[]): SegmentResult[] {
  return cleanAndForceSequential(allSegments, 0)
}

// =========================================================================
// --- Orchestration de l'analyse complete ---
// =========================================================================

/**
 * Analyse une transcription complete avec Ollama en trois etapes :
 *
 * 1. **Resume global** : comprendre le sujet general de la video
 * 2. **Analyse par morceaux** : identifier les segments thematiques dans chaque chunk
 * 3. **Post-traitement** : nettoyer, dedupliquer et sequentialiser les segments
 *
 * Gere automatiquement le demarrage d'Ollama si necessaire.
 *
 * @param transcript - Transcription horodatee complete
 * @param context - Contexte ou consignes supplementaires de l'utilisateur
 * @param model - Nom du modele Ollama a utiliser (ex: 'qwen2.5:3b')
 * @param onChunkProgress - Callback optionnel de progression par morceau
 * @returns Resultat de l'analyse contenant les segments thematiques finaux
 * @throws Erreur si Ollama n'est pas disponible
 */
export async function analyzeTranscript(
  transcript: string,
  context: string,
  model: string,
  onChunkProgress?: (chunkIndex: number, totalChunks: number, segmentsSoFar: number, message?: string) => void
): Promise<AnalysisResult> {
  // Verification prealable : Ollama doit etre en cours d'execution
  const ollamaOk = await ensureOllamaRunning()
  if (!ollamaOk) {
    throw new Error('Impossible de démarrer Ollama. Vérifiez qu\'Ollama est installé.')
  }

  // Calcul de la duree totale depuis les timestamps de la transcription
  const globalTimeRange = extractTimeRange(transcript)
  const totalDuration = globalTimeRange ? globalTimeRange.last + 10 : 0

  // ETAPE 1 : Analyse globale — comprendre le sujet de la video
  if (onChunkProgress) onChunkProgress(0, 1, 0, 'Analyse globale du sujet...')
  const globalSummary = await generateGlobalSummary(transcript, context, model)
  logger.info('[Ollama] Résumé global :', globalSummary.substring(0, 200))

  // ETAPE 2 : Decoupage et analyse par morceaux
  const chunks = splitTranscriptIntoChunks(transcript)
  const allRawSegments: SegmentResult[] = []
  let previousEndInfo: { title: string; endTime: number } | undefined

  logger.info(`[Ollama] ${chunks.length} morceaux à analyser`)

  for (let i = 0; i < chunks.length; i++) {
    if (onChunkProgress) {
      onChunkProgress(i, chunks.length, allRawSegments.length, `Analyse thématique ${i + 1}/${chunks.length}...`)
    }

    // Analyse du morceau courant avec contexte du morceau precedent
    const chunkSegments = await analyzeChunk(
      chunks[i], context, globalSummary, model,
      i, chunks.length, previousEndInfo
    )

    if (chunkSegments.length > 0) {
      allRawSegments.push(...chunkSegments)
      // Passer le dernier segment comme contexte pour le morceau suivant
      const lastSeg = chunkSegments[chunkSegments.length - 1]
      previousEndInfo = {
        title: lastSeg.title,
        endTime: typeof lastSeg.end === 'number' ? lastSeg.end : 0
      }
    } else {
      logger.warn(`[Ollama] Morceau ${i + 1}/${chunks.length} : aucun segment`)
    }
  }

  logger.info(`[Ollama] ${allRawSegments.length} segments bruts, nettoyage...`)

  // ETAPE 3 : Post-traitement — nettoyage et sequentialisation des segments
  const cleanSegments = cleanAndForceSequential(allRawSegments, totalDuration)

  logger.info(`[Ollama] ${cleanSegments.length} segments finaux après nettoyage`)

  return { segments: cleanSegments }
}

// =========================================================================
// --- Generation de titre pour un segment individuel ---
// =========================================================================

/**
 * Genere un titre court pour un segment individuel a partir de son extrait
 * de transcription. Utile pour renommer un segment manuellement ou
 * pour completer des segments sans titre.
 *
 * @param transcriptExcerpt - Extrait de transcription du segment (500 chars max utilises)
 * @param model - Nom du modele Ollama a utiliser
 * @returns Titre genere (max 50 caracteres) ou 'Segment sans titre' en cas d'erreur
 */
export async function generateSegmentTitle(
  transcriptExcerpt: string,
  model: string
): Promise<string> {
  try {
    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: `Génère un titre court (max 50 caractères) pour ce segment de transcription:\n"${transcriptExcerpt.slice(0, 500)}"\n\nRéponds uniquement avec le titre.`
        }
      ],
      stream: false,
      options: { temperature: 0.5 }
    }

    const data = await ollamaRequest('POST', '/api/chat', body)
    const response = JSON.parse(data)
    return (response.message?.content || 'Segment sans titre').trim()
  } catch {
    return 'Segment sans titre'
  }
}

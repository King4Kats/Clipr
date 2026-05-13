/**
 * OLLAMA.TS : Service de communication avec Ollama (LLM local)
 *
 * Ce fichier gère toute l'interaction avec Ollama, un serveur qui fait tourner
 * des modèles de langage (IA) en local. Il est utilisé pour :
 *   - Vérifier que Ollama est disponible
 *   - Lister et télécharger des modèles
 *   - Analyser une transcription vidéo pour la découper en segments thématiques
 *
 * Le processus d'analyse est en plusieurs étapes :
 *   1. Générer un résumé global de la transcription
 *   2. Découper la transcription en morceaux (chunks) si elle est trop longue
 *   3. Analyser chaque morceau pour identifier les thèmes/chapitres
 *   4. Nettoyer et fusionner les résultats pour obtenir des segments séquentiels propres
 */

// Module HTTP natif de Node.js pour faire des requêtes vers le serveur Ollama
import http from 'node:http'

// Logger : utilitaire pour écrire des messages dans les logs du serveur
import { logger } from '../logger.js'

// --- Configuration de connexion à Ollama ---
// Hôte du serveur Ollama (par défaut 'ollama', typiquement le nom du conteneur Docker)
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama'
// Port du serveur Ollama (par défaut 11434, le port standard d'Ollama)
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434')

// --- Paramètres de découpage de la transcription ---
// Nombre maximum de caractères par morceau envoyé au LLM
// (les LLM ont une taille de contexte limitée, on ne peut pas tout envoyer d'un coup)
const MAX_CHARS_PER_CHUNK = 30000
// Nombre de caractères de chevauchement entre deux morceaux consécutifs
// (pour que le LLM ait du contexte et ne perde pas le fil entre deux morceaux)
const CHUNK_OVERLAP_CHARS = 800

/**
 * Interface représentant un segment thématique identifié par l'IA.
 * - title : titre du segment (ex: "Introduction et présentation")
 * - start : timestamp de début en secondes
 * - end : timestamp de fin en secondes
 * - description : description optionnelle du contenu du segment
 */
interface SegmentResult { title: string; start: number; end: number; description?: string }

/**
 * Interface représentant le résultat complet d'une analyse.
 * Contient simplement un tableau de segments thématiques.
 */
interface AnalysisResult { segments: SegmentResult[] }

/**
 * Fonction utilitaire bas niveau pour envoyer une requête HTTP à Ollama.
 * C'est l'équivalent d'un "fetch" mais avec le module HTTP natif de Node.js.
 *
 * @param method - Méthode HTTP (GET, POST, etc.)
 * @param path - Chemin de l'API (ex: '/api/tags', '/api/chat')
 * @param body - Corps de la requête (optionnel, sera converti en JSON)
 * @returns La réponse brute du serveur sous forme de chaîne de caractères
 */
function ollamaRequest(method: string, path: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    // Si on a un corps de requête, on le sérialise en JSON
    const postData = body ? JSON.stringify(body) : undefined

    // Configuration de la requête HTTP
    const options: http.RequestOptions = {
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path, method,
      headers: { 'Content-Type': 'application/json', ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}) },
      timeout: 1200000 // Timeout de 20 minutes (les LLM peuvent être lents)
    }

    // Envoi de la requête
    const req = http.request(options, (res) => {
      let data = ''
      // On accumule les morceaux de réponse au fur et à mesure
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        // Si le code HTTP est 2xx (succès), on retourne la réponse
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(data)
        // Sinon, on rejette avec une erreur contenant le code et la réponse
        else reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`))
      })
    })

    // Gestion des erreurs réseau (serveur injoignable, etc.)
    req.on('error', (err) => reject(err))
    // Gestion du timeout : on détruit la requête et on rejette
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout Ollama')) })

    // Si on a des données à envoyer, on les écrit dans la requête
    if (postData) req.write(postData)
    req.end()
  })
}

/**
 * Vérifie si le serveur Ollama est accessible et répond.
 * Utile pour afficher un statut dans l'interface ou avant de lancer une analyse.
 *
 * @returns true si Ollama répond, false sinon
 */
export async function checkOllama(): Promise<boolean> {
  try { const d = await ollamaRequest('GET', '/api/tags'); return !!d } catch { return false }
}

/**
 * Récupère la liste des modèles disponibles sur le serveur Ollama.
 * Ces modèles sont ceux déjà téléchargés et prêts à l'emploi.
 *
 * @returns Un tableau de noms de modèles (ex: ['qwen2.5:14b', 'llama3:8b'])
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const data = await ollamaRequest('GET', '/api/tags')
    // On parse la réponse JSON et on extrait les noms des modèles
    return (JSON.parse(data).models || []).map((m: { name: string }) => m.name)
  } catch { return [] }
}

/**
 * Télécharge (pull) un modèle depuis le registre Ollama.
 * C'est comme un "docker pull" mais pour les modèles d'IA.
 * Le téléchargement peut prendre plusieurs minutes selon la taille du modèle.
 *
 * @param modelName - Nom du modèle à télécharger (ex: 'qwen2.5:14b')
 * @returns true si le téléchargement a réussi, false sinon
 */
export async function pullOllamaModel(modelName: string): Promise<boolean> {
  try {
    logger.info(`Pull Ollama model: ${modelName}...`)
    const postData = JSON.stringify({ name: modelName, stream: false })
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/pull', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 1200000 // 20 minutes de timeout pour le téléchargement
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => { resolve(res.statusCode === 200) })
      })
      req.on('error', (err) => { logger.error('Pull error:', err); reject(err) })
      req.on('timeout', () => { req.destroy(); reject(new Error('Pull timeout')) })
      req.write(postData)
      req.end()
    })
  } catch { return false }
}

/**
 * Stream les tokens d'une conversation (Ollama /api/chat).
 *
 * Appelle onToken pour chaque morceau de texte généré, et onDone à la fin avec
 * le texte complet. Permet d'envoyer du SSE au navigateur en temps réel.
 *
 * @param model - Modèle Ollama (ex: 'mistral-nemo:12b')
 * @param messages - Historique de la conversation au format Ollama
 * @param onToken - Callback appelé pour chaque token reçu (string incrémental)
 * @param onDone - Callback final avec le texte complet
 * @param onError - Callback si la requête échoue
 */
export function chatStream(
  model: string,
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  onToken: (chunk: string) => void,
  onDone: (full: string) => void,
  onError: (err: Error) => void,
): { abort: () => void } {
  // Options Ollama :
  // - num_ctx 16384 : fenetre contexte assez large pour ingerer 9 sources HAL/OpenAlex
  //   (chaque source ~1500 chars => ~13k chars de prompt + reponse)
  // - num_predict 4096 : autorise des reponses longues (dossier bibliographique)
  const postData = JSON.stringify({
    model, messages, stream: true,
    options: { num_ctx: 16384, num_predict: 4096 },
  })
  const req = http.request({
    hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/chat', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    timeout: 1200000,
  }, (res) => {
    if (res.statusCode !== 200) {
      let errBody = ''
      res.on('data', (c) => { errBody += c })
      res.on('end', () => onError(new Error(`Ollama HTTP ${res.statusCode}: ${errBody}`)))
      return
    }
    let full = ''
    let buffer = ''
    res.on('data', (chunk) => {
      buffer += chunk.toString()
      // Chaque ligne complete est un objet JSON (NDJSON)
      let nlIdx
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim()
        buffer = buffer.slice(nlIdx + 1)
        if (!line) continue
        try {
          const json = JSON.parse(line)
          const piece = json.message?.content || ''
          if (piece) { full += piece; onToken(piece) }
          if (json.done) { onDone(full); return }
        } catch (e) {
          logger.error('Ollama stream parse error:', e)
        }
      }
    })
    res.on('end', () => { if (full) onDone(full) })
    res.on('error', (err) => onError(err))
  })
  req.on('error', (err) => onError(err))
  req.on('timeout', () => { req.destroy(); onError(new Error('Timeout Ollama')) })
  req.write(postData)
  req.end()
  return { abort: () => req.destroy() }
}

/**
 * Découpe une transcription longue en morceaux (chunks) de taille gérable.
 *
 * Pourquoi ? Les modèles de langage ont une taille de contexte limitée (nombre de
 * tokens qu'ils peuvent traiter en une fois). Si la transcription est trop longue,
 * il faut la découper en morceaux.
 *
 * Le chevauchement (overlap) entre les morceaux permet au LLM de garder du contexte
 * et d'éviter de couper un thème en plein milieu.
 *
 * @param transcript - La transcription complète à découper
 * @returns Un tableau de morceaux de texte
 */
function splitTranscriptIntoChunks(transcript: string): string[] {
  // Si la transcription tient dans un seul morceau, pas besoin de découper
  if (transcript.length <= MAX_CHARS_PER_CHUNK) return [transcript]

  const lines = transcript.split('\n')
  const chunks: string[] = []
  let currentChunk = ''
  let overlapBuffer = '' // Buffer contenant la fin du chunk précédent (pour le chevauchement)

  for (const line of lines) {
    const addition = (currentChunk ? '\n' : '') + line

    // Si ajouter cette ligne dépasse la taille max du chunk...
    if (currentChunk.length + addition.length > MAX_CHARS_PER_CHUNK) {
      if (currentChunk) {
        // On sauvegarde le chunk actuel
        chunks.push(currentChunk)
        // On garde les derniers caractères comme chevauchement pour le prochain chunk
        overlapBuffer = currentChunk.slice(-CHUNK_OVERLAP_CHARS)
        // Le nouveau chunk commence avec le chevauchement + la ligne courante
        currentChunk = overlapBuffer + '\n' + line
      } else {
        // Cas rare : une seule ligne dépasse la taille max, on la tronque
        chunks.push(line.substring(0, MAX_CHARS_PER_CHUNK))
        currentChunk = ''
      }
    } else {
      // Sinon, on ajoute simplement la ligne au chunk en cours
      currentChunk += addition
    }
  }

  // On n'oublie pas le dernier chunk s'il contient du texte
  if (currentChunk.trim()) chunks.push(currentChunk)
  return chunks
}

/**
 * Extrait la plage temporelle (premier et dernier timestamp) d'un texte horodaté.
 * Les timestamps sont au format [XXX.Xs] (ex: [123.5s]).
 *
 * @param text - Texte contenant des timestamps au format [XXX.Xs]
 * @returns Un objet avec le premier et le dernier timestamp, ou null si aucun trouvé
 */
function extractTimeRange(text: string): { first: number; last: number } | null {
  // Expression régulière pour trouver tous les timestamps du format [123.5s]
  const matches = text.match(/\[(\d+(?:\.\d+)?)s\]/g)
  if (!matches || matches.length === 0) return null

  // On convertit chaque match en nombre (ex: "[123.5s]" -> 123.5)
  const times = matches.map(m => parseFloat(m.replace(/[\[\]s]/g, '')))
  return { first: Math.min(...times), last: Math.max(...times) }
}

/**
 * Génère un résumé global de la transcription en demandant au LLM.
 * Ce résumé est ensuite utilisé comme contexte lors de l'analyse chunk par chunk,
 * pour que le LLM comprenne le sujet général même s'il ne voit qu'un morceau.
 *
 * @param transcript - La transcription complète
 * @param context - Contexte supplémentaire fourni par l'utilisateur
 * @param model - Nom du modèle Ollama à utiliser
 * @returns Le résumé généré par le LLM
 */
async function generateGlobalSummary(transcript: string, context: string, model: string): Promise<string> {
  // Prompt système qui explique au LLM ce qu'on attend de lui
  const systemPrompt = `Tu es un expert en analyse de contenu video et interview.
Ton but est de comprendre le sujet global d'une video a partir de sa transcription horodatee.
Identifie le theme principal, les intervenants si possible, les points cles abordes et le ton general.
Sois concis mais exhaustif sur les thematiques.`

  // On limite la taille de l'échantillon envoyé au LLM pour le résumé
  const MAX_SUMMARY_CHARS = 25000
  let sample: string

  if (transcript.length <= MAX_SUMMARY_CHARS) {
    // Si la transcription est assez courte, on l'envoie en entier
    sample = transcript
  } else {
    // Sinon, on prend un échantillon représentatif :
    // le début (1/3), le milieu (1/3), et la fin (1/3) de la transcription
    const ps = Math.floor(MAX_SUMMARY_CHARS / 3)
    sample = `${transcript.slice(0, ps)}\n\n[... milieu ...]\n\n${transcript.slice(Math.floor(transcript.length / 2) - Math.floor(ps / 2), Math.floor(transcript.length / 2) + Math.floor(ps / 2))}\n\n[... fin ...]\n\n${transcript.slice(-ps)}`
  }

  // Construction de la requête pour l'API chat d'Ollama
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `${context ? `CONTEXTE: ${context}\n\n` : ''}TRANSCRIPTION:\n"""\n${sample}\n"""\n\nAnalyse et fournis un resume structure.` }],
    stream: false, // On ne veut pas de streaming, on attend la réponse complète
    options: { temperature: 0.3, num_ctx: 8192 } // Température basse = réponse plus déterministe
  }

  try {
    const data = await ollamaRequest('POST', '/api/chat', body)
    return JSON.parse(data).message?.content || 'Aucun resume.'
  } catch (err) { logger.error('Erreur resume:', err); return 'Erreur resume.' }
}

/**
 * Tente d'extraire du JSON valide d'une réponse brute du LLM.
 * Les LLM ne retournent pas toujours du JSON parfait : parfois il y a du texte
 * avant ou après le JSON. Cette fonction essaie plusieurs stratégies pour extraire
 * le JSON.
 *
 * @param raw - La réponse brute du LLM
 * @returns L'objet JSON parsé, ou null si impossible à extraire
 */
function extractJsonFromResponse(raw: string): any {
  // Tentative 1 : parser directement (cas idéal)
  try { return JSON.parse(raw) } catch {
    // Tentative 2 : chercher un objet JSON dans le texte avec une regex
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) { try { return JSON.parse(match[0]) } catch {} }
    // Échec total : on retourne null
    return null
  }
}

/**
 * Analyse un morceau (chunk) de transcription pour identifier les segments thématiques.
 * Le LLM reçoit le texte horodaté et doit retourner un JSON avec les segments.
 *
 * @param chunk - Le morceau de transcription à analyser
 * @param context - Contexte fourni par l'utilisateur
 * @param globalSummary - Résumé global de la vidéo (pour garder le fil)
 * @param model - Nom du modèle Ollama
 * @param chunkIndex - Numéro du morceau en cours (pour le suivi)
 * @param totalChunks - Nombre total de morceaux
 * @param previousEndInfo - Info sur la fin du morceau précédent (pour la continuité)
 * @returns Un tableau de segments thématiques identifiés
 */
async function analyzeChunk(chunk: string, context: string, globalSummary: string, model: string, chunkIndex: number, totalChunks: number, previousEndInfo?: { title: string; endTime: number }): Promise<SegmentResult[]> {
  // On récupère la plage temporelle du chunk pour donner des repères au LLM
  const timeRange = extractTimeRange(chunk)

  // Prompt système avec des règles strictes pour le LLM
  // On lui explique exactement comment formater sa réponse
  const systemPrompt = `Tu es un expert en montage video d'interviews.
Tu dois decouper une transcription horodatee en segments thematiques SEQUENTIELS.

REGLES ABSOLUES :
1. Les segments sont SEQUENTIELS : le "start" du segment N+1 = le "end" du segment N.
2. COUVERTURE TOTALE : premier segment au premier timestamp, dernier au dernier.
3. Duree typique : 2 a 8 minutes par segment.
4. TITRES PRECIS.
5. Les timestamps [XXX.Xs] donnent le temps en secondes.
6. Reponds UNIQUEMENT avec du JSON valide.
7. Vise 5 a 15 segments pour 20-60 minutes.

{"segments":[{"title":"...","start":X,"end":Y,"description":"..."},...]}`

  // Indication du numéro de morceau (si la transcription est découpée en plusieurs)
  const chunkLabel = totalChunks > 1 ? `(partie ${chunkIndex + 1}/${totalChunks}) ` : ''
  // Indication de continuité : on dit au LLM où s'est arrêté le chunk précédent
  const continuityHint = previousEndInfo ? `\nCONTINUITE : chunk precedent termine avec "${previousEndInfo.title}" a ${previousEndInfo.endTime.toFixed(1)}s. Premier segment DOIT commencer a ${previousEndInfo.endTime.toFixed(1)}s.\n` : ''
  // Indication de la plage temporelle couverte par ce chunk
  const rangeHint = timeRange ? `\nExtrait de ${timeRange.first.toFixed(1)}s a ~${timeRange.last.toFixed(1)}s.` : ''

  // Construction du corps de la requête pour Ollama
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `SUJET:\n"${globalSummary.substring(0, 500)}"\n${continuityHint}${rangeHint}\n${context ? `CONSIGNES: ${context}\n` : ''}TRANSCRIPTION ${chunkLabel}:\n"""\n${chunk}\n"""\n\nDecoupe en segments thematiques SEQUENTIELS. JSON uniquement:\n{"segments":[{"title":"...","start":X,"end":Y,"description":"..."},...]}` }],
    format: 'json', // On demande à Ollama de forcer la sortie en JSON
    stream: false,
    options: { temperature: 0.1, num_ctx: 8192 } // Température très basse = réponse très déterministe
  }

  // Système de retry : on essaie jusqu'à 3 fois en cas d'échec
  // (les LLM peuvent parfois générer du JSON invalide)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await ollamaRequest('POST', '/api/chat', body)
      const content = JSON.parse(data).message?.content || '{}'
      const parsed = extractJsonFromResponse(content)

      // Vérification que la réponse contient bien des segments valides
      if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
        logger.warn(`[Ollama] Tentative ${attempt}/3 : pas de segments valides`)
        if (attempt < 3) continue // On réessaie
        return [] // Après 3 tentatives, on abandonne
      }
      return parsed.segments
    } catch (err) {
      logger.error(`[Ollama] Tentative ${attempt}/3 echouee:`, err)
      if (attempt >= 3) return []
      // Attente de 2 secondes avant de réessayer
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return []
}

/**
 * Nettoie et force la séquentialité des segments bruts retournés par le LLM.
 *
 * Les segments bruts du LLM peuvent avoir des problèmes :
 * - Chevauchements (deux segments couvrent la même période)
 * - Doublons (même segment retourné par deux chunks différents)
 * - Trous (périodes non couvertes entre deux segments)
 * - Segments trop courts (moins de 30 secondes)
 *
 * Cette fonction corrige tout cela pour obtenir des segments propres et séquentiels.
 *
 * @param rawSegments - Les segments bruts retournés par le LLM
 * @param totalDuration - La durée totale de la vidéo en secondes
 * @returns Les segments nettoyés, séquentiels et sans chevauchements
 */
export function cleanAndForceSequential(rawSegments: SegmentResult[], totalDuration: number): SegmentResult[] {
  if (rawSegments.length === 0) return []

  // Filtrage et tri : on ne garde que les segments valides (avec titre, start, end)
  // et on les trie par ordre chronologique
  const sorted = [...rawSegments].filter(s => s.title && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start).sort((a, b) => a.start - b.start)
  if (sorted.length === 0) return []

  // --- Étape 1 : Dédoublonnage ---
  // Quand la transcription est découpée en chunks avec chevauchement,
  // le LLM peut retourner le même segment deux fois. On fusionne les doublons.
  const deduped: SegmentResult[] = []
  for (const seg of sorted) {
    // On cherche si un segment existant chevauche celui-ci à plus de 70%
    const existing = deduped.find(d => {
      const os = Math.max(d.start, seg.start) // Début du chevauchement
      const oe = Math.min(d.end, seg.end)     // Fin du chevauchement
      const od = Math.max(0, oe - os)          // Durée du chevauchement
      // Si le chevauchement dépasse 70% de la durée du plus court segment, c'est un doublon
      return od > 0.7 * Math.min(seg.end - seg.start, d.end - d.start)
    })
    if (!existing) {
      // Pas de doublon : on ajoute le segment tel quel
      deduped.push({ ...seg })
    } else {
      // Doublon détecté : on fusionne (on garde le titre le plus long et on élargit les bornes)
      if (seg.title.length > existing.title.length) { existing.title = seg.title; existing.description = seg.description || existing.description }
      existing.start = Math.min(existing.start, seg.start)
      existing.end = Math.max(existing.end, seg.end)
    }
  }
  if (deduped.length === 0) return []

  // --- Étape 2 : Séquentialisation ---
  // On force les segments à être séquentiels (pas de chevauchement)
  const seq: SegmentResult[] = [deduped[0]]
  for (let i = 1; i < deduped.length; i++) {
    const prev = seq[seq.length - 1], curr = deduped[i]
    // Si le segment actuel chevauche le précédent, on ajuste son début
    if (curr.start < prev.end) curr.start = prev.end
    // Si après ajustement le segment fait plus de 5 secondes, on le garde
    if (curr.end > curr.start + 5) seq.push(curr)
    // Sinon, on l'absorbe dans le segment précédent
    else prev.end = Math.max(prev.end, curr.end)
  }

  // --- Étape 3 : Comblement des trous ---
  // S'il y a un trou entre deux segments, on étend le segment précédent
  // pour qu'il touche le segment suivant (couverture totale)
  for (let i = 0; i < seq.length - 1; i++) {
    if (seq[i + 1].start - seq[i].end > 0) seq[i].end = seq[i + 1].start
  }

  // --- Étape 4 : Ajustement des bornes globales ---
  // Le premier segment doit commencer au début, le dernier doit aller jusqu'à la fin
  if (totalDuration > 0) {
    seq[0].start = Math.max(0, Math.min(seq[0].start, sorted[0].start))
    seq[seq.length - 1].end = Math.max(seq[seq.length - 1].end, totalDuration)
  }

  // --- Étape 5 : Fusion des segments trop courts ---
  // Les segments de moins de 30 secondes sont fusionnés avec le précédent
  const merged: SegmentResult[] = []
  for (const s of seq) {
    if (s.end - s.start < 30 && merged.length > 0) merged[merged.length - 1].end = s.end
    else merged.push(s)
  }

  // --- Étape 6 : Formatage final ---
  // On arrondit les timestamps et on tronque les titres trop longs
  return merged.map(s => ({ title: s.title.substring(0, 80), start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, description: s.description || '' }))
}

/**
 * Fonction principale d'analyse de transcription.
 * C'est le point d'entrée appelé par le pipeline d'analyse.
 *
 * Processus :
 *   1. Vérifier que Ollama est disponible
 *   2. Générer un résumé global de la vidéo
 *   3. Découper la transcription en morceaux si nécessaire
 *   4. Analyser chaque morceau avec le LLM
 *   5. Nettoyer et fusionner les segments obtenus
 *
 * @param transcript - La transcription complète horodatée
 * @param context - Contexte supplémentaire fourni par l'utilisateur
 * @param model - Nom du modèle Ollama à utiliser
 * @param onChunkProgress - Callback de progression (index chunk, total chunks, nb segments, message)
 * @returns Le résultat de l'analyse contenant les segments thématiques
 */
export async function analyzeTranscript(transcript: string, context: string, model: string, onChunkProgress?: (ci: number, tc: number, sf: number, msg?: string) => void): Promise<AnalysisResult> {
  // Vérification préalable : Ollama doit être accessible
  const ollamaOk = await checkOllama()
  if (!ollamaOk) throw new Error('Ollama non disponible.')

  // On détermine la durée totale approximative à partir des timestamps
  // (+10 secondes de marge pour couvrir la fin de la dernière phrase)
  const globalTimeRange = extractTimeRange(transcript)
  const totalDuration = globalTimeRange ? globalTimeRange.last + 10 : 0

  // Étape 1 : Résumé global pour comprendre le sujet de la vidéo
  if (onChunkProgress) onChunkProgress(0, 1, 0, 'Analyse globale du sujet...')
  const globalSummary = await generateGlobalSummary(transcript, context, model)
  logger.info('[Ollama] Resume global:', globalSummary.substring(0, 200))

  // Étape 2 : Découpage de la transcription en morceaux gérables
  const chunks = splitTranscriptIntoChunks(transcript)
  const allRaw: SegmentResult[] = [] // Accumulation de tous les segments bruts
  let prevEnd: { title: string; endTime: number } | undefined // Info de continuité entre chunks

  logger.info(`[Ollama] ${chunks.length} morceaux a analyser`)

  // Étape 3 : Analyse chunk par chunk
  for (let i = 0; i < chunks.length; i++) {
    if (onChunkProgress) onChunkProgress(i, chunks.length, allRaw.length, `Analyse thematique ${i + 1}/${chunks.length}...`)

    // Analyse du chunk avec le LLM, en passant les infos de continuité
    const chunkSegs = await analyzeChunk(chunks[i], context, globalSummary, model, i, chunks.length, prevEnd)

    if (chunkSegs.length > 0) {
      allRaw.push(...chunkSegs)
      // On mémorise la fin du dernier segment pour la continuité avec le chunk suivant
      const last = chunkSegs[chunkSegs.length - 1]
      prevEnd = { title: last.title, endTime: typeof last.end === 'number' ? last.end : 0 }
    }
  }

  // Étape 4 : Nettoyage et séquentialisation des segments bruts
  const clean = cleanAndForceSequential(allRaw, totalDuration)
  logger.info(`[Ollama] ${clean.length} segments finaux`)
  return { segments: clean }
}

// ============================================================
// ANALYSE SEMANTIQUE : themes, sentiment, insights
// ============================================================

/**
 * Interface du resultat de l'analyse semantique.
 * - themes : liste des themes principaux identifies dans le texte
 * - sentiment : sentiment general (positif, negatif, neutre, mixte) avec explication
 * - insights : points cles et observations importantes
 */
interface SemanticResult {
  themes: string[]
  sentiment: { label: string; explanation: string }
  insights: string[]
}

/**
 * Analyse semantique d'une transcription via Ollama.
 * Envoie le texte au LLM pour extraire les themes, le sentiment general,
 * et les points cles du contenu.
 *
 * Pour les transcriptions longues, on echantillonne debut/milieu/fin
 * pour rester dans les limites du contexte du modele.
 *
 * @param transcript - Texte complet de la transcription (avec speakers si dispo)
 * @param model - Nom du modele Ollama a utiliser
 * @returns Resultat avec themes, sentiment et insights
 */
export async function semanticAnalysis(transcript: string, model: string): Promise<SemanticResult> {
  // Si la transcription est trop longue, on echantillonne 3 parties
  let textToAnalyze = transcript
  if (transcript.length > 25000) {
    const third = Math.floor(transcript.length / 3)
    const beginning = transcript.substring(0, 8000)
    const middle = transcript.substring(third, third + 8000)
    const ending = transcript.substring(transcript.length - 8000)
    textToAnalyze = `[DEBUT DE LA TRANSCRIPTION]\n${beginning}\n\n[MILIEU DE LA TRANSCRIPTION]\n${middle}\n\n[FIN DE LA TRANSCRIPTION]\n${ending}`
  }

  const systemPrompt = `Tu es un analyste de contenu expert. On te donne une transcription audio/video.
Tu dois analyser le contenu et retourner un JSON avec exactement cette structure :
{
  "themes": ["theme1", "theme2", ...],
  "sentiment": { "label": "positif|negatif|neutre|mixte", "explanation": "explication courte" },
  "insights": ["point cle 1", "point cle 2", ...]
}

Regles :
- themes : entre 5 et 10 themes principaux identifies dans le contenu, formules de maniere concise
- sentiment : le ton general de la conversation (positif, negatif, neutre ou mixte) avec une explication en 1-2 phrases
- insights : entre 5 et 10 observations ou points cles importants du contenu
- Reponds UNIQUEMENT avec le JSON, rien d'autre
- Tous les textes doivent etre en francais`

  const userPrompt = `Voici la transcription a analyser :\n\n${textToAnalyze}`

  // Tentatives (3 max) pour obtenir un JSON valide
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ollamaRequest('POST', '/api/chat', {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false,
        // num_ctx 12288 = environ 3000 tokens d'entree (transcript echantillonne ~24k chars)
        // + 8000 de marge. 32k provoquait OOM/crash sur Qwen2.5:14b sur GPU 8-12 Go.
        options: { temperature: 0.2, num_ctx: 12288 }
      })

      const parsed = JSON.parse(response)
      const content = parsed?.message?.content || ''

      // Extraction du JSON depuis la reponse (le LLM peut ajouter du texte autour)
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.warn(`[Ollama] Semantic: pas de JSON dans la reponse (tentative ${attempt + 1})`)
        continue
      }

      const result = JSON.parse(jsonMatch[0])

      // Validation de la structure
      if (!Array.isArray(result.themes) || !result.sentiment || !Array.isArray(result.insights)) {
        logger.warn(`[Ollama] Semantic: structure JSON invalide (tentative ${attempt + 1})`)
        continue
      }

      return {
        themes: result.themes.slice(0, 10),
        sentiment: {
          label: result.sentiment.label || 'neutre',
          explanation: result.sentiment.explanation || ''
        },
        insights: result.insights.slice(0, 10)
      }
    } catch (err: any) {
      logger.warn(`[Ollama] Semantic: erreur tentative ${attempt + 1}:`, err.message)
    }
  }

  throw new Error('Impossible d\'obtenir une analyse semantique apres 3 tentatives')
}

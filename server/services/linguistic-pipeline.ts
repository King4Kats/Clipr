/**
 * =============================================================================
 * Fichier : linguistic-pipeline.ts
 * Rôle    : Pipeline de transcription linguistique (collectage patois/vernaculaire)
 *
 *           Ce pipeline est conçu pour traiter des enregistrements de collectage
 *           linguistique rural, où un "meneur" pose des questions en français
 *           standard, et des "intervenants" répondent en patois/vernaculaire.
 *
 *           Approche hybride en 9 étapes :
 *           1. Extraction audio (si le fichier est une vidéo)
 *           2. Détection des silences → découpage en blocs de parole
 *           3. Classification linguistique (français vs vernaculaire) par bloc
 *              + filtres successifs (score, nom-pairé, pattern meneur, consécutifs)
 *           4. Validation Whisper + Ollama des blocs classés français
 *           5. Construction des séquences : meneur FR → variantes vernaculaires
 *           6. Rescue pass : récupérer les phrases du meneur ratées par le lang-id
 *           7. Rescue par diarisation : scanner les grosses séquences
 *           8. Transcription phonétique IPA (Allosaurus) sur les variantes
 *           9. Extraction des clips audio + sauvegarde en base de données
 *
 *           Chaque étape envoie sa progression via WebSocket (broadcastFn)
 *           pour que l'utilisateur puisse suivre en temps réel dans l'interface.
 * =============================================================================
 */

// ── Imports Node.js et services internes ──
import { extname, join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { execSync, spawn } from 'child_process'
import * as ffmpegService from './ffmpeg.js'       // Extraction audio, manipulation vidéo
import * as whisperService from './whisper.js'      // Transcription vocale → texte
import { vadDiarize } from './diarization.js'       // Identification des locuteurs (diarisation)
import { getDb } from './database.js'               // Accès à la base SQLite
import { updateTaskProgress } from './task-queue.js' // Mise à jour de la progression dans la queue
import { getProject, saveProject, updateProjectStatus } from './project-history.js'
import { randomUUID } from 'crypto'
import { logger } from '../logger.js'

import type { QueueTask } from './task-queue.js'

// Fonction de diffusion WebSocket (envoie des événements au frontend en temps réel)
type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void

// Extensions vidéo reconnues (les fichiers audio n'ont pas besoin d'extraction)
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts']
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')

/**
 * Une variante vernaculaire dans une séquence linguistique.
 * Chaque intervenant donne sa version d'un mot/expression en patois.
 */
interface LinguisticVariant {
  speaker: string
  ipa: string
  ipa_original: string
  audio: { start: number; end: number }
  audio_extract?: string
}

/**
 * Une séquence linguistique complète :
 * - La phrase du meneur en français (french_text + french_audio)
 * - Les variantes des intervenants en patois (variants[])
 */
interface LinguisticSequence {
  id: string
  index: number
  french_text: string
  french_audio: { start: number; end: number }
  variants: LinguisticVariant[]
}

/**
 * Fonction principale du pipeline linguistique.
 * Orchestrate les 9 étapes de traitement décrites dans l'en-tête du fichier.
 * Appelée par la file d'attente (task-queue) quand une tâche 'linguistic' démarre.
 */
export async function runLinguisticPipeline(task: QueueTask, broadcastFn: BroadcastFn): Promise<{ linguisticId: string }> {
  const { user_id: userId, config } = task
  const filePath: string = config.filePath
  const filename: string = config.filename || 'audio'
  const language: string = config.language || 'fr'
  const whisperModel: string = config.whisperModel || 'large-v3'
  const numSpeakers: number = config.numSpeakers || 10

  if (!filePath) throw new Error('filePath requis')

  const ext = extname(filePath).toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.includes(ext)
  let audioPath = filePath

  // ── Step 1 : Extraction audio si video ──
  if (isVideo) {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'extracting-audio', progress: 0, message: 'Extraction audio...'
    })
    audioPath = await ffmpegService.extractAudio(filePath, (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'extracting-audio', progress: percent, message: 'Extraction audio...'
      })
      updateTaskProgress(task.id, percent * 0.05, 'Extraction audio')
    })
  }

  // ── Step 2 : Silence detect → blocs de parole ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'segmenting', progress: 0, message: 'Detection des silences...'
  })

  const silenceResult = await runSilenceSegment(audioPath, (percent) => {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'segmenting', progress: percent, message: 'Segmentation par silences...'
    })
    updateTaskProgress(task.id, 5 + percent * 0.05, 'Segmentation')
  })

  if (!silenceResult || silenceResult.speech_blocks.length === 0) {
    throw new Error('Aucun bloc de parole detecte')
  }

  const speechBlocks = silenceResult.speech_blocks
  const duration = silenceResult.stats?.total_duration || 0
  logger.info(`[Linguistic] ${speechBlocks.length} blocs de parole`)

  // ── Step 3 : Detection de langue sur chaque bloc (FR vs vernaculaire) ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'diarizing', progress: 0, message: 'Detection de langue (FR / vernaculaire)...'
  })

  const classifiedBlocks = await runLangClassify(audioPath, speechBlocks, (percent) => {
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'diarizing', progress: percent, message: 'Classification linguistique...'
    })
    updateTaskProgress(task.id, 10 + percent * 0.15, 'Detection langue')
  })

  if (!classifiedBlocks || classifiedBlocks.length === 0) {
    throw new Error('Classification de langue echouee')
  }

  const initialFrCount = classifiedBlocks.filter((b: any) => b.is_french).length
  logger.info(`[Linguistic] Lang-id initial : ${initialFrCount} FR, ${classifiedBlocks.length - initialFrCount} vernaculaires`)

  // ── Step 3.1 : Filtre par score lang-id ──
  // Les vrais FR ont score ~0, les faux positifs < -0.5.
  // Seuil permissif (-0.8) car les filtres name-text + meneur-pattern rattrapent en aval.
  const SCORE_THRESHOLD = -0.8
  let scoreReclassified = 0
  for (const block of classifiedBlocks) {
    if (block.is_french && typeof block.score === 'number' && block.score < SCORE_THRESHOLD) {
      block.is_french = false
      block.reclassified_score = true
      scoreReclassified++
    }
  }
  logger.info(`[Linguistic] Filtre score (<${SCORE_THRESHOLD}) : -${scoreReclassified} → ${initialFrCount - scoreReclassified} FR`)

  // ── Step 3.2 : Filtre name-paired ──
  // Le meneur ne dit JAMAIS son nom. Un bloc FR precede d'un bloc "name" = intervenant → vernaculaire.
  const namePairIds = new Set(
    classifiedBlocks.filter((b: any) => b.type === 'name' && b.pair_id >= 0).map((b: any) => b.pair_id)
  )
  let namePairedReclassified = 0
  for (const block of classifiedBlocks) {
    if (block.is_french && block.type === 'name') {
      block.is_french = false
      block.reclassified_name = true
      namePairedReclassified++
    } else if (block.is_french && block.type === 'speech' && block.pair_id >= 0 && namePairIds.has(block.pair_id)) {
      block.is_french = false
      block.reclassified_name_paired = true
      namePairedReclassified++
    }
  }
  const afterPreFilters = classifiedBlocks.filter((b: any) => b.is_french).length
  logger.info(`[Linguistic] Filtre name-paired : -${namePairedReclassified} → ${afterPreFilters} FR`)

  let frBlocks = classifiedBlocks.filter((b: any) => b.is_french)

  // ── Step 3.5 : VALIDATION FR — Whisper + Ollama anti-hallucination ──
  // On transcrit les blocs classés "français" avec Whisper pour vérifier
  // que le contenu est bien du français (et pas du vernaculaire mal classé).
  // On transcrit aussi les blocs "name" pour extraire les prénoms des intervenants.
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'transcribing', progress: 0, message: 'Validation des blocs francais...'
  })

  // Whisper batch sur blocs FR candidats + blocs name (extraction noms)
  const tempDir = join(DATA_DIR, 'temp')
  const batchClips: { id: string; audioPath: string }[] = []

  // Clips FR pour validation
  for (let i = 0; i < frBlocks.length; i++) {
    const block = frBlocks[i]
    const clipPath = join(tempDir, `ling_validate_${task.id}_${i}.wav`)
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ss ${block.start} -to ${block.end} -ar 16000 -ac 1 "${clipPath}" 2>/dev/null`)
      batchClips.push({ id: `validate_${i}`, audioPath: clipPath })
    } catch {}
  }

  // Clips name pour extraction des noms de speakers (blocs pairies)
  const nameBlocks = classifiedBlocks.filter((b: any) => b.type === 'name' && b.pair_id >= 0)
  for (let i = 0; i < nameBlocks.length; i++) {
    const block = nameBlocks[i]
    const clipPath = join(tempDir, `ling_name_${task.id}_${i}.wav`)
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ss ${block.start} -to ${block.end} -ar 16000 -ac 1 "${clipPath}" 2>/dev/null`)
      batchClips.push({ id: `name_${i}`, audioPath: clipPath })
    } catch {}
  }

  // Calculer la duree moyenne des noms depuis les blocs pairies
  const nameDurations = nameBlocks.map((b: any) => b.end - b.start).filter((d: number) => d > 0.3 && d < 2.0)
  const avgNameDuration = nameDurations.length > 0
    ? nameDurations.reduce((a: number, b: number) => a + b, 0) / nameDurations.length
    : 1.0
  logger.info(`[Linguistic] Duree moyenne nom : ${avgNameDuration.toFixed(2)}s (sur ${nameDurations.length} blocs)`)

  // Clips "unknown-name" : pour les blocs vernaculaires non-pairies (type=unknown),
  // extraire la partie nom (debut du bloc → avgNameDuration) pour identifier le speaker.
  // Ces blocs contiennent nom+vernaculaire en un seul morceau.
  const unknownVernBlocks = classifiedBlocks.filter((b: any) =>
    !b.is_french && b.type === 'unknown' && b.pair_id === -1 && (b.end - b.start) >= avgNameDuration + 1.0
  )
  for (let i = 0; i < unknownVernBlocks.length; i++) {
    const block = unknownVernBlocks[i]
    const nameEnd = block.start + avgNameDuration
    const clipPath = join(tempDir, `ling_unkname_${task.id}_${i}.wav`)
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ss ${block.start} -to ${nameEnd} -ar 16000 -ac 1 "${clipPath}" 2>/dev/null`)
      batchClips.push({ id: `unkname_${i}`, audioPath: clipPath })
    } catch {}
  }
  logger.info(`[Linguistic] Whisper batch : ${frBlocks.length} FR + ${nameBlocks.length} noms + ${unknownVernBlocks.length} unknown-noms = ${batchClips.length} clips`)

  await whisperService.loadWhisperModel(whisperModel)
  const batchResults = await whisperService.transcribeBatch(
    batchClips, language,
    (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'transcribing', progress: Math.round(percent * 0.3),
        message: `Transcription (${batchClips.length} blocs)...`
      })
      updateTaskProgress(task.id, 25 + percent * 0.10, 'Validation FR + noms')
    }
  )

  // Nettoyer clips
  for (const clip of batchClips) { try { unlinkSync(clip.audioPath) } catch {} }

  // Stocker le texte Whisper dans chaque bloc FR
  for (let i = 0; i < frBlocks.length; i++) {
    const segs = batchResults.get(`validate_${i}`)
    frBlocks[i].whisper_text = segs && segs.length > 0
      ? segs.map((s: any) => s.text).join(' ').trim()
      : ''
  }

  // Construire nameByPairId : pair_id → nom nettoye
  // Phase 1 : extraire tous les noms bruts
  const rawNames = new Map<number, string>()
  for (let i = 0; i < nameBlocks.length; i++) {
    const segs = batchResults.get(`name_${i}`)
    let name = segs && segs.length > 0
      ? segs.map((s: any) => s.text).join(' ').trim()
      : ''
    name = name.replace(/^[\s.,!?;:'"«»]+|[\s.,!?;:'"«»]+$/g, '').trim()
    if (name.length >= 2) {
      const words = name.split(/\s+/)
      // Capitaliser
      name = words.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      rawNames.set(nameBlocks[i].pair_id, name)
    }
  }

  // Phase 2 : compter la frequence de chaque prenom (1er mot)
  // Les vrais speakers parlent plusieurs fois → leur prenom apparait >= 2 fois
  // Les hallucinations sont aleatoires → apparaissent 1 seule fois
  // IMPORTANT : exclure les mots courants FR — Whisper hallucine "Elle...", "Il..." sur les blocs courts
  const NOT_A_FIRST_NAME = new Set([
    'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'il', 'elle', 'ils', 'elles',
    'on', 'je', 'tu', 'nous', 'vous', 'au', 'aux', 'ce', 'cette', 'ces', 'son', 'sa',
    'ses', 'et', 'ou', 'mais', 'donc', 'car', 'en', 'sur', 'dans', 'pour', 'par',
    'avec', 'sans', 'que', 'qui', 'ne', 'pas', 'se', 'est', 'a', 'sont', 'fait',
    'mis', 'dit', 'va', 'bien', 'bon', 'tout', 'tous', 'toute', 'alors', 'euh',
    "qu'est-ce", "d'un", "l'a", "c'est"
  ])
  const firstNameCounts = new Map<string, number>()
  for (const fullName of rawNames.values()) {
    const firstName = fullName.split(/\s+/)[0].toLowerCase()
    if (NOT_A_FIRST_NAME.has(firstName)) continue
    firstNameCounts.set(firstName, (firstNameCounts.get(firstName) || 0) + 1)
  }

  // Prenoms confirmes : seulement depuis les blocs pairies (fiables)
  const confirmedFirstNames = new Set<string>()
  for (const [firstName, count] of firstNameCounts) {
    if (count >= 2) confirmedFirstNames.add(firstName)
  }
  const nameByPairId = new Map<number, string>()
  for (const [pairId, fullName] of rawNames) {
    const firstName = fullName.split(/\s+/)[0].toLowerCase()
    if (confirmedFirstNames.has(firstName)) {
      nameByPairId.set(pairId, fullName)
    }
  }

  // Noms des blocs unknown : NE PAS compter pour la frequence (trop de bruit Whisper).
  // Utiliser uniquement pour l'assignation speaker SI le prenom matche un confirme.
  const nameByBlockStart = new Map<number, string>()
  for (let i = 0; i < unknownVernBlocks.length; i++) {
    const segs = batchResults.get(`unkname_${i}`)
    let name = segs && segs.length > 0
      ? segs.map((s: any) => s.text).join(' ').trim()
      : ''
    name = name.replace(/^[\s.,!?;:'"«»]+|[\s.,!?;:'"«»]+$/g, '').trim()
    if (name.length >= 2) {
      const words = name.split(/\s+/)
      name = words.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      const firstName = words[0].toLowerCase().replace(/[,;:.]+$/, '')
      // Seulement si le prenom est confirme par les blocs pairies
      if (confirmedFirstNames.has(firstName)) {
        nameByBlockStart.set(Math.round(unknownVernBlocks[i].start * 10), name)
      }
    }
  }
  logger.info(`[Linguistic] Unknown-names valides : ${nameByBlockStart.size} sur ${unknownVernBlocks.length}`)

  const uniqueSpeakers = [...new Set([...nameByPairId.values(), ...nameByBlockStart.values()])]
  logger.info(`[Linguistic] Noms confirmes : ${uniqueSpeakers.length} speakers (${uniqueSpeakers.join(', ')})`)
  logger.info(`[Linguistic] Prenoms confirmes : ${[...confirmedFirstNames].join(', ')}`)

  // ── Step 3.6 : Filtre post-Whisper par nom en debut de texte ──
  // Le meneur ne commence JAMAIS par un prenom. Si le texte Whisper d'un bloc FR
  // commence par un prenom confirme → c'est un intervenant, pas le meneur.
  let nameTextReclassified = 0
  if (confirmedFirstNames.size > 0) {
    for (const block of frBlocks) {
      if (!block.is_french) continue
      const text = (block.whisper_text || '').trim()
      if (!text) continue
      // Prendre le premier mot du texte Whisper (avant espace, virgule, point)
      const firstWord = text.split(/[\s,;:.]+/)[0]
      if (firstWord && confirmedFirstNames.has(firstWord.toLowerCase())) {
        block.is_french = false
        block.reclassified_name_text = true
        nameTextReclassified++
        logger.info(`[Linguistic] Filtre name-text : "${text.substring(0, 60)}" (commence par ${firstWord})`)
      }
    }
  }
  logger.info(`[Linguistic] Filtre name-text : -${nameTextReclassified} → ${frBlocks.filter((b: any) => b.is_french).length} FR`)

  // ── Step 3.7 : Filtre meneur-pattern ──
  // Les phrases du meneur commencent TOUJOURS par un pronom sujet ou article.
  // Un texte FR qui commence par autre chose (nom propre, charabia) = faux positif.
  const MENEUR_STARTERS = new Set([
    'elle', 'il', 'ils', 'elles', 'on', 'un', 'une', 'le', 'la', 'les', 'des',
    'du', 'de', 'au', 'aux', 'ce', 'cette', 'ces', 'nous', 'vous', 'je', 'tu',
    'son', 'sa', 'ses', "l'", "c'est", "qu'elle", "qu'il"
  ])
  let meneurPatternReclassified = 0
  for (const block of frBlocks) {
    if (!block.is_french) continue
    const text = (block.whisper_text || '').trim()
    if (!text) continue
    // Extraire le 1er mot, normaliser (gerer l'apostrophe : "L'homme" → "l'")
    let firstWord = text.split(/[\s,;:.]+/)[0].toLowerCase()
    // Gerer les contractions : "l'entonnoir" → "l'"
    const apoMatch = firstWord.match(/^([a-zà-ü]+')/i)
    if (apoMatch) firstWord = apoMatch[1]
    if (!MENEUR_STARTERS.has(firstWord)) {
      block.is_french = false
      block.reclassified_meneur_pattern = true
      meneurPatternReclassified++
      logger.info(`[Linguistic] Filtre meneur-pattern : "${text.substring(0, 60)}" (commence par "${firstWord}")`)
    }
  }
  logger.info(`[Linguistic] Filtre meneur-pattern : -${meneurPatternReclassified} → ${frBlocks.filter((b: any) => b.is_french).length} FR`)

  // ── DEBUG : dump complet de tous les blocs FR initiaux avec leur statut ──
  logger.info(`[Linguistic] === DUMP blocs FR (${classifiedBlocks.filter((b: any) => b.lang === 'fr' || b.reclassified_score || b.reclassified_name || b.reclassified_name_paired || b.reclassified_name_text || b.reclassified_meneur_pattern).length} blocs) ===`)
  for (const block of classifiedBlocks) {
    // Trouver tous les blocs qui etaient FR au depart (is_french === true OU reclassifies par un filtre)
    const wasInitiallyFR = block.is_french || block.reclassified_score || block.reclassified_name || block.reclassified_name_paired || block.reclassified_name_text || block.reclassified_meneur_pattern
    if (!wasInitiallyFR) continue
    const filters: string[] = []
    if (block.reclassified_score) filters.push('SCORE')
    if (block.reclassified_name) filters.push('NAME-BLOCK')
    if (block.reclassified_name_paired) filters.push('NAME-PAIRED')
    if (block.reclassified_name_text) filters.push('NAME-TEXT')
    if (block.reclassified_meneur_pattern) filters.push('MENEUR-PAT')
    const status = block.is_french ? '✓ FR' : `✗ ${filters.join('+')}`
    const text = block.whisper_text ? ` "${block.whisper_text.substring(0, 50)}"` : ''
    logger.info(`[Linguistic]   ${block.start.toFixed(1)}-${block.end.toFixed(1)}s [${block.type}|p${block.pair_id}|s${block.score?.toFixed(2)}] ${status}${text}`)
  }
  logger.info(`[Linguistic] === FIN DUMP ===`)

  // Ollama desactive sur le pipeline principal — fait plus de mal que de bien
  // (tue des bonnes phrases FR). Les filtres score + name-paired + name-text + meneur-pattern suffisent.
  // Ollama reste actif pour le rescue pass (filtrage gibberish sur les candidats recuperes).
  let validFrCount = classifiedBlocks.filter((b: any) => b.is_french).length

  // ── Step 3.7 : Regle des FR consecutifs ──
  // Si plusieurs blocs FR se suivent sans bloc vernaculaire entre eux,
  // seul le PREMIER est le vrai meneur. Les suivants = vernaculaire mal classe.
  // Le meneur dit UNE phrase puis les intervenants parlent en vernaculaire.
  let lastWasFr = false
  let consecutiveReclassified = 0
  for (const block of classifiedBlocks) {
    if (block.is_french) {
      if (lastWasFr) {
        block.is_french = false
        block.reclassified_consecutive = true
        consecutiveReclassified++
        validFrCount--
      }
      lastWasFr = true
    } else {
      lastWasFr = false
    }
  }

  logger.info(`[Linguistic] Consecutifs : -${consecutiveReclassified} → ${validFrCount} FR`)
  logger.info(`[Linguistic] Bilan filtres : ${initialFrCount} initial → ${validFrCount} final (score: -${scoreReclassified}, name-paired: -${namePairedReclassified}, name-text: -${nameTextReclassified}, meneur-pattern: -${meneurPatternReclassified}, consec: -${consecutiveReclassified})`)

  updateTaskProgress(task.id, 35, 'Sequences')

  // ── Step 4 : Construire les sequences par la LANGUE VALIDEE ──
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'segmenting', progress: 0, message: 'Construction des sequences...'
  })

  let sequences: LinguisticSequence[] = []
  let currentSeq: LinguisticSequence | null = null

  for (const block of classifiedBlocks) {
    if (block.is_french) {
      // Bloc FR valide = nouvelle sequence
      if (currentSeq) sequences.push(currentSeq)
      currentSeq = {
        id: randomUUID(),
        index: sequences.length,
        french_text: block.whisper_text || '',
        french_audio: { start: block.start, end: block.end },
        variants: []
      }
    } else if (currentSeq) {
      // Les blocs "name" servent a identifier le speaker, pas comme variantes
      if (block.type === 'name') continue

      const dur = block.end - block.start
      if (dur >= 1.0) {
        let speaker = 'LOCUTEUR'
        let audioStart = block.start
        let audioEnd = block.end

        if (block.pair_id >= 0 && nameByPairId.has(block.pair_id)) {
          // Bloc paire : le speaker vient du bloc name associe
          speaker = nameByPairId.get(block.pair_id)!
        } else if (block.type === 'unknown' && block.pair_id === -1 && dur >= avgNameDuration + 1.0) {
          // Bloc non-paire : le nom est au debut de l'audio
          // Offsetter le start pour sauter le nom → IPA et clip sur la partie speech seulement
          audioStart = block.start + avgNameDuration
          // Chercher le speaker via nameByBlockStart
          const key = Math.round(block.start * 10)
          if (nameByBlockStart.has(key)) {
            const fullName = nameByBlockStart.get(key)!
            const firstName = fullName.split(/\s+/)[0].toLowerCase()
            if (confirmedFirstNames.has(firstName)) {
              speaker = fullName
            }
          }
        }

        currentSeq.variants.push({
          speaker,
          ipa: '',
          ipa_original: '',
          audio: { start: audioStart, end: audioEnd }
        })
      }
    }
  }
  if (currentSeq) sequences.push(currentSeq)

  sequences = sequences.filter(s => s.variants.length >= 1)
  sequences.forEach((s, i) => s.index = i)

  logger.info(`[Linguistic] ${sequences.length} sequences (avant rescue), ${sequences.reduce((s, q) => s + q.variants.length, 0)} variantes`)

  // ── Step 4.5 : RESCUE PASS — recuperer les leaders rates par le lang-id ──
  // Le silence-segment a detecte N sequences (gap > 5s), chacune avec un "leader" (1er bloc).
  // Notre pipeline n'en garde qu'une partie. Pour les leaders manquants, on Whisper le bloc
  // et si c'est du vrai FR (meneur pattern), on split la sequence.
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'transcribing', progress: 50, message: 'Rescue des phrases manquantes...'
  })

  const silenceSequences = silenceResult.sequences || []
  const existingFrStarts = sequences.map(s => s.french_audio.start)

  // Trouver les leaders de silence-segment qui ne sont pas dans nos sequences
  // Un leader est "deja trouve" si une sequence existante commence dans un rayon de 5s
  const rescueCandidates: { start: number; end: number }[] = []
  for (const silSeq of silenceSequences) {
    const leader = silSeq.leader
    if (!leader) continue
    const alreadyFound = existingFrStarts.some(t => Math.abs(t - leader.start) <= 5.0)
    if (!alreadyFound) {
      rescueCandidates.push({ start: leader.start, end: leader.end })
    }
  }

  logger.info(`[Linguistic] Rescue : ${rescueCandidates.length} leaders manquants sur ${silenceSequences.length} sequences silence-segment`)

  if (rescueCandidates.length > 0) {
    // Whisper batch sur les rescue candidates
    const rescueClips: { id: string; audioPath: string }[] = []
    for (let i = 0; i < rescueCandidates.length; i++) {
      const c = rescueCandidates[i]
      const clipPath = join(tempDir, `ling_rescue_${task.id}_${i}.wav`)
      try {
        execSync(`ffmpeg -y -i "${audioPath}" -ss ${c.start} -to ${c.end} -ar 16000 -ac 1 "${clipPath}" 2>/dev/null`)
        rescueClips.push({ id: `rescue_${i}`, audioPath: clipPath })
      } catch {}
    }

    if (rescueClips.length > 0) {
      const rescueResults = await whisperService.transcribeBatch(
        rescueClips, language,
        (percent) => {
          broadcastFn(userId, null, 'linguistic:progress', {
            taskId: task.id, step: 'transcribing', progress: 50 + Math.round(percent * 0.1),
            message: `Rescue (${rescueClips.length} blocs)...`
          })
        }
      )

      // Nettoyer clips
      for (const clip of rescueClips) { try { unlinkSync(clip.audioPath) } catch {} }

      // Evaluer chaque rescue : meneur-pattern + Ollama
      const rescueTexts: { idx: number; text: string; start: number; end: number; ollamaOK?: boolean }[] = []
      for (let i = 0; i < rescueCandidates.length; i++) {
        const segs = rescueResults.get(`rescue_${i}`)
        const text = segs && segs.length > 0 ? segs.map((s: any) => s.text).join(' ').trim() : ''
        if (!text || text.length < 5) continue

        // Verifier meneur-pattern : commence par pronom/article ?
        let firstWord = text.split(/[\s,;:.]+/)[0].toLowerCase()
        const apoMatch2 = firstWord.match(/^([a-zà-ü]+')/i)
        if (apoMatch2) firstWord = apoMatch2[1]

        // Verifier aussi que le texte ne commence pas par un prenom confirme
        const isNameStart = confirmedFirstNames.has(firstWord)
        const isMeneurPattern = MENEUR_STARTERS.has(firstWord)

        if (isMeneurPattern && !isNameStart) {
          rescueTexts.push({ idx: i, text, start: rescueCandidates[i].start, end: rescueCandidates[i].end })
        } else {
          logger.info(`[Linguistic] Rescue SKIP : ${rescueCandidates[i].start.toFixed(1)}s "${text.substring(0, 50)}" (${isNameStart ? 'nom' : 'pas meneur'})`)
        }
      }

      // Ollama validation sur les rescue candidates qui ont passe le meneur-pattern
      if (rescueTexts.length > 0) {
        try {
          const ollamaModel = config.ollamaModel || 'qwen2.5:14b'
          const rescueOllamaTexts = rescueTexts.map((r, i) => `${i+1}. "${r.text}"`).join('\n')
          const rescuePrompt = `Tu analyses des phrases transcrites depuis un enregistrement audio de collectage linguistique rural. Un meneur dit des phrases en francais decrivant des objets, ustensiles, actions du quotidien ou de la vie paysanne.

IMPORTANT : le vocabulaire peut etre ancien, regional ou rare (ex: "clissee", "mazarine", "terrine", "ecumoire", "grilloir"). Accepte les phrases meme si certains mots sont inhabituels, tant que la structure est du francais.

Reponds "FR" si la phrase a une structure grammaticale francaise (sujet + verbe + complement), meme avec des mots rares.
Reponds "FAUX" UNIQUEMENT si c'est du vrai charabia incomprehensible, des syllabes sans sens, ou des mots completement inventes enchaines.

Exemples de FR : "Elle se sert de l'entonnoir de cuisine", "Il a une bouteille clissee", "Elle a des mazarines", "Une casserole bosselee"
Exemples de FAUX : "la fete ingralaille pour les petits dejeuners", "Au nom du Nord-Ne latine bonbon appaiai", "Vous vous redonnez la farine 3-7 caglias"

${rescueOllamaTexts}

Pour chaque numero, reponds UNIQUEMENT "FR" ou "FAUX". Format strict :
1. FR
2. FAUX`

          logger.info(`[Linguistic] Rescue Ollama : validation de ${rescueTexts.length} candidats...`)
          const rescueOllamaResp = await ollamaGenerate(ollamaModel, rescuePrompt)
          logger.info(`[Linguistic] Rescue Ollama reponse : ${rescueOllamaResp.substring(0, 200)}`)

          const rescueLines = rescueOllamaResp.split('\n')
          for (const line of rescueLines) {
            const match = line.match(/(\d+)\.\s*(FR|FAUX)/i)
            if (match) {
              const idx = parseInt(match[1]) - 1
              const isFR = match[2].toUpperCase() === 'FR'
              if (idx >= 0 && idx < rescueTexts.length) {
                rescueTexts[idx].ollamaOK = isFR
              }
            }
          }
        } catch (err: any) {
          logger.warn(`[Linguistic] Rescue Ollama echoue: ${err.message}. On garde tous les candidats.`)
          for (const r of rescueTexts) r.ollamaOK = true
        }
      }

      // Ajouter les sequences rescuees validees
      let rescuedCount = 0
      for (const r of rescueTexts) {
        if (r.ollamaOK === false) {
          logger.info(`[Linguistic] Rescue Ollama FAUX : ${r.start.toFixed(1)}s "${r.text.substring(0, 60)}"`)
          continue
        }
        const newSeq: LinguisticSequence = {
          id: randomUUID(),
          index: 0,
          french_text: r.text,
          french_audio: { start: r.start, end: r.end },
          variants: []
        }
        sequences.push(newSeq)
        rescuedCount++
        logger.info(`[Linguistic] Rescue OK : ${r.start.toFixed(1)}s "${r.text.substring(0, 60)}"`)
      }

      if (rescuedCount > 0) {
        // Re-trier par temps, re-indexer, et re-distribuer les variantes
        sequences.sort((a, b) => a.french_audio.start - b.french_audio.start)

        // Re-construire les variantes a partir des classifiedBlocks
        // (les sequences rescuees n'ont pas encore de variantes)
        const allVariantBlocks = classifiedBlocks.filter((b: any) =>
          !b.is_french && b.type !== 'name' && (b.end - b.start) >= 1.0
        ).sort((a: any, b: any) => a.start - b.start)

        // Vider les variantes et les re-assigner
        for (const seq of sequences) seq.variants = []
        for (const block of allVariantBlocks) {
          // Trouver la derniere sequence dont le french_audio.start < block.start
          let targetSeq: LinguisticSequence | null = null
          for (let si = sequences.length - 1; si >= 0; si--) {
            if (sequences[si].french_audio.start < block.start) {
              targetSeq = sequences[si]
              break
            }
          }
          if (targetSeq) {
            let speaker = 'LOCUTEUR'
            let aStart = block.start
            if (block.pair_id >= 0 && nameByPairId.has(block.pair_id)) {
              speaker = nameByPairId.get(block.pair_id)!
            } else if (block.type === 'unknown' && block.pair_id === -1 && (block.end - block.start) >= avgNameDuration + 1.0) {
              aStart = block.start + avgNameDuration
              const key = Math.round(block.start * 10)
              if (nameByBlockStart.has(key)) {
                const fn = nameByBlockStart.get(key)!.split(/\s+/)[0].toLowerCase()
                if (confirmedFirstNames.has(fn)) speaker = nameByBlockStart.get(key)!
              }
            }
            targetSeq.variants.push({ speaker, ipa: '', ipa_original: '', audio: { start: aStart, end: block.end } })
          }
        }

        sequences = sequences.filter(s => s.variants.length >= 1)
        sequences.forEach((s, i) => s.index = i)

        logger.info(`[Linguistic] Apres rescue : ${sequences.length} sequences (+${rescuedCount}), ${sequences.reduce((s, q) => s + q.variants.length, 0)} variantes`)
      }
    }
  }

  // ── Step 4.7 : RESCUE DIARISATION — scanner les grosses sequences ──
  // Pour les sequences avec trop de variantes, le meneur a probablement dit d'autres phrases
  // que le lang-id a ratees. On utilise la diarisation pour identifier la voix du meneur
  // parmi les variantes, puis Whisper + meneur-pattern pour valider.
  const DIAR_RESCUE_THRESHOLD = 15
  const oversizedSeqs = sequences.filter(s => s.variants.length > DIAR_RESCUE_THRESHOLD)

  if (oversizedSeqs.length > 0) {
    logger.info(`[Linguistic] Diar-rescue : ${oversizedSeqs.length} sequences avec >${DIAR_RESCUE_THRESHOLD} variantes`)
    broadcastFn(userId, null, 'linguistic:progress', {
      taskId: task.id, step: 'diarizing', progress: 0, message: `Diarisation des sequences longues (${oversizedSeqs.length})...`
    })

    let totalDiarRescued = 0

    for (let oi = 0; oi < oversizedSeqs.length; oi++) {
      const seq = oversizedSeqs[oi]
      const seqIdx = sequences.indexOf(seq)
      const nextSeq = sequences[seqIdx + 1]
      const segStart = seq.french_audio.start
      const segEnd = nextSeq ? nextSeq.french_audio.start : duration

      logger.info(`[Linguistic] Diar-rescue seq ${seq.index} : ${segStart.toFixed(1)}-${segEnd.toFixed(1)}s (${seq.variants.length} variantes)`)

      // Extraire l'audio de cette zone
      const segAudioPath = join(tempDir, `ling_diarseg_${task.id}_${oi}.wav`)
      try {
        execSync(`ffmpeg -y -i "${audioPath}" -ss ${segStart} -to ${segEnd} -ar 16000 -ac 1 "${segAudioPath}" 2>/dev/null`)
      } catch { continue }

      // Diariser cette zone
      const diarResult = await vadDiarize(segAudioPath, (p) => {
        broadcastFn(userId, null, 'linguistic:progress', {
          taskId: task.id, step: 'diarizing',
          progress: Math.round(((oi + p / 100) / oversizedSeqs.length) * 100),
          message: `Diarisation sequence ${oi + 1}/${oversizedSeqs.length}...`
        })
      }, numSpeakers)

      try { unlinkSync(segAudioPath) } catch {}

      if (!diarResult || diarResult.length < 2) {
        logger.info(`[Linguistic] Diar-rescue seq ${seq.index} : pas assez de segments (${diarResult?.length || 0})`)
        continue
      }

      // Le meneur = le speaker du tout premier segment (il parle en premier)
      const meneurSpeaker = diarResult[0].speaker
      logger.info(`[Linguistic] Diar-rescue seq ${seq.index} : meneur=${meneurSpeaker}, ${diarResult.length} turns, ${new Set(diarResult.map(d => d.speaker)).size} speakers`)

      // Trouver les autres blocs du meneur (pas le premier, c'est deja notre sequence leader)
      // Les timestamps sont relatifs au segment → ajouter segStart
      const meneurBlocks = diarResult
        .filter(d => d.speaker === meneurSpeaker)
        .map(d => ({ start: d.start + segStart, end: d.end + segStart }))
        .filter(d => d.start > seq.french_audio.end + 2.0) // Exclure le leader deja connu (avec marge)

      if (meneurBlocks.length === 0) {
        logger.info(`[Linguistic] Diar-rescue seq ${seq.index} : aucun autre bloc meneur`)
        continue
      }

      logger.info(`[Linguistic] Diar-rescue seq ${seq.index} : ${meneurBlocks.length} blocs meneur candidats`)

      // Whisper batch sur les blocs meneur candidats
      const diarClips: { id: string; audioPath: string }[] = []
      for (let i = 0; i < meneurBlocks.length; i++) {
        const mb = meneurBlocks[i]
        const clipPath = join(tempDir, `ling_diarrescue_${task.id}_${oi}_${i}.wav`)
        try {
          execSync(`ffmpeg -y -i "${audioPath}" -ss ${mb.start} -to ${mb.end} -ar 16000 -ac 1 "${clipPath}" 2>/dev/null`)
          diarClips.push({ id: `diar_${oi}_${i}`, audioPath: clipPath })
        } catch {}
      }

      if (diarClips.length === 0) continue

      const diarWhisperResults = await whisperService.transcribeBatch(
        diarClips, language, () => {}
      )
      for (const clip of diarClips) { try { unlinkSync(clip.audioPath) } catch {} }

      // Evaluer chaque bloc : meneur-pattern + collect pour Ollama
      const diarTexts: { text: string; start: number; end: number; ollamaOK?: boolean }[] = []
      for (let i = 0; i < meneurBlocks.length; i++) {
        const segs = diarWhisperResults.get(`diar_${oi}_${i}`)
        const text = segs && segs.length > 0 ? segs.map((s: any) => s.text).join(' ').trim() : ''
        if (!text || text.length < 5) continue

        let firstWord = text.split(/[\s,;:.]+/)[0].toLowerCase()
        const apoM = firstWord.match(/^([a-zà-ü]+')/i)
        if (apoM) firstWord = apoM[1]

        const isName = confirmedFirstNames.has(firstWord)
        const isMeneur = MENEUR_STARTERS.has(firstWord)

        if (isMeneur && !isName) {
          diarTexts.push({ text, start: meneurBlocks[i].start, end: meneurBlocks[i].end })
        } else {
          logger.info(`[Linguistic] Diar-rescue SKIP : ${meneurBlocks[i].start.toFixed(1)}s "${text.substring(0, 50)}" (${isName ? 'nom' : 'pas meneur'})`)
        }
      }

      // Ollama validation sur les candidats
      if (diarTexts.length > 0) {
        try {
          const ollamaModel = config.ollamaModel || 'qwen2.5:14b'
          const diarOllamaTexts = diarTexts.map((r, i) => `${i + 1}. "${r.text}"`).join('\n')
          const diarPrompt = `Tu analyses des phrases transcrites depuis un enregistrement audio. Un meneur dit des phrases en francais standard decrivant des objets, ustensiles ou actions du quotidien.

Pour chaque phrase, reponds "FR" si c'est du vrai francais coherent et comprehensible, ou "FAUX" si c'est du charabia, des mots inventes, ou des phrases sans sens clair.

${diarOllamaTexts}

Format strict, un par ligne : 1. FR ou 1. FAUX`

          const diarOllamaResp = await ollamaGenerate(ollamaModel, diarPrompt)
          const diarLines = diarOllamaResp.split('\n')
          for (const line of diarLines) {
            const match = line.match(/(\d+)\.\s*(FR|FAUX)/i)
            if (match) {
              const idx = parseInt(match[1]) - 1
              if (idx >= 0 && idx < diarTexts.length) {
                diarTexts[idx].ollamaOK = match[2].toUpperCase() === 'FR'
              }
            }
          }
        } catch {
          for (const d of diarTexts) d.ollamaOK = true
        }
      }

      // Ajouter les sequences rescuees
      for (const d of diarTexts) {
        if (d.ollamaOK === false) {
          logger.info(`[Linguistic] Diar-rescue Ollama FAUX : ${d.start.toFixed(1)}s "${d.text.substring(0, 60)}"`)
          continue
        }
        sequences.push({
          id: randomUUID(),
          index: 0,
          french_text: d.text,
          french_audio: { start: d.start, end: d.end },
          variants: []
        })
        totalDiarRescued++
        logger.info(`[Linguistic] Diar-rescue OK : ${d.start.toFixed(1)}s "${d.text.substring(0, 60)}"`)
      }
    }

    if (totalDiarRescued > 0) {
      // Re-trier, re-distribuer les variantes
      sequences.sort((a, b) => a.french_audio.start - b.french_audio.start)
      const allVarBlocks = classifiedBlocks.filter((b: any) =>
        !b.is_french && b.type !== 'name' && (b.end - b.start) >= 1.0
      ).sort((a: any, b: any) => a.start - b.start)
      for (const s of sequences) s.variants = []
      for (const block of allVarBlocks) {
        let target: LinguisticSequence | null = null
        for (let si = sequences.length - 1; si >= 0; si--) {
          if (sequences[si].french_audio.start < block.start) { target = sequences[si]; break }
        }
        if (target) {
          let speaker = 'LOCUTEUR'
          let aStart = block.start
          if (block.pair_id >= 0 && nameByPairId.has(block.pair_id)) {
            speaker = nameByPairId.get(block.pair_id)!
          } else if (block.type === 'unknown' && block.pair_id === -1 && (block.end - block.start) >= avgNameDuration + 1.0) {
            aStart = block.start + avgNameDuration
            const key = Math.round(block.start * 10)
            if (nameByBlockStart.has(key)) {
              const fn = nameByBlockStart.get(key)!.split(/\s+/)[0].toLowerCase()
              if (confirmedFirstNames.has(fn)) speaker = nameByBlockStart.get(key)!
            }
          }
          target.variants.push({ speaker, ipa: '', ipa_original: '', audio: { start: aStart, end: block.end } })
        }
      }
      sequences = sequences.filter(s => s.variants.length >= 1)
      sequences.forEach((s, i) => s.index = i)
      logger.info(`[Linguistic] Apres diar-rescue : ${sequences.length} sequences (+${totalDiarRescued}), ${sequences.reduce((s, q) => s + q.variants.length, 0)} variantes`)
    }
  }

  updateTaskProgress(task.id, 55, 'IPA')

  // ── Step 5 : Transcription phonétique IPA (Allosaurus) ──
  // Allosaurus est un reconnaisseur de phonèmes universel qui convertit
  // la parole en alphabet phonétique international (IPA).
  // On l'applique uniquement sur les variantes vernaculaires (pas le meneur FR).
  broadcastFn(userId, null, 'linguistic:progress', {
    taskId: task.id, step: 'phonetizing', progress: 0, message: 'Transcription phonetique (IPA)...'
  })

  // IPA sur toutes les variantes (les blocs "name" ne sont plus des variantes)
  const ipaSegments = sequences.flatMap((seq, si) =>
    seq.variants.map((v, vi) => ({ id: `${si}_${vi}`, start: v.audio.start, end: v.audio.end }))
  )

  if (ipaSegments.length > 0) {
    const ipaResults = await runPhonetize(audioPath, ipaSegments, (percent) => {
      broadcastFn(userId, null, 'linguistic:progress', {
        taskId: task.id, step: 'phonetizing', progress: percent, message: 'Transcription IPA...'
      })
      updateTaskProgress(task.id, 45 + percent * 0.30, 'IPA')
    })

    const ipaMap = new Map(ipaResults.map((r: any) => [r.id, r.ipa]))
    for (let si = 0; si < sequences.length; si++) {
      for (let vi = 0; vi < sequences[si].variants.length; vi++) {
        const ipa = ipaMap.get(`${si}_${vi}`) || ''
        sequences[si].variants[vi].ipa = ipa
        sequences[si].variants[vi].ipa_original = ipa
      }
    }
  }

  // ── Step 8 : Extraction des clips audio individuels ──
  // Pour chaque séquence, on extrait un fichier WAV séparé :
  // - Un clip pour la phrase du meneur en français
  // - Un clip pour chaque variante vernaculaire
  // Ces clips permettent à l'utilisateur de réécouter chaque segment isolément.
  const linguisticId = randomUUID()
  const clipDir = join(DATA_DIR, 'linguistic', linguisticId)
  mkdirSync(clipDir, { recursive: true })

  const ffmpegClip = (src: string, start: number, end: number, dest: string): Promise<void> =>
    new Promise((resolve) => {
      const { exec: execAsync } = require('child_process')
      execAsync(`ffmpeg -y -i "${src}" -ss ${start} -to ${end} -ar 16000 -ac 1 "${dest}" 2>/dev/null`, () => resolve())
    })

  const clipJobs: Array<() => Promise<void>> = []
  for (let si = 0; si < sequences.length; si++) {
    const seq = sequences[si]
    clipJobs.push(() => ffmpegClip(audioPath, seq.french_audio.start, seq.french_audio.end, join(clipDir, `seq_${si}_fr.wav`)))
    for (let vi = 0; vi < seq.variants.length; vi++) {
      const v = seq.variants[vi]
      const name = `seq_${si}_var_${vi}.wav`
      clipJobs.push(async () => { await ffmpegClip(audioPath, v.audio.start, v.audio.end, join(clipDir, name)); v.audio_extract = name })
    }
  }
  for (let i = 0; i < clipJobs.length; i += 5) {
    await Promise.all(clipJobs.slice(i, i + 5).map(fn => fn()))
  }

  updateTaskProgress(task.id, 90, 'Sauvegarde')

  // ── Step 9 : Sauvegarde en base de données ──
  // On enregistre toutes les séquences, les speakers identifiés, et la durée
  // dans la table linguistic_transcriptions. Si un projet est associé, on le met à jour.
  const speakers = [...new Set(sequences.flatMap(s => s.variants.map(v => v.speaker)))]
  const db = getDb()
  db.prepare(
    `INSERT INTO linguistic_transcriptions (id, user_id, task_id, filename, leader_speaker, sequences, speakers, duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(linguisticId, userId, task.id, filename, 'meneur',
    JSON.stringify(sequences), JSON.stringify(speakers), duration, new Date().toISOString())

  const projectId = config.projectId as string | undefined
  if (projectId) {
    const project = getProject(projectId)
    if (project) {
      saveProject(projectId, { ...project.data, linguisticId, sequenceCount: sequences.length })
      updateProjectStatus(projectId, 'done')
    }
  }

  logger.info(`[Linguistic] Termine : ${linguisticId}, ${sequences.length} sequences, ${duration.toFixed(1)}s`)

  broadcastFn(userId, null, 'linguistic:complete', {
    taskId: task.id, linguisticId, sequenceCount: sequences.length, duration, projectId, filename
  })

  return { linguisticId }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── HELPERS : Fonctions qui lancent les scripts Python en sous-processus ──
// Chaque helper :
// - Lance un script Python avec spawn()
// - Écoute stderr pour la progression (PROGRESS:XX)
// - Récupère le résultat via stdout (JSON) ou un fichier de sortie
// - Gère gracieusement les erreurs (retourne null au lieu de crash)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Lance le script lang-classify.py qui détecte si chaque bloc de parole
 * est en français ou en vernaculaire, en utilisant le modèle VoxLingua107.
 */
function runLangClassify(
  audioPath: string,
  blocks: Array<{ start: number; end: number }>,
  onProgress: (p: number) => void
): Promise<any[] | null> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'lang-classify.py')
    if (!existsSync(script)) { logger.error('lang-classify.py introuvable'); resolve(null); return }

    const ts = Date.now()
    const blocksPath = join(DATA_DIR, 'temp', `langblocks_${ts}.json`)
    const outPath = join(DATA_DIR, 'temp', `langresult_${ts}.json`)

    writeFileSync(blocksPath, JSON.stringify(blocks), 'utf-8')

    const proc = spawn('python3', [script, audioPath, '--blocks', blocksPath, '--output', outPath],
      { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''

    proc.stderr?.on('data', (d) => {
      for (const l of d.toString().split('\n')) {
        if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) }
        else if (l.startsWith('STATUS:')) logger.info('[LangClassify]', l.trim())
        else if (l.startsWith('ERROR:')) logger.error('[LangClassify]', l.trim())
      }
    })

    proc.stdout?.on('data', (d) => { stdout += d.toString() })

    proc.on('close', (code) => {
      try { unlinkSync(blocksPath) } catch {}
      try { execSync('sleep 2') } catch {}

      if (code === 0) {
        try { const r = JSON.parse(stdout.trim()); if (Array.isArray(r)) { resolve(r); return } } catch {}
        try {
          if (existsSync(outPath)) {
            const d = JSON.parse(readFileSync(outPath, 'utf-8'))
            try { unlinkSync(outPath) } catch {}
            resolve(d); return
          }
        } catch {}
      }
      logger.error(`[LangClassify] Code sortie ${code}`)
      resolve(null)
    })

    proc.on('error', () => resolve(null))
  })
}

/**
 * Lance silence-segment.py : détecte les silences dans l'audio avec FFmpeg,
 * puis découpe en blocs de parole et les regroupe en séquences.
 */
function runSilenceSegment(audioPath: string, onProgress: (p: number) => void): Promise<any | null> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'silence-segment.py')
    if (!existsSync(script)) { resolve(null); return }
    const out = join(DATA_DIR, 'temp', `silence_${Date.now()}.json`)
    const proc = spawn('python3', [script, audioPath, '--output', out, '--sequence-gap', '5.0'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stderr?.on('data', d => { for (const l of d.toString().split('\n')) { if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) } else if (l.startsWith('STATUS:')) logger.info('[SilenceSegment]', l.trim()) } })
    proc.stdout?.on('data', d => { stdout += d.toString() })
    proc.on('close', code => { if (code === 0) { try { resolve(JSON.parse(stdout.trim())); return } catch {} try { if (existsSync(out)) { resolve(JSON.parse(readFileSync(out, 'utf-8'))); return } } catch {} } resolve(null) })
    proc.on('error', () => resolve(null))
  })
}

function runWhisperX(audioPath: string, model: string, language: string, numSpeakers: number, onProgress: (p: number) => void): Promise<{ segments: any[]; speakers: string[] } | null> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'whisperx-diarize.py')
    if (!existsSync(script)) { resolve(null); return }
    const out = join(DATA_DIR, 'temp', `whisperx_${Date.now()}.json`)
    const hf = process.env.HF_TOKEN || ''
    const proc = spawn('python3', [script, audioPath, '--output', out, '--model', model, '--language', language, '--hf-token', hf, '--num-speakers', String(numSpeakers)], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stderr?.on('data', (d) => {
      for (const l of d.toString().split('\n')) {
        if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) }
        else if (l.startsWith('STATUS:')) logger.info('[WhisperX]', l.trim())
        else if (l.trim() && !l.includes('UserWarning') && !l.includes('FutureWarning')) logger.info('[WhisperX]', l.trim())
      }
    })
    proc.stdout?.on('data', d => { stdout += d.toString() })
    proc.on('close', code => { try { execSync('sleep 2') } catch {} if (code === 0) { try { const r = JSON.parse(stdout.trim()); if (r.segments) { resolve(r); return } } catch {} try { if (existsSync(out)) { resolve(JSON.parse(readFileSync(out, 'utf-8'))); return } } catch {} } resolve(null) })
    proc.on('error', () => resolve(null))
  })
}

/**
 * Lance phonetize.py : transcription phonétique IPA via Allosaurus.
 * Convertit chaque segment audio en sa représentation en alphabet phonétique international.
 */
function runPhonetize(audioPath: string, segments: { id: string; start: number; end: number }[], onProgress: (p: number) => void): Promise<any[]> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'scripts', 'phonetize.py')
    if (!existsSync(script)) { resolve(segments.map(s => ({ id: s.id, ipa: '' }))); return }
    const ts = Date.now()
    const segP = join(DATA_DIR, 'temp', `phon_in_${ts}.json`)
    const outP = join(DATA_DIR, 'temp', `phon_out_${ts}.json`)
    writeFileSync(segP, JSON.stringify(segments), 'utf-8')
    const proc = spawn('python3', [script, audioPath, '--segments', segP, '--output', outP], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stderr?.on('data', (d) => {
      for (const l of d.toString().split('\n')) {
        if (l.startsWith('PROGRESS:')) { const p = parseInt(l.replace('PROGRESS:', '').trim()); if (!isNaN(p)) onProgress(p) }
        else if (l.startsWith('ERROR:')) logger.error('[Phonetize]', l.replace('ERROR:', '').trim())
        else if (l.trim() && !l.includes('UserWarning')) logger.info('[Phonetize]', l.trim())
      }
    })
    proc.stdout?.on('data', d => { stdout += d.toString() })
    proc.on('close', code => { try { unlinkSync(segP) } catch {} try { execSync('sleep 2') } catch {} if (code === 0) { try { const r = JSON.parse(stdout.trim()); if (Array.isArray(r)) { resolve(r); return } } catch {} try { if (existsSync(outP)) { const d = JSON.parse(readFileSync(outP, 'utf-8')); try { unlinkSync(outP) } catch {} resolve(d); return } } catch {} } resolve(segments.map(s => ({ id: s.id, ipa: '' }))) })
    proc.on('error', () => resolve(segments.map(s => ({ id: s.id, ipa: '' }))))
  })
}

// ── Ollama : Helper pour appeler le LLM local ──
// Utilisé pour valider que les phrases rescuées sont bien du français
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama'
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434')

function ollamaGenerate(model: string, prompt: string): Promise<string> {
  const http = require('http')
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, prompt, stream: false })
    const req = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 180000
    }, (res: any) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data).response || '') }
        catch { reject(new Error('Reponse Ollama invalide')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')) })
    req.write(body)
    req.end()
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CRUD : Fonctions de lecture/écriture/suppression en base de données ──
// Ces fonctions sont appelées par les routes API dans server/index.ts
// ══════════════════════════════════════════════════════════════════════════════

/** Récupère une transcription linguistique par son ID (admin peut voir toutes) */
export function getLinguisticTranscription(id: string, userId: string, userRole?: string): any | null {
  const db = getDb()
  const row = userRole === 'admin'
    ? db.prepare('SELECT * FROM linguistic_transcriptions WHERE id = ?').get(id) as any
    : db.prepare('SELECT * FROM linguistic_transcriptions WHERE id = ? AND user_id = ?').get(id, userId) as any
  if (!row) return null
  return { ...row, sequences: JSON.parse(row.sequences), speakers: JSON.parse(row.speakers) }
}

/** Liste l'historique des transcriptions linguistiques d'un utilisateur */
export function getLinguisticHistory(userId: string, limit: number = 20): any[] {
  const db = getDb()
  return db.prepare('SELECT id, filename, leader_speaker, duration, created_at FROM linguistic_transcriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as any[]
}

/** Supprime une transcription linguistique + ses fichiers audio clips */
export function deleteLinguisticTranscription(id: string, userId: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM linguistic_transcriptions WHERE id = ? AND user_id = ?').run(id, userId)
  try { execSync(`rm -rf "${join(DATA_DIR, 'linguistic', id)}"`) } catch {}
  return result.changes > 0
}

/** Met à jour le texte français ou l'IPA d'une variante dans une séquence */
export function updateLinguisticSequence(id: string, seqIdx: number, updates: any): any | null {
  const db = getDb()
  const row = db.prepare('SELECT sequences FROM linguistic_transcriptions WHERE id = ?').get(id) as any
  if (!row) return null
  const sequences = JSON.parse(row.sequences)
  if (seqIdx < 0 || seqIdx >= sequences.length) return null
  if (updates.french_text !== undefined) sequences[seqIdx].french_text = updates.french_text
  if (updates.variant_idx !== undefined && updates.ipa !== undefined) {
    const vi = updates.variant_idx
    if (vi >= 0 && vi < sequences[seqIdx].variants.length) sequences[seqIdx].variants[vi].ipa = updates.ipa
  }
  db.prepare('UPDATE linguistic_transcriptions SET sequences = ? WHERE id = ?').run(JSON.stringify(sequences), id)
  return sequences
}

/** Change le nom du meneur (leader) dans une transcription */
export function updateLinguisticLeader(id: string, newLeader: string): any | null {
  getDb().prepare('UPDATE linguistic_transcriptions SET leader_speaker = ? WHERE id = ?').run(newLeader, id)
  return { success: true }
}

/** Renomme un locuteur partout dans les séquences, speakers et leader */
export function renameLinguisticSpeaker(id: string, oldName: string, newName: string): any | null {
  const db = getDb()
  const row = db.prepare('SELECT sequences, speakers, leader_speaker FROM linguistic_transcriptions WHERE id = ?').get(id) as any
  if (!row) return null
  let sequences = JSON.parse(row.sequences)
  let speakers = JSON.parse(row.speakers)
  let leader = row.leader_speaker
  for (const seq of sequences) { for (const v of seq.variants) { if (v.speaker === oldName) v.speaker = newName } }
  speakers = speakers.map((s: string) => s === oldName ? newName : s)
  if (leader === oldName) leader = newName
  db.prepare('UPDATE linguistic_transcriptions SET sequences = ?, speakers = ?, leader_speaker = ? WHERE id = ?')
    .run(JSON.stringify(sequences), JSON.stringify(speakers), leader, id)
  return { sequences, speakers, leader_speaker: leader }
}

/** Exporte une transcription en JSON ou CSV (avec séparateur point-virgule) */
export function exportLinguistic(id: string, format: string = 'json'): { content: string; mime: string; ext: string } {
  const db = getDb()
  const row = db.prepare('SELECT * FROM linguistic_transcriptions WHERE id = ?').get(id) as any
  if (!row) throw new Error('Transcription introuvable')
  const sequences = JSON.parse(row.sequences) as LinguisticSequence[]
  if (format === 'csv') {
    const lines = ['Sequence;Francais;Locuteur;IPA;Debut;Fin']
    for (const seq of sequences) { for (const v of seq.variants) { lines.push(`${seq.index + 1};"${seq.french_text}";"${v.speaker}";"${v.ipa}";${v.audio.start};${v.audio.end}`) } }
    return { content: lines.join('\n'), mime: 'text/csv; charset=utf-8', ext: 'csv' }
  }
  return { content: JSON.stringify({ filename: row.filename, leader: row.leader_speaker, sequences }, null, 2), mime: 'application/json; charset=utf-8', ext: 'json' }
}

/**
 * ANALYSIS-PIPELINE.TS : Pipeline d'analyse IA en arrière-plan
 *
 * Ce fichier orchestre tout le processus d'analyse d'une vidéo, étape par étape :
 *   1. Extraction de l'audio depuis les fichiers vidéo (via FFmpeg)
 *   2. Transcription de l'audio en texte (via Whisper, un modèle de reconnaissance vocale)
 *   3. Analyse sémantique du texte transcrit (via Ollama, un LLM local)
 *   4. Sauvegarde des résultats dans le projet
 *
 * C'est le "chef d'orchestre" qui appelle les autres services dans le bon ordre
 * et informe le client (navigateur) de la progression en temps réel via une
 * fonction de broadcast (WebSocket).
 */

// --- Imports des services utilisés par le pipeline ---

// Service FFmpeg : permet d'extraire l'audio d'une vidéo
import * as ffmpegService from './ffmpeg.js'

// Service Whisper : permet de transcrire l'audio en texte avec horodatage
import * as whisperService from './whisper.js'

// Service Ollama : permet d'analyser le texte avec un modèle de langage (IA)
import * as ollamaService from './ollama.js'

// Service de diarisation : identification des locuteurs (qui parle quand)
import * as diarizationService from './diarization.js'

// Service de gestion de projets : lecture, écriture, mise à jour du statut des projets
import * as projectService from './project-history.js'

// Fonction pour mettre à jour la progression d'une tâche dans la file d'attente
import { updateTaskProgress } from './task-queue.js'

// Logger : utilitaire pour écrire des messages dans les logs du serveur
import { logger } from '../logger.js'

// Type TypeScript représentant une tâche dans la file d'attente
import type { QueueTask } from './task-queue.js'

/**
 * Type de la fonction de broadcast.
 * Elle envoie un message en temps réel au client (navigateur) via WebSocket.
 * - userId : identifiant de l'utilisateur concerné
 * - projectId : identifiant du projet (peut être null)
 * - type : type d'événement (ex: 'progress', 'analysis:complete', 'analysis:error')
 * - data : données associées à l'événement (progression, résultats, etc.)
 */
type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void

/**
 * Fonction principale du pipeline d'analyse.
 * Elle est appelée quand une tâche d'analyse est déclenchée depuis la file d'attente.
 *
 * Le processus complet :
 *   1. Extraire l'audio de chaque vidéo du projet
 *   2. Transcrire chaque piste audio en segments de texte horodatés
 *   3. Envoyer tout le texte à un LLM (Ollama) pour découper en thèmes
 *   4. Sauvegarder les résultats et notifier le client
 *
 * @param task - La tâche de la file d'attente contenant les infos du projet et la config
 * @param broadcastFn - Fonction pour envoyer des mises à jour en temps réel au client
 */
export async function runAnalysisPipeline(task: QueueTask, broadcastFn: BroadcastFn): Promise<void> {
  // On extrait les informations essentielles de la tâche
  const { project_id: projectId, user_id: userId, config: taskConfig } = task

  // Vérification : on a besoin d'un identifiant de projet pour continuer
  if (!projectId) throw new Error('project_id requis pour une analyse')

  // Récupération du projet depuis la base de données / le stockage
  const project = projectService.getProject(projectId)
  if (!project) throw new Error('Projet introuvable: ' + projectId)

  // "data" contient toutes les données du projet (vidéos, transcriptions, etc.)
  const data = project.data
  // "config" contient les paramètres choisis par l'utilisateur (modèle Whisper, langue, etc.)
  const config = taskConfig

  // On récupère la liste des fichiers vidéo du projet
  const videoFiles = data.videoFiles
  if (!videoFiles || videoFiles.length === 0) throw new Error('Aucune vidéo dans le projet')

  // --- Paramètres de configuration avec valeurs par défaut ---
  // Modèle Whisper à utiliser pour la transcription (par défaut : le plus précis)
  const whisperModel = config?.whisperModel || 'large-v3'
  // Prompt optionnel pour guider Whisper (noms propres, vocabulaire spécifique, etc.)
  const whisperPrompt = config?.whisperPrompt || ''
  // Modèle Ollama (LLM) pour l'analyse sémantique
  const ollamaModel = config?.ollamaModel || 'qwen2.5:14b'
  // Langue de la vidéo (par défaut : français)
  const language = config?.language || 'fr'
  // Contexte supplémentaire donné par l'utilisateur pour aider l'IA
  const context = config?.context || ''

  // On met à jour le statut du projet à "en cours de traitement"
  projectService.updateProjectStatus(projectId, 'processing')

  try {
    // ============================================================
    // ÉTAPE 1 : Extraction audio
    // On extrait la piste audio de chaque fichier vidéo.
    // Le résultat est un fichier WAV par vidéo, stocké temporairement.
    // ============================================================
    broadcastFn(userId, projectId, 'progress', { step: 'extracting-audio', progress: 0, message: 'Extraction des pistes audio...' })
    const audioPaths: string[] = []

    for (let i = 0; i < videoFiles.length; i++) {
      // extractAudio convertit la vidéo en fichier audio WAV
      // Le callback reçoit le pourcentage de progression de FFmpeg
      const audioPath = await ffmpegService.extractAudio(videoFiles[i].path, (percent) => {
        // Calcul de la progression globale : on tient compte du nombre de vidéos
        const progress = ((i + percent / 100) / videoFiles.length) * 100
        // On notifie le client de l'avancement
        broadcastFn(userId, projectId, 'progress', {
          step: 'extracting-audio',
          progress,
          message: `Extraction audio ${i + 1}/${videoFiles.length}...`
        })
        // On met aussi à jour la tâche dans la file d'attente
        // L'extraction audio représente 10% du travail total (0 à 10%)
        updateTaskProgress(task.id, progress * 0.10, `Extraction audio ${i + 1}/${videoFiles.length}`)
      })
      audioPaths.push(audioPath)
    }

    // Sauvegarde intermédiaire : on enregistre les chemins audio dans le projet
    // Cela permet de reprendre plus tard sans refaire l'extraction
    projectService.saveProject(projectId, { ...data, audioPaths, config })

    // ============================================================
    // ÉTAPE 2 : Transcription avec Whisper
    // Chaque fichier audio est envoyé à Whisper qui le convertit en
    // segments de texte horodatés (ex: "[12.5s] Bonjour et bienvenue")
    // ============================================================
    broadcastFn(userId, projectId, 'progress', { step: 'transcribing', progress: 0, message: 'Transcription de la voix...' })

    // On charge le modèle Whisper en mémoire (si pas déjà fait)
    await whisperService.loadWhisperModel(whisperModel)
    // Tableau qui contiendra tous les segments de transcription de toutes les vidéos
    const allTranscriptSegments: any[] = []

    for (let i = 0; i < audioPaths.length; i++) {
      // Notification de progression au client
      broadcastFn(userId, projectId, 'progress', {
        step: 'transcribing',
        progress: (i / audioPaths.length) * 100,
        message: `Transcription video ${i + 1}/${audioPaths.length}...`
      })

      // Lancement de la transcription pour un fichier audio
      const segments = await whisperService.transcribe(
        audioPaths[i], // Chemin du fichier audio
        language,       // Langue de la vidéo
        // Callback appelé pour chaque segment transcrit en temps réel
        (segment) => {
          // "offset" : décalage temporel de cette vidéo dans le projet
          // (utile quand on a plusieurs vidéos qui se suivent)
          const offset = videoFiles[i]?.offset || 0
          // On ajuste les timestamps du segment avec le décalage
          const adjusted = { ...segment, start: segment.start + offset, end: segment.end + offset }
          // On envoie le segment en temps réel au client pour affichage immédiat
          broadcastFn(userId, projectId, 'transcript:segment', adjusted)
        },
        // Callback de progression
        (percent) => {
          const progress = ((i + percent / 100) / audioPaths.length) * 100
          broadcastFn(userId, projectId, 'progress', {
            step: 'transcribing',
            progress,
            message: `Transcription video ${i + 1}/${audioPaths.length}...`
          })
          // La transcription représente 40% du travail total (10% à 50%)
          updateTaskProgress(task.id, 10 + progress * 0.4, `Transcription ${i + 1}/${audioPaths.length}`)
        },
        whisperPrompt // Prompt optionnel pour améliorer la reconnaissance
      )

      // On ajuste les timestamps de tous les segments avec le décalage temporel
      const offset = videoFiles[i]?.offset || 0
      const adjusted = segments.map((seg: any) => ({
        ...seg, start: seg.start + offset, end: seg.end + offset
      }))
      // On ajoute les segments ajustés au tableau global
      allTranscriptSegments.push(...adjusted)
    }

    // Sauvegarde intermédiaire avec la transcription complète
    projectService.saveProject(projectId, { ...data, audioPaths, transcript: allTranscriptSegments, config })

    // ============================================================
    // ÉTAPE 2.5 : Diarisation (identification des locuteurs)
    // On utilise SpeechBrain pour détecter qui parle à quel moment,
    // puis Ollama pour deviner les prénoms des interlocuteurs.
    // Cette étape est optionnelle : si elle échoue, le pipeline continue.
    // ============================================================
    if (allTranscriptSegments.length >= 2) {
      try {
        broadcastFn(userId, projectId, 'progress', {
          step: 'diarizing',
          progress: 0,
          message: 'Identification des locuteurs...'
        })

        // On diarise chaque audio séparément (support multi-vidéo)
        for (let i = 0; i < audioPaths.length; i++) {
          // On récupère les segments qui correspondent à cette vidéo
          const offset = videoFiles[i]?.offset || 0
          const nextOffset = i < videoFiles.length - 1 ? (videoFiles[i + 1]?.offset || Infinity) : Infinity
          const videoSegments = allTranscriptSegments.filter(
            (s: any) => s.start >= offset && s.start < nextOffset
          )

          if (videoSegments.length < 2) continue

          // Diarisation avec SpeechBrain (détection des locuteurs)
          const diarized = await diarizationService.diarize(
            audioPaths[i],
            // On passe les segments avec timestamps locaux (sans offset)
            videoSegments.map((s: any) => ({ ...s, start: s.start - offset, end: s.end - offset })),
            (percent) => {
              const progress = ((i + percent / 100) / audioPaths.length) * 100
              broadcastFn(userId, projectId, 'progress', {
                step: 'diarizing',
                progress,
                message: `Identification des locuteurs (video ${i + 1}/${audioPaths.length})...`
              })
              updateTaskProgress(task.id, 50 + progress * 0.1, `Diarisation ${i + 1}/${audioPaths.length}`)
            }
          )

          // On copie les labels de locuteur dans les segments originaux
          for (let j = 0; j < videoSegments.length && j < diarized.length; j++) {
            if (diarized[j].speaker) {
              // Retrouver le segment dans le tableau global et ajouter le speaker
              const globalSeg = allTranscriptSegments.find((s: any) => s.id === videoSegments[j].id)
              if (globalSeg) globalSeg.speaker = diarized[j].speaker
            }
          }
        }

        // Identification des prénoms via Ollama (analyse des premières minutes)
        broadcastFn(userId, projectId, 'progress', {
          step: 'identifying-speakers',
          progress: 0,
          message: 'Detection des noms des interlocuteurs...'
        })

        const nameMapping = await diarizationService.identifySpeakerNames(allTranscriptSegments, ollamaModel)
        diarizationService.applySpeakerNames(allTranscriptSegments, nameMapping)

        logger.info(`[Analysis] Diarization complete: ${Object.values(nameMapping).join(', ')}`)

        // Sauvegarde intermédiaire avec les labels de locuteurs
        projectService.saveProject(projectId, { ...data, audioPaths, transcript: allTranscriptSegments, config })

      } catch (err: any) {
        // La diarisation est optionnelle : si elle échoue, on continue le pipeline
        logger.warn('[Analysis] Diarization failed, continuing without speaker labels:', err.message)
      }
    }

    // ============================================================
    // ÉTAPE 3 : Analyse thématique avec le LLM (Ollama)
    // On envoie toute la transcription horodatée au modèle de langage
    // qui va découper le contenu en segments thématiques (chapitres).
    // ============================================================
    broadcastFn(userId, projectId, 'progress', { step: 'analyzing', progress: 0, message: 'Découpe intelligente par l\'IA...' })

    // On construit le texte complet de la transcription avec les timestamps
    // Format : "[12.5s] texte du segment"
    const fullText = allTranscriptSegments
      .map((t: any) => `[${t.start.toFixed(1)}s] ${t.text}`)
      .join('\n')

    // Appel au service Ollama pour analyser la transcription
    // Le callback reçoit : index du chunk, total des chunks, nb segments trouvés, message
    const result = await ollamaService.analyzeTranscript(fullText, context, ollamaModel, (ci, tc, _sf, msg) => {
      const progress = (ci / tc) * 100
      broadcastFn(userId, projectId, 'progress', {
        step: 'analyzing',
        progress,
        message: msg || 'Analyse thématique...'
      })
      // L'analyse représente 35% du travail total (65% à 100%)
      // (extraction=10%, transcription=40%, diarisation=15%, analyse=35%)
      updateTaskProgress(task.id, 65 + progress * 0.35, msg || 'Analyse thématique')
    })

    // On enrichit chaque segment retourné par l'IA avec des propriétés supplémentaires
    // nécessaires à l'interface utilisateur (id unique, couleur, etc.)
    const finalSegments = (result?.segments || []).map((s: any) => ({
      ...s,
      id: Math.random().toString(36).substring(2, 11), // Génère un identifiant unique aléatoire
      transcriptSegments: [], // Sera rempli côté client
      color: '' // Couleur du segment dans l'interface (attribuée côté client)
    }))

    // ============================================================
    // ÉTAPE 4 : Sauvegarde finale et notification
    // On enregistre tous les résultats dans le projet et on informe
    // le client que l'analyse est terminée.
    // ============================================================
    const finalData = {
      ...data,
      audioPaths,
      transcript: allTranscriptSegments,
      segments: finalSegments,
      config,
      projectName: data.projectName || project.name
    }

    // Sauvegarde des données finales dans la base
    projectService.saveProject(projectId, finalData)
    // Mise à jour du statut du projet : "terminé"
    projectService.updateProjectStatus(projectId, 'done')

    // Notification au client : l'analyse est complète, on envoie les résultats
    broadcastFn(userId, projectId, 'analysis:complete', {
      step: 'done',
      progress: 100,
      message: 'Analyse terminée !',
      segments: finalSegments,
      transcript: allTranscriptSegments,
      audioPaths
    })

    logger.info(`[Analysis] Project ${projectId} completed: ${finalSegments.length} segments`)

  } catch (err: any) {
    // En cas d'erreur à n'importe quelle étape du pipeline :
    logger.error(`[Analysis] Project ${projectId} failed:`, err)

    // On remet le projet en statut "brouillon" pour que l'utilisateur puisse relancer
    projectService.updateProjectStatus(projectId, 'draft')

    // On notifie le client de l'échec avec le message d'erreur
    broadcastFn(userId, projectId, 'analysis:error', {
      step: 'error',
      progress: 0,
      message: `Échec: ${err.message}`
    })

    // On relance l'erreur pour que la file d'attente marque la tâche comme échouée
    throw err
  }
}

/**
 * ANALYSIS-PIPELINE.TS : Pipeline d'analyse IA en arrière-plan
 *
 * Extrait du code inline de server/index.ts. Exécute le workflow complet :
 * extraction audio → transcription Whisper → analyse sémantique Ollama → sauvegarde.
 */

import * as ffmpegService from './ffmpeg.js'
import * as whisperService from './whisper.js'
import * as ollamaService from './ollama.js'
import * as projectService from './project-history.js'
import { updateTaskProgress } from './task-queue.js'
import { logger } from '../logger.js'

import type { QueueTask } from './task-queue.js'

type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void

export async function runAnalysisPipeline(task: QueueTask, broadcastFn: BroadcastFn): Promise<void> {
  const { project_id: projectId, user_id: userId, config: taskConfig } = task
  if (!projectId) throw new Error('project_id requis pour une analyse')

  const project = projectService.getProject(projectId)
  if (!project) throw new Error('Projet introuvable: ' + projectId)

  const data = project.data
  const config = taskConfig

  const videoFiles = data.videoFiles
  if (!videoFiles || videoFiles.length === 0) throw new Error('Aucune vidéo dans le projet')

  const whisperModel = config?.whisperModel || 'large-v3'
  const whisperPrompt = config?.whisperPrompt || ''
  const ollamaModel = config?.ollamaModel || 'mistral-small:22b'
  const language = config?.language || 'fr'
  const context = config?.context || ''

  // Mark project as processing
  projectService.updateProjectStatus(projectId, 'processing')

  try {
    // 1. Extract audio
    broadcastFn(userId, projectId, 'progress', { step: 'extracting-audio', progress: 0, message: 'Extraction des pistes audio...' })
    const audioPaths: string[] = []

    for (let i = 0; i < videoFiles.length; i++) {
      const audioPath = await ffmpegService.extractAudio(videoFiles[i].path, (percent) => {
        const progress = ((i + percent / 100) / videoFiles.length) * 100
        broadcastFn(userId, projectId, 'progress', {
          step: 'extracting-audio',
          progress,
          message: `Extraction audio ${i + 1}/${videoFiles.length}...`
        })
        updateTaskProgress(task.id, progress * 0.15, `Extraction audio ${i + 1}/${videoFiles.length}`)
      })
      audioPaths.push(audioPath)
    }

    // Auto-save audio paths
    projectService.saveProject(projectId, { ...data, audioPaths, config })

    // 2. Transcribe
    broadcastFn(userId, projectId, 'progress', { step: 'transcribing', progress: 0, message: 'Transcription de la voix...' })

    await whisperService.loadWhisperModel(whisperModel)
    const allTranscriptSegments: any[] = []

    for (let i = 0; i < audioPaths.length; i++) {
      broadcastFn(userId, projectId, 'progress', {
        step: 'transcribing',
        progress: (i / audioPaths.length) * 100,
        message: `Transcription video ${i + 1}/${audioPaths.length}...`
      })

      const segments = await whisperService.transcribe(
        audioPaths[i], language,
        (segment) => {
          const offset = videoFiles[i]?.offset || 0
          const adjusted = { ...segment, start: segment.start + offset, end: segment.end + offset }
          broadcastFn(userId, projectId, 'transcript:segment', adjusted)
        },
        (percent) => {
          const progress = ((i + percent / 100) / audioPaths.length) * 100
          broadcastFn(userId, projectId, 'progress', {
            step: 'transcribing',
            progress,
            message: `Transcription video ${i + 1}/${audioPaths.length}...`
          })
          updateTaskProgress(task.id, 15 + progress * 0.5, `Transcription ${i + 1}/${audioPaths.length}`)
        },
        whisperPrompt
      )

      const offset = videoFiles[i]?.offset || 0
      const adjusted = segments.map((seg: any) => ({
        ...seg, start: seg.start + offset, end: seg.end + offset
      }))
      allTranscriptSegments.push(...adjusted)
    }

    // Auto-save transcript
    projectService.saveProject(projectId, { ...data, audioPaths, transcript: allTranscriptSegments, config })

    // 3. Analyze with LLM
    broadcastFn(userId, projectId, 'progress', { step: 'analyzing', progress: 0, message: 'Découpe intelligente par l\'IA...' })

    const fullText = allTranscriptSegments
      .map((t: any) => `[${t.start.toFixed(1)}s] ${t.text}`)
      .join('\n')

    const result = await ollamaService.analyzeTranscript(fullText, context, ollamaModel, (ci, tc, _sf, msg) => {
      const progress = (ci / tc) * 100
      broadcastFn(userId, projectId, 'progress', {
        step: 'analyzing',
        progress,
        message: msg || 'Analyse thématique...'
      })
      updateTaskProgress(task.id, 65 + progress * 0.35, msg || 'Analyse thématique')
    })

    const finalSegments = (result?.segments || []).map((s: any) => ({
      ...s,
      id: Math.random().toString(36).substring(2, 11),
      transcriptSegments: [],
      color: ''
    }))

    // 4. Save final results to DB
    const finalData = {
      ...data,
      audioPaths,
      transcript: allTranscriptSegments,
      segments: finalSegments,
      config,
      projectName: data.projectName || project.name
    }

    projectService.saveProject(projectId, finalData)
    projectService.updateProjectStatus(projectId, 'done')

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
    logger.error(`[Analysis] Project ${projectId} failed:`, err)
    projectService.updateProjectStatus(projectId, 'draft')

    broadcastFn(userId, projectId, 'analysis:error', {
      step: 'error',
      progress: 0,
      message: `Échec: ${err.message}`
    })

    throw err // Re-throw so queue marks as failed
  }
}

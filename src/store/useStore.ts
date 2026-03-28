import { create } from 'zustand'
import { VideoFile, VideoSegment, TranscriptSegment, ProcessingStep, AppConfig, VideoClip } from '../types'
import api from '../api'

/**
 * USESTORE.TS : Gestion de l'état global (Store Zustand)
 * 
 * Centralise l'état réactif de l'application : gestion des fichiers vidéo,
 * stockage des transcriptions Whisper, configuration des modèles et suivi
 * du workflow de traitement. Permet une synchronisation inter-composants fluide.
 */

interface AppState {
  // Videos (support multi-vidéos)
  videoFiles: VideoFile[]
  addVideoFile: (file: Omit<VideoFile, 'offset'>) => void
  removeVideoFile: (index: number) => void
  clearVideoFiles: () => void
  getTotalDuration: () => number

  // Transcription
  transcript: TranscriptSegment[]
  addTranscriptSegment: (segment: TranscriptSegment) => void
  setTranscript: (segments: TranscriptSegment[]) => void
  clearTranscript: () => void

  // Segments (découpes)
  segments: VideoSegment[]
  setSegments: (segments: VideoSegment[]) => void
  updateSegment: (id: string, updates: Partial<VideoSegment>) => void
  removeSegment: (id: string) => void
  addSegment: (segment: VideoSegment) => void
  reorderSegments: (segments: VideoSegment[]) => void

  // État du processus de traitement (workflows asynchrones)
  processingStep: ProcessingStep
  progress: number
  progressMessage: string
  setProcessing: (step: ProcessingStep, progress?: number, message?: string) => void

  // Configuration de l'application (IA, Qualité, Chemins)
  config: AppConfig
  updateConfig: (updates: Partial<AppConfig>) => void

  // Chemins audio (Fichiers temporaires générés pour chaque vidéo)
  audioPaths: string[]
  setAudioPaths: (paths: string[]) => void
  setAudioPath: (path: string | null) => void

  // État de l'interface utilisateur (Sélections)
  selectedSegmentId: string | null
  setSelectedSegmentId: (id: string | null) => void
  currentVideoIndex: number
  setCurrentVideoIndex: (index: number) => void
  isPlaying: boolean
  setIsPlaying: (playing: boolean) => void

  // Méthodes utilitaires pour la gestion multi-vidéos sur une timeline unifiée
  getVideoAtTime: (globalTime: number) => { video: VideoFile; localTime: number; index: number } | null
  getClipsForSegment: (start: number, end: number) => VideoClip[]

  // Nouveaux getters pour compatibilité (basés sur le premier élément)
  videoFile: VideoFile | null
  audioPath: string | null

  // Actions métier
  triggerAnalysis: () => Promise<void>

  // Réinitialisation complète de l'application
  reset: () => void

  // Gestion de Projet & Historique
  history: any[]
  loadHistory: () => Promise<void>
  saveProject: () => Promise<void>
  loadProject: () => Promise<void>
  loadFromHistory: (projectData: any) => void
  autoSave: () => Promise<void>
}

const defaultConfig: AppConfig = {
  whisperModel: 'medium',
  ollamaModel: 'qwen2.5:3b',
  language: 'fr',
  outputQuality: 23,
  outputFolder: null,
  context: ''
}

const SEGMENT_COLORS = [
  '#3b82f6', // Bleu
  '#10b981', // Vert
  '#f59e0b', // Ambre
  '#ef4444', // Rouge
  '#8b5cf6', // Violet
  '#ec4899', // Rose
  '#06b6d4', // Cyan
  '#84cc16', // Lime
]

export const useStore = create<AppState>((set, get) => ({
  // --- Gestion de la collection de fichiers vidéo ---
  videoFiles: [],

  addVideoFile: (file) => {
    const current = get().videoFiles
    // Calcul de l'offset global du nouveau fichier basé sur la durée cumulée des fichiers existants
    const offset = current.reduce((sum, v) => sum + v.duration, 0)
    const newFile: VideoFile = { ...file, offset }
    const newFiles = [...current, newFile]
    set({
      videoFiles: newFiles,
      videoFile: newFiles.length > 0 ? newFiles[0] : null,
      currentVideoIndex: 0
    })
  },

  removeVideoFile: (index) => {
    const current = get().videoFiles
    const newFiles = current.filter((_, i) => i !== index)
    // Recalcul des offsets globaux pour maintenir une timeline cohérente après suppression
    let offset = 0
    const withOffsets = newFiles.map((f) => {
      const updated = { ...f, offset }
      offset += f.duration
      return updated
    })
    set({
      videoFiles: withOffsets,
      videoFile: withOffsets.length > 0 ? withOffsets[0] : null,
      currentVideoIndex: 0
    })
  },

  clearVideoFiles: () => set({ videoFiles: [], videoFile: null }),

  getTotalDuration: () => {
    const files = get().videoFiles
    return files.reduce((sum, v) => sum + v.duration, 0)
  },

  // --- Fin Gestion de la collection ---

  // --- Stockage de la Transcription (Segments audio fins) ---
  transcript: [],
  addTranscriptSegment: (segment) =>
    set((state) => ({ transcript: [...state.transcript, segment] })),
  setTranscript: (segments) => set({ transcript: segments }),
  clearTranscript: () => set({ transcript: [] }),

  // --- Gestion des Segments Thématiques (Découpages logiques) ---
  segments: [],
  setSegments: (segments) =>
    set({
      segments: segments.map((s, i) => ({
        ...s,
        color: s.color || SEGMENT_COLORS[i % SEGMENT_COLORS.length]
      }))
    }),
  updateSegment: (id, updates) =>
    set((state) => ({
      segments: state.segments.map((s) => (s.id === id ? { ...s, ...updates } : s))
    })),
  removeSegment: (id) =>
    set((state) => ({
      segments: state.segments.filter((s) => s.id !== id),
      selectedSegmentId: state.selectedSegmentId === id ? null : state.selectedSegmentId
    })),
  addSegment: (segment) =>
    set((state) => ({
      segments: [
        ...state.segments,
        { ...segment, color: SEGMENT_COLORS[state.segments.length % SEGMENT_COLORS.length] }
      ]
    })),
  reorderSegments: (segments) => set({ segments }),

  // --- Suivi de la Progression du Traitement ---
  processingStep: 'idle',
  progress: 0,
  progressMessage: '',
  setProcessing: (step, progress = 0, message = '') =>
    set({ processingStep: step, progress, progressMessage: message }),

  // --- Configuration et Préférences ---
  config: defaultConfig,
  updateConfig: (updates) =>
    set((state) => ({ config: { ...state.config, ...updates } })),

  // --- Gestion des Chemins Audio ---
  audioPaths: [],
  setAudioPaths: (paths) => set({
    audioPaths: paths,
    audioPath: paths.length > 0 ? paths[0] : null
  }),
  setAudioPath: (path) => {
    set({
      audioPaths: path ? [path] : [],
      audioPath: path,
      currentVideoIndex: 0
    })
  },

  // Nouvelles propriétés pour compatibilité
  videoFile: null,
  audioPath: null,

  // --- État de l'Interface Utilisateur ---
  selectedSegmentId: null,
  setSelectedSegmentId: (id) => {
    const state = get()
    if (id) {
      const segment = state.segments.find(s => s.id === id)
      if (segment) {
        const videoInfo = state.getVideoAtTime(segment.start)
        if (videoInfo) {
          set({
            selectedSegmentId: id,
            currentVideoIndex: videoInfo.index,
            videoFile: state.videoFiles[videoInfo.index] || null,
            audioPath: state.audioPaths[videoInfo.index] || null
          })
          return
        }
      }
    }
    set({ selectedSegmentId: id })
  },
  currentVideoIndex: 0,
  setCurrentVideoIndex: (index) => {
    const state = get()
    set({
      currentVideoIndex: index,
      videoFile: state.videoFiles[index] || null,
      audioPath: state.audioPaths[index] || null
    })
  },
  isPlaying: false,
  setIsPlaying: (playing) => set({ isPlaying: playing }),

  /**
   * Identifie quelle vidéo appartient à un point temporel donné sur la timeline cumulée.
   */
  getVideoAtTime: (globalTime) => {
    const files = get().videoFiles
    for (let i = 0; i < files.length; i++) {
      const video = files[i]
      if (globalTime >= video.offset && globalTime < video.offset + video.duration) {
        return {
          video,
          localTime: globalTime - video.offset,
          index: i
        }
      }
    }
    // Cas limite : retourne la dernière vidéo si on dépasse la durée totale
    if (files.length > 0) {
      const last = files[files.length - 1]
      return {
        video: last,
        localTime: last.duration,
        index: files.length - 1
      }
    }
    return null
  },

  /**
   * Calcule les sous-découpes (clips) nécessaires pour un segment thématique,
   * car un segment peut s'étendre sur plusieurs fichiers vidéo physiques.
   */
  getClipsForSegment: (start, end) => {
    const files = get().videoFiles
    const clips: VideoClip[] = []

    for (let i = 0; i < files.length; i++) {
      const video = files[i]
      const videoStart = video.offset
      const videoEnd = video.offset + video.duration

      // Le segment chevauche cette vidéo ?
      if (start < videoEnd && end > videoStart) {
        const clipStart = Math.max(0, start - videoStart)
        const clipEnd = Math.min(video.duration, end - videoStart)

        clips.push({
          videoIndex: i,
          videoPath: video.path,
          start: clipStart,
          end: clipEnd
        })
      }
    }

    return clips
  },

  /**
   * Coordonne le workflow complet d'analyse IA :
   * 1. Extraction Audio FFmpeg
   * 2. Transcription Whisper
   * 3. Analyse Sémantique Ollama
   */
  triggerAnalysis: async () => {
    const state = get()
    if (state.videoFiles.length === 0) return

    try {
      state.setProcessing('extracting-audio', 0, 'Extraction des pistes audio...')
      const newAudioPaths: string[] = []

      for (let i = 0; i < state.videoFiles.length; i++) {
        const path = await api.extractAudio(state.videoFiles[i].path)
        newAudioPaths.push(path)
        state.setProcessing('extracting-audio', ((i + 1) / state.videoFiles.length) * 100, `Audio ${i + 1}/${state.videoFiles.length} extrait`)
      }

      state.setAudioPaths(newAudioPaths)

      // Transcription de TOUTES les vidéos avec ajustement des timestamps
      state.setProcessing('transcribing', 0, 'Transcription de la voix...')
      state.clearTranscript()

      const allTranscriptSegments: any[] = []

      for (let i = 0; i < newAudioPaths.length; i++) {
        state.setProcessing(
          'transcribing',
          (i / newAudioPaths.length) * 100,
          `Transcription vidéo ${i + 1}/${newAudioPaths.length}...`
        )

        const segments = await api.transcribe(newAudioPaths[i], state.config.language, state.config.whisperModel) as any[]
        const offset = state.videoFiles[i]?.offset || 0

        // Ajuster les timestamps avec l'offset global de la vidéo
        const adjustedSegments = segments.map((seg: any) => ({
          ...seg,
          start: seg.start + offset,
          end: seg.end + offset
        }))

        allTranscriptSegments.push(...adjustedSegments)
      }

      // Mettre à jour le store avec tous les segments transcrits
      state.setTranscript(allTranscriptSegments)

      // Analyse sémantique via LLM — on inclut les timestamps pour que le LLM
      // puisse produire des découpages avec des temps exacts
      state.setProcessing('analyzing', 0, 'Découpage intelligent par l\'IA...')
      const fullText = allTranscriptSegments
        .map((t: any) => `[${t.start.toFixed(1)}s] ${t.text}`)
        .join('\n')
      const result = await api.analyzeTranscript(fullText, state.config.context, state.config.ollamaModel)

      if (result && result.segments) {
        state.setSegments(result.segments.map((s: any) => ({
          ...s,
          id: Math.random().toString(36).substring(2, 11),
          transcriptSegments: [] // Optionnel: associer les phrases
        })))
      }

      state.setProcessing('done', 100, 'Analyse terminée !')
      await state.saveProject()
    } catch (e: any) {
      console.error('Erreur lors de l\'analyse IA :', e)
      state.setProcessing('error', 0, `Échec : ${e.message}`)
    }
  },

  // Reset
  reset: () => {
    set({
      videoFiles: [],
      transcript: [],
      segments: [],
      processingStep: 'idle',
      progress: 0,
      progressMessage: '',
      audioPaths: [],
      audioPath: null,
      videoFile: null,
      selectedSegmentId: null
    })
    // Recharger l'historique pour que les projets récents soient à jour
    get().loadHistory()
  },

  // --- Gestion de Projet & Historique ---
  history: [],

  loadHistory: async () => {
    try {
      const history = await api.getProjectHistory()
      set({ history })
    } catch { /* ignore if server not ready */ }
  },

  loadProject: async () => {
    // En mode web, on charge depuis l'historique directement
    // Le chargement de fichier se fait via import dans le Header
    const history = await api.getProjectHistory()
    if (history.length > 0) {
      get().loadFromHistory(history[0])
    }
  },

  loadFromHistory: (projectData) => {
    const audioPaths = projectData.audioPaths || []
    set({
      videoFiles: projectData.videoFiles || [],
      transcript: projectData.transcript || [],
      segments: projectData.segments || [],
      audioPaths: audioPaths,
      audioPath: audioPaths.length > 0 ? audioPaths[0] : null,
      config: { ...get().config, ...projectData.config },
      videoFile: projectData.videoFiles && projectData.videoFiles.length > 0 ? projectData.videoFiles[0] : null,
      processingStep: 'ready',
      progress: 100,
      progressMessage: 'Projet chargé'
    })
  },

  saveProject: async () => {
    const state = get()
    if (state.videoFiles.length === 0) return

    const projectData = {
      videoFiles: state.videoFiles,
      transcript: state.transcript,
      segments: state.segments,
      audioPaths: state.audioPaths,
      config: state.config,
      projectName: state.videoFiles[0].name
    }
    const fileName = await api.saveProject(projectData)
    if (fileName) {
      console.log('Projet sauvegarde:', fileName)
    }
  },

  autoSave: async () => {
    const state = get()
    if (state.videoFiles.length === 0) return

    const projectData = {
      videoFiles: state.videoFiles,
      transcript: state.transcript,
      segments: state.segments,
      audioPaths: state.audioPaths,
      config: state.config,
      projectName: state.videoFiles[0].name
    }
    await api.autoSaveProject(projectData)
    await get().loadHistory()
  }
}))
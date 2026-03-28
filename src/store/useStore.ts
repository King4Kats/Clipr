import { create } from 'zustand'
import { VideoFile, VideoSegment, TranscriptSegment, ProcessingStep, AppConfig, VideoClip } from '../types'
import api from '../api'

/**
 * USESTORE.TS : Gestion de l'état global (Store Zustand)
 *
 * Centralise l'état réactif de l'application : gestion multi-projets,
 * fichiers vidéo, transcriptions Whisper, configuration des modèles
 * et suivi du workflow de traitement.
 */

interface AppState {
  // Projet actif
  activeProjectId: string | null
  activeProjectName: string

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
  loadFromHistory: (projectRecord: any) => void
  autoSave: () => Promise<void>

  // Nouvelles actions multi-projets
  createProject: (name: string, type?: 'manual' | 'ai') => Promise<string | null>
  renameProject: (id: string, name: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  switchProject: (projectRecord: any) => void
}

const DEFAULT_WHISPER_PROMPT = `Entretien sur le patrimoine culturel de Vendée et de Bretagne. On parle du bocage, des métairies, closeries et borderies, du marais poitevin avec ses conches, biefs et rigoles, de la bourrine et du bourrinage. Les paludiers récoltent la fleur de sel dans les œillets, vasières, cobiers et adernes avec le las et la lousse, formant des mulons sur le trémet. En musique traditionnelle, le kan ha diskan avec kaner et diskaner anime les festoù-noz, avec gavotte, dañs-tro, ton simpl, tamm kreizh. La maraîchine et l'avant-deux sont les danses vendéennes. Les gwerzioù et sonioù accompagnent binioù kozh et bombarde dans le bagad. L'artisanat comprend le sabotier, le bourrelier, le tonnelier, le chaumier, le vannier et le charron. En architecture, longère, penty, malouinière, chaumière. Les pardons et troménies sont des traditions bretonnes. Gastronomie : préfou, mogette, brioche vendéenne, gâche, fouace, tourtisseaux, kouign-amann, krampouezh, far breton, kig ha farz, galette de sarrasin, chouchen. Toponymes en Plou-, Lan-, Tré-, Ker-, Loc-. La pigouille propulse la plate dans la Venise Verte.`

const defaultConfig: AppConfig = {
  whisperModel: 'large-v3',
  ollamaModel: 'mistral-small:22b',
  language: 'fr',
  outputQuality: 23,
  outputFolder: null,
  context: '',
  whisperPrompt: DEFAULT_WHISPER_PROMPT
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
  // --- Projet actif ---
  activeProjectId: null,
  activeProjectName: '',

  // --- Gestion de la collection de fichiers vidéo ---
  videoFiles: [],

  addVideoFile: (file) => {
    const current = get().videoFiles
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

  // --- Stockage de la Transcription ---
  transcript: [],
  addTranscriptSegment: (segment) =>
    set((state) => ({ transcript: [...state.transcript, segment] })),
  setTranscript: (segments) => set({ transcript: segments }),
  clearTranscript: () => set({ transcript: [] }),

  // --- Gestion des Segments Thématiques ---
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

  // Propriétés pour compatibilité
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

  getVideoAtTime: (globalTime) => {
    const files = get().videoFiles
    for (let i = 0; i < files.length; i++) {
      const video = files[i]
      if (globalTime >= video.offset && globalTime < video.offset + video.duration) {
        return { video, localTime: globalTime - video.offset, index: i }
      }
    }
    if (files.length > 0) {
      const last = files[files.length - 1]
      return { video: last, localTime: last.duration, index: files.length - 1 }
    }
    return null
  },

  getClipsForSegment: (start, end) => {
    const files = get().videoFiles
    const clips: VideoClip[] = []

    for (let i = 0; i < files.length; i++) {
      const video = files[i]
      const videoStart = video.offset
      const videoEnd = video.offset + video.duration

      if (start < videoEnd && end > videoStart) {
        const clipStart = Math.max(0, start - videoStart)
        const clipEnd = Math.min(video.duration, end - videoStart)
        clips.push({ videoIndex: i, videoPath: video.path, start: clipStart, end: clipEnd })
      }
    }
    return clips
  },

  /**
   * Lance l'analyse IA en arrière-plan côté serveur.
   * L'utilisateur peut naviguer vers d'autres projets pendant le traitement.
   * Le serveur sauvegarde les résultats en DB à la fin.
   */
  triggerAnalysis: async () => {
    const state = get()
    if (state.videoFiles.length === 0 || !state.activeProjectId) return

    try {
      // Sauvegarder l'état actuel avant de lancer l'analyse
      await state.saveProject()

      // S'abonner au channel WebSocket du projet
      api.subscribeToProject(state.activeProjectId)

      // Lancer l'analyse côté serveur (retour immédiat)
      state.setProcessing('extracting-audio', 0, 'Lancement de l\'analyse IA...')
      await api.launchAnalysis(state.activeProjectId, state.config)

      // Le suivi de progression se fait via les events WebSocket
      // (configurés dans App.tsx via onProgress / onAnalysisComplete)

    } catch (e: any) {
      console.error('Erreur lors du lancement de l\'analyse IA :', e)
      state.setProcessing('error', 0, `Échec : ${e.message}`)
    }
  },

  // Reset — retour à l'écran d'accueil (décharge le projet actif)
  reset: () => {
    api.unsubscribeFromProject()
    set({
      activeProjectId: null,
      activeProjectName: '',
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
    const history = await api.getProjectHistory()
    if (history.length > 0) {
      get().loadFromHistory(history[0])
    }
  },

  // Charge un projet depuis un enregistrement de l'historique (ProjectRecord du backend)
  loadFromHistory: (projectRecord) => {
    const data = projectRecord.data || projectRecord
    const audioPaths = data.audioPaths || []

    // Unsubscribe from previous project, subscribe to new one
    api.unsubscribeFromProject()
    if (projectRecord.id) {
      api.subscribeToProject(projectRecord.id)
    }

    // Si le projet est en cours de traitement, afficher la progression
    const isProcessing = projectRecord.status === 'processing'

    set({
      activeProjectId: projectRecord.id || null,
      activeProjectName: projectRecord.name || data.projectName || '',
      videoFiles: data.videoFiles || [],
      transcript: data.transcript || [],
      segments: data.segments || [],
      audioPaths: audioPaths,
      audioPath: audioPaths.length > 0 ? audioPaths[0] : null,
      config: { ...get().config, ...data.config },
      videoFile: data.videoFiles && data.videoFiles.length > 0 ? data.videoFiles[0] : null,
      processingStep: isProcessing ? 'analyzing' : 'ready',
      progress: isProcessing ? 50 : 100,
      progressMessage: isProcessing ? 'Analyse en cours (arrière-plan)...' : 'Projet chargé'
    })
  },

  saveProject: async () => {
    const state = get()
    if (state.videoFiles.length === 0 && !state.activeProjectId) return

    const projectData: any = {
      videoFiles: state.videoFiles,
      transcript: state.transcript,
      segments: state.segments,
      audioPaths: state.audioPaths,
      config: state.config,
      projectName: state.activeProjectName || (state.videoFiles[0]?.name ?? 'Projet Sans Nom')
    }

    if (state.activeProjectId) {
      projectData.id = state.activeProjectId
    }

    const id = await api.saveProject(projectData)
    if (id && !state.activeProjectId) {
      set({ activeProjectId: id })
    }
  },

  autoSave: async () => {
    const state = get()
    if (state.videoFiles.length === 0 && !state.activeProjectId) return

    const projectData: any = {
      videoFiles: state.videoFiles,
      transcript: state.transcript,
      segments: state.segments,
      audioPaths: state.audioPaths,
      config: state.config,
      projectName: state.activeProjectName || (state.videoFiles[0]?.name ?? 'Projet Sans Nom')
    }

    if (state.activeProjectId) {
      projectData.id = state.activeProjectId
    }

    await api.autoSaveProject(projectData)
    await get().loadHistory()
  },

  // --- Nouvelles actions multi-projets ---

  createProject: async (name, type = 'manual') => {
    try {
      const project = await api.createProject(name, type)
      set({
        activeProjectId: project.id,
        activeProjectName: project.name,
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
      await get().loadHistory()
      return project.id
    } catch (e: any) {
      console.error('Erreur création projet:', e)
      return null
    }
  },

  renameProject: async (id, name) => {
    await api.renameProject(id, name)
    const state = get()
    if (state.activeProjectId === id) {
      set({ activeProjectName: name })
    }
    await get().loadHistory()
  },

  deleteProject: async (id) => {
    await api.deleteProject(id)
    const state = get()
    if (state.activeProjectId === id) {
      get().reset()
    } else {
      await get().loadHistory()
    }
  },

  switchProject: (projectRecord) => {
    // Sauvegarder le projet actif avant de switcher
    const state = get()
    if (state.activeProjectId && state.videoFiles.length > 0) {
      state.autoSave()
    }
    get().loadFromHistory(projectRecord)
  }
}))

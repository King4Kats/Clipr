/**
 * API.TS : Client API pour la version web
 *
 * Remplace window.electron (preload IPC) par des appels HTTP REST + WebSocket.
 * Expose la même interface ElectronAPI pour minimiser les changements côté composants.
 */

// ============================================
// WebSocket pour les événements temps réel
// ============================================

type EventCallback = (data: any) => void

class WsClient {
  private ws: WebSocket | null = null
  private listeners: Map<string, Set<EventCallback>> = new Map()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`

    try {
      this.ws = new WebSocket(wsUrl)

      this.ws.onmessage = (event) => {
        try {
          const { event: eventName, data } = JSON.parse(event.data)
          const callbacks = this.listeners.get(eventName)
          if (callbacks) {
            callbacks.forEach(cb => cb(data))
          }
        } catch { /* ignore parse errors */ }
      }

      this.ws.onclose = () => {
        // Auto-reconnect après 2 secondes
        this.reconnectTimer = setTimeout(() => this.connect(), 2000)
      }

      this.ws.onerror = () => {
        // Will trigger onclose
      }
    } catch {
      this.reconnectTimer = setTimeout(() => this.connect(), 2000)
    }
  }

  on(event: string, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback)

    return () => {
      this.listeners.get(event)?.delete(callback)
    }
  }

  destroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}

const wsClient = new WsClient()
wsClient.connect()

// ============================================
// Helpers HTTP
// ============================================

async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

async function apiPost<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

// ============================================
// API Client (remplace window.electron)
// ============================================

export const api = {
  // --- Upload vidéo (remplace openVideoDialog) ---
  // Le composant UploadZone utilise maintenant un <input type="file">
  // et envoie les fichiers via cette méthode
  uploadVideos: async (files: FileList | File[]): Promise<any[]> => {
    const formData = new FormData()
    for (const file of Array.from(files)) {
      formData.append('videos', file)
    }

    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || 'Erreur upload')
    }

    const data = await res.json()
    return data.files
  },

  // --- FFmpeg ---
  getVideoDuration: async (videoPath: string): Promise<number> => {
    const data = await apiPost('/ffmpeg/duration', { videoPath })
    return data.duration
  },

  extractAudio: async (videoPath: string): Promise<string> => {
    const data = await apiPost('/ffmpeg/extract-audio', { videoPath })
    return data.audioPath
  },

  cutVideo: async (input: string, start: number, end: number, output: string): Promise<void> => {
    await apiPost('/ffmpeg/cut', { input, start, end, output })
  },

  convertToMp4: async (videoPath: string): Promise<string> => {
    const data = await apiPost('/ffmpeg/convert', { videoPath })
    return data.path
  },

  concatenateVideos: async (inputPaths: string[], output: string): Promise<void> => {
    await apiPost('/ffmpeg/concatenate', { inputPaths, output })
  },

  // --- Whisper ---
  loadWhisperModel: async (model: string): Promise<void> => {
    await apiPost('/whisper/load-model', { model })
  },

  transcribe: async (audioPath: string, language: string): Promise<any[]> => {
    const data = await apiPost('/whisper/transcribe', { audioPath, language })
    return data.segments
  },

  cancelTranscription: async (): Promise<void> => {
    await apiPost('/whisper/cancel')
  },

  // --- Ollama ---
  checkOllama: async (): Promise<boolean> => {
    const data = await apiGet('/ollama/check')
    return data.running
  },

  listOllamaModels: async (): Promise<string[]> => {
    const data = await apiGet('/ollama/models')
    return data.models
  },

  analyzeTranscript: async (transcript: string, context: string, model: string): Promise<any> => {
    return apiPost('/ollama/analyze', { transcript, context, model })
  },

  pullOllamaModel: async (modelName: string): Promise<{ success: boolean; message: string }> => {
    return apiPost('/ollama/pull', { modelName })
  },

  // --- Setup ---
  checkDependencies: async (): Promise<any[]> => {
    const data = await apiGet('/setup/check')
    return data.dependencies
  },

  // --- Projets ---
  autoSaveProject: async (data: any): Promise<void> => {
    await apiPost('/project/auto-save', data)
  },

  getProjectHistory: async (): Promise<any[]> => {
    const data = await apiGet('/project/history')
    return data.history
  },

  saveProject: async (data: any): Promise<string | null> => {
    const result = await apiPost('/project/save', data)
    return result.path
  },

  loadProject: async (): Promise<any | null> => {
    // En web, on ne peut pas ouvrir un dialogue fichier natif pour charger un projet
    // On charge depuis l'historique côté serveur
    return null
  },

  // --- Export ---
  exportVideos: async (segments: any[], videoFiles: any[], clipsData: any[][]): Promise<any> => {
    return apiPost('/export/video', { segments, videoFiles, clips: clipsData })
  },

  saveTextFile: async (content: string, defaultName: string): Promise<string | null> => {
    const result = await apiPost('/export/text', { content, filename: defaultName })
    // Déclencher le téléchargement dans le navigateur
    const downloadUrl = `/api/export/download/${encodeURIComponent(result.path)}`
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = defaultName
    a.click()
    return result.path
  },

  // --- Fichier audio (pour waveform) ---
  readFileBuffer: async (filePath: string): Promise<ArrayBuffer> => {
    const res = await fetch(`/api/audio/${encodeURIComponent(filePath)}`)
    if (!res.ok) throw new Error('Erreur lecture fichier audio')
    return res.arrayBuffer()
  },

  // --- Version ---
  getAppVersion: async (): Promise<string> => {
    const data = await apiGet('/version')
    return data.version
  },

  // --- Events (via WebSocket) ---
  onProgress: (callback: (data: { progress: number; message: string }) => void): (() => void) => {
    return wsClient.on('processing:progress', callback)
  },

  onSegments: (callback: (segments: unknown[]) => void): (() => void) => {
    return wsClient.on('processing:segments', callback)
  },

  onTranscriptSegment: (callback: (segment: unknown) => void): (() => void) => {
    return wsClient.on('whisper:segment', callback)
  },

  onModelProgress: (callback: (data: { type: 'whisper' | 'llm'; progress: number; message: string }) => void): (() => void) => {
    return wsClient.on('model:progress', callback)
  },

  onUpdateStatus: (callback: (status: any) => void): (() => void) => {
    return wsClient.on('updater:status', callback)
  },

  onLogSendProgress: (callback: (data: { percent: number; message: string }) => void): (() => void) => {
    return wsClient.on('logs:sendProgress', callback)
  },

  // --- Mise à jour Docker ---
  checkForUpdates: async (): Promise<any> => {
    return apiGet('/update/check')
  },

  triggerUpdate: async (): Promise<any> => {
    return apiPost('/update')
  },

  // --- Stubs (fonctions Electron non nécessaires en web) ---
  openFolder: async (_path: string): Promise<string> => { return '' },
  getAppPath: async (_name: string): Promise<string> => { return '' },
  selectFolderDialog: async (): Promise<string | null> => { return null },
  openVideoDialog: async (): Promise<string | null> => { return null },
  openVideosDialog: async (): Promise<string[]> => { return [] },
  installWhisper: async (): Promise<{ success: boolean; message: string }> => ({ success: true, message: 'Installé via Docker' }),
  installLLM: async (): Promise<{ success: boolean; message: string }> => ({ success: true, message: 'Via Ollama Docker' }),
  installOllama: async (): Promise<{ success: boolean; message: string }> => ({ success: true, message: 'Ollama est un service Docker' }),
  getModelStatus: async () => ({ whisper: { model: 'medium', downloaded: true }, llm: { model: 'ollama', downloaded: true } }),
  areModelsReady: async () => true,
  installUpdate: async (): Promise<void> => {},
  getInstallationId: async (): Promise<string> => 'web-instance',
  sendLogs: async (): Promise<{ success: boolean; message: string }> => {
    // Télécharger les logs directement
    window.open('/api/logs/download', '_blank')
    return { success: true, message: 'Logs téléchargés' }
  },
  openDocumentation: async (): Promise<void> => {
    window.open('/docs/index.html', '_blank')
  },
}

// Helper : convertir un chemin serveur en URL pour le lecteur vidéo
export function videoUrl(serverPath: string): string {
  return `/api/files/${encodeURIComponent(serverPath)}`
}

// Exposer sur window pour compatibilité avec le code existant
;(window as any).electron = api

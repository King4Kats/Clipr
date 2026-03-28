/**
 * API.TS : Client API HTTP + WebSocket
 * Remplace window.electron (IPC Electron) par des appels HTTP/WS vers le backend Express.
 */

const API_BASE = ''  // meme origin

// ── WebSocket ──
type WsCallback = (data: any) => void
const wsCallbacks: Record<string, WsCallback[]> = {}
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

function connectWs() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      const type = data.type
      if (type && wsCallbacks[type]) {
        wsCallbacks[type].forEach(cb => cb(data))
      }
    } catch {}
  }

  ws.onclose = () => {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
    wsReconnectTimer = setTimeout(connectWs, 3000)
  }

  ws.onerror = () => ws?.close()
}

function onWsEvent(type: string, callback: WsCallback): () => void {
  if (!wsCallbacks[type]) wsCallbacks[type] = []
  wsCallbacks[type].push(callback)
  return () => { wsCallbacks[type] = wsCallbacks[type].filter(cb => cb !== callback) }
}

connectWs()

// ── HTTP helpers ──
async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

async function post<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

// ── Upload helper ──
async function uploadFiles(files: File[]): Promise<any[]> {
  const formData = new FormData()
  files.forEach(f => formData.append('videos', f))
  const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData })
  if (!res.ok) throw new Error('Upload echoue')
  return res.json()
}

// ── Download helper ──
function downloadFile(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// ── API compatible avec l'ancienne interface ElectronAPI ──
const api = {
  // Upload (remplace dialog:openVideos — gere via <input> dans UploadZone)
  uploadFiles,

  // Video streaming URL (remplace local-video://)
  getVideoUrl: (fileId: string) => `${API_BASE}/api/files/${fileId}`,
  getDataFileUrl: (relativePath: string) => `${API_BASE}/api/data-files/${relativePath}`,

  // FFmpeg
  getVideoDuration: (videoPath: string) => post<{ duration: number }>('/api/ffmpeg/duration', { videoPath }).then(r => r.duration),
  extractAudio: (videoPath: string) => post<{ audioPath: string }>('/api/ffmpeg/extract-audio', { videoPath }).then(r => r.audioPath),
  cutVideo: (input: string, start: number, end: number, output: string) => post('/api/ffmpeg/cut', { input, start, end, output }),
  concatenateVideos: (inputPaths: string[], output: string) => post('/api/ffmpeg/concatenate', { inputPaths, output }),

  // Export
  exportSegment: (clips: any[], title: string, index: number) => post<{ filename: string; downloadUrl: string }>('/api/export/segment', { clips, title, index }),
  exportText: (content: string, filename: string) => post<{ downloadUrl: string }>('/api/export/text', { content, filename }),
  downloadExport: (url: string, filename: string) => downloadFile(url, filename),

  // Whisper
  transcribe: (audioPath: string, language: string, model?: string, initialPrompt?: string) =>
    post<{ segments: any[] }>('/api/whisper/transcribe', { audioPath, language, model, initialPrompt }).then(r => r.segments),
  cancelTranscription: () => post('/api/whisper/cancel'),

  // Ollama
  checkOllama: () => get<{ running: boolean }>('/api/ollama/check').then(r => r.running),
  listOllamaModels: () => get<{ models: string[] }>('/api/ollama/models').then(r => r.models),
  pullOllamaModel: (model: string) => post<{ success: boolean; message: string }>('/api/ollama/pull', { model }),
  analyzeTranscript: (transcript: string, context: string, model: string) =>
    post('/api/ollama/analyze', { transcript, context, model }),

  // Project
  getProjectHistory: () => get<any[]>('/api/project/history'),
  autoSaveProject: (data: any) => post('/api/project/autosave', data),
  saveProject: (data: any) => post<{ fileName: string }>('/api/project/save', data).then(r => r.fileName),
  exportProject: (data: any) => post<{ downloadUrl: string }>('/api/project/export', data),
  importProject: async (file: File) => {
    const formData = new FormData()
    formData.append('project', file)
    const res = await fetch(`${API_BASE}/api/project/import`, { method: 'POST', body: formData })
    if (!res.ok) throw new Error('Import echoue')
    return res.json()
  },

  // Setup
  checkDependencies: () => get('/api/setup/dependencies'),

  // Version & Update
  getAppVersion: () => get<{ version: string }>('/api/version').then(r => r.version),
  checkForUpdates: () => get('/api/update/check'),
  installUpdate: () => post('/api/update'),

  // Logs
  exportLogs: () => downloadFile('/api/logs/export', 'clipr-logs.log'),

  // Events (WebSocket)
  onProgress: (cb: (data: { progress: number; message: string }) => void) => onWsEvent('progress', cb),
  onTranscriptSegment: (cb: (segment: any) => void) => onWsEvent('transcript:segment', cb),
  onModelProgress: (cb: (data: { type: string; progress: number; message: string }) => void) => onWsEvent('model:progress', cb),

  // Documentation
  openDocumentation: () => { window.open('/docs/', '_blank') }
}

// Expose comme window.electron pour compatibilite avec le code existant
;(window as any).electron = api

export default api

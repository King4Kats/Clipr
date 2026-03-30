/**
 * API.TS : Client API HTTP + WebSocket
 * Supporte les channels WebSocket par projet pour le suivi en temps réel.
 */

const API_BASE = ''  // meme origin
const AUTH_STORAGE_KEY = 'clipr-auth-token'

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem(AUTH_STORAGE_KEY)
  return token ? { 'Authorization': `Bearer ${token}` } : {}
}

// ── WebSocket ──
type WsCallback = (data: any) => void
const wsCallbacks: Record<string, WsCallback[]> = {}
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let currentSubscribedProjectId: string | null = null

function connectWs() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

  ws.onopen = () => {
    // Authenticate WebSocket connection
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    if (token) wsSend({ type: 'auth', token })
    // Re-subscribe to project channel after reconnect
    if (currentSubscribedProjectId) {
      wsSend({ type: 'subscribe', projectId: currentSubscribedProjectId })
    }
  }

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

function wsSend(msg: any) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function onWsEvent(type: string, callback: WsCallback): () => void {
  if (!wsCallbacks[type]) wsCallbacks[type] = []
  wsCallbacks[type].push(callback)
  return () => { wsCallbacks[type] = wsCallbacks[type].filter(cb => cb !== callback) }
}

// Subscribe to project-specific WebSocket events
function subscribeToProject(projectId: string) {
  currentSubscribedProjectId = projectId
  // Ensure auth before subscribing
  const token = localStorage.getItem(AUTH_STORAGE_KEY)
  if (token) wsSend({ type: 'auth', token })
  wsSend({ type: 'subscribe', projectId })
}

function unsubscribeFromProject() {
  currentSubscribedProjectId = null
  wsSend({ type: 'unsubscribe' })
}

connectWs()

// ── HTTP helpers ──
async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

async function post<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

async function patch<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

async function del<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: getAuthHeaders() })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

// ── Upload helper ──
async function uploadFiles(files: File[]): Promise<any[]> {
  const formData = new FormData()
  files.forEach(f => formData.append('videos', f))
  const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData, headers: getAuthHeaders() })
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

// ── API ──
const api = {
  uploadFiles,

  getVideoUrl: (fileId: string) => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/files/${fileId}${token ? `?token=${token}` : ''}`
  },
  getDataFileUrl: (relativePath: string) => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/data-files/${relativePath}${token ? `?token=${token}` : ''}`
  },

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
  createProject: (name: string, type: 'manual' | 'ai' = 'manual') =>
    post<any>('/api/project/create', { name, type }),
  autoSaveProject: (data: any) => post('/api/project/autosave', data),
  saveProject: (data: any) => post<{ id: string }>('/api/project/save', data).then(r => r.id),
  loadProjectById: (id: string) => get<any>(`/api/project/load/${id}`),
  renameProject: (id: string, name: string) => patch(`/api/project/${id}/rename`, { name }),
  deleteProject: (id: string) => del(`/api/project/${id}`),
  updateProjectStatus: (id: string, status: string) => patch(`/api/project/${id}/status`, { status }),
  // AI / Queue status
  getAiStatus: () => get<{ locked: boolean; lock: any; queue: any }>('/api/ai/status'),
  getQueueState: () => get<any>('/api/queue'),
  getTaskStatus: (taskId: string) => get<any>(`/api/queue/${taskId}`),
  cancelTask: (taskId: string) => del(`/api/queue/${taskId}`),
  // Launch server-side background analysis (via queue)
  launchAnalysis: (projectId: string, config: any) =>
    post<{ success: boolean; taskId: string; position: number }>(`/api/project/${projectId}/analyze`, { config }),
  // Sharing
  shareProject: (projectId: string, username: string, role: 'viewer' | 'editor' = 'viewer') =>
    post(`/api/project/${projectId}/share`, { username, role }),
  unshareProject: (projectId: string, userId: string) =>
    del(`/api/project/${projectId}/share/${userId}`),
  getProjectShares: (projectId: string) => get<any[]>(`/api/project/${projectId}/shares`),
  getSharedProjects: () => get<any[]>('/api/project/shared'),
  searchUsers: (query: string) => get<any[]>(`/api/users/search?q=${encodeURIComponent(query)}`),

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

  // Standalone Transcription
  uploadMedia: async (file: File): Promise<any> => {
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch(`${API_BASE}/api/upload/media`, { method: 'POST', body: formData, headers: getAuthHeaders() })
    if (!res.ok) throw new Error('Upload échoué')
    return res.json()
  },
  startTranscription: (filePath: string, filename: string, config: any) =>
    post<{ success: boolean; taskId: string; position: number }>('/api/transcription/start', { filePath, filename, config }),
  // Batch transcription
  uploadMediaBatch: async (files: File[]): Promise<any> => {
    const formData = new FormData()
    files.forEach(f => formData.append('files', f))
    const res = await fetch(`${API_BASE}/api/upload/media/batch`, { method: 'POST', body: formData, headers: getAuthHeaders() })
    if (!res.ok) throw new Error('Upload batch échoué')
    return res.json()
  },
  startTranscriptionBatch: (files: { filePath: string; filename: string }[], config: any) =>
    post<{ success: boolean; batchId: string; tasks: { taskId: string; position: number; filename: string }[] }>('/api/transcription/start/batch', { files, config }),
  getTranscriptionHistory: () => get<any[]>('/api/transcription/history'),
  getTranscription: (id: string) => get<any>(`/api/transcription/${id}`),
  deleteTranscription: (id: string) => del(`/api/transcription/${id}`),
  getTranscriptionExportUrl: (id: string, format: 'txt' | 'srt') => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/transcription/${id}/export?format=${format}${token ? `&token=${token}` : ''}`
  },

  // WebSocket events
  onProgress: (cb: (data: any) => void) => onWsEvent('progress', cb),
  onTranscriptSegment: (cb: (segment: any) => void) => onWsEvent('transcript:segment', cb),
  onModelProgress: (cb: (data: any) => void) => onWsEvent('model:progress', cb),
  onAnalysisComplete: (cb: (data: any) => void) => onWsEvent('analysis:complete', cb),
  onAnalysisError: (cb: (data: any) => void) => onWsEvent('analysis:error', cb),

  // Queue WebSocket events
  onQueueUpdate: (cb: (data: any) => void) => onWsEvent('queue:update', cb),
  onQueueTaskStarted: (cb: (data: any) => void) => onWsEvent('queue:task-started', cb),
  onQueueTaskCompleted: (cb: (data: any) => void) => onWsEvent('queue:task-completed', cb),
  onQueueTaskFailed: (cb: (data: any) => void) => onWsEvent('queue:task-failed', cb),

  // Transcription WebSocket events
  onTranscriptionProgress: (cb: (data: any) => void) => onWsEvent('transcription:progress', cb),
  onTranscriptionSegment: (cb: (data: any) => void) => onWsEvent('transcription:segment', cb),
  onTranscriptionComplete: (cb: (data: any) => void) => onWsEvent('transcription:complete', cb),

  // WebSocket project subscription
  subscribeToProject,
  unsubscribeFromProject,

  // Documentation
  openDocumentation: () => { window.open('/docs/', '_blank') }
}

;(window as any).electron = api

export default api

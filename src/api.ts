/**
 * =============================================================================
 * Fichier : api.ts
 * Rôle    : Client API côté navigateur (frontend).
 *
 *           Ce fichier fait le pont entre l'interface utilisateur React et le
 *           serveur Express. Il fournit :
 *
 *           1. Une connexion WebSocket pour recevoir les événements en temps réel
 *              (progression de l'analyse IA, transcription Whisper, etc.)
 *           2. Des helpers HTTP (GET, POST, PATCH, DELETE) pour appeler l'API REST
 *           3. Un système d'upload avec support des gros fichiers (chunked upload)
 *           4. Un objet `api` centralisé qui regroupe TOUTES les méthodes
 *              disponibles (upload, FFmpeg, Whisper, Ollama, projets, etc.)
 *
 *           L'objet `api` est aussi exposé sur `window.electron` pour compatibilité
 *           avec l'ancienne architecture Electron de l'application.
 * =============================================================================
 */

// Pas de préfixe d'URL : le frontend et le backend sont servis sur le même domaine
const API_BASE = ''  // meme origin

// Clé utilisée dans localStorage pour stocker le token JWT de l'utilisateur
const AUTH_STORAGE_KEY = 'clipr-auth-token'

/**
 * Construit les en-têtes d'authentification pour les requêtes HTTP.
 * Si l'utilisateur est connecté, on ajoute le header "Authorization: Bearer <token>"
 * qui sera vérifié par le middleware requireAuth côté serveur.
 */
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem(AUTH_STORAGE_KEY)
  return token ? { 'Authorization': `Bearer ${token}` } : {}
}

// ══════════════════════════════════════════════════════════════════════════════
// ── WEBSOCKET : Communication temps réel avec le serveur ──
// Le WebSocket permet de recevoir des événements "push" du serveur sans
// avoir à les demander (polling). C'est utilisé pour :
// - Suivre la progression de l'analyse IA en direct
// - Recevoir les segments de transcription au fur et à mesure
// - Être notifié quand une tâche en file d'attente démarre ou se termine
// ══════════════════════════════════════════════════════════════════════════════

// Type d'une fonction callback qui recevra les données d'un événement WebSocket
type WsCallback = (data: any) => void

// Registre des callbacks : pour chaque type d'événement, on stocke une liste de fonctions
// Exemple : wsCallbacks['progress'] = [callback1, callback2, ...]
const wsCallbacks: Record<string, WsCallback[]> = {}

// Référence vers la connexion WebSocket active (null si déconnecté)
let ws: WebSocket | null = null

// Timer pour la reconnexion automatique (3 secondes après une déconnexion)
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

// ID du projet actuellement "écouté" via WebSocket (pour recevoir ses événements)
let currentSubscribedProjectId: string | null = null

/**
 * Établit la connexion WebSocket avec le serveur.
 * - Détecte automatiquement si on est en HTTP (ws:) ou HTTPS (wss:)
 * - S'authentifie dès la connexion avec le token JWT
 * - Se ré-abonne au projet en cours si on se reconnecte après une coupure
 * - Se reconnecte automatiquement 3 secondes après une déconnexion
 */
function connectWs() {
  // Choisir le bon protocole WebSocket selon HTTP ou HTTPS
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

  // Quand la connexion est établie
  ws.onopen = () => {
    // Envoyer le token JWT pour s'authentifier sur le WebSocket
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    if (token) wsSend({ type: 'auth', token })
    // Si on était abonné à un projet avant la déconnexion, se réabonner
    if (currentSubscribedProjectId) {
      wsSend({ type: 'subscribe', projectId: currentSubscribedProjectId })
    }
  }

  // Quand on reçoit un message du serveur
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      const type = data.type
      // Appeler tous les callbacks enregistrés pour ce type d'événement
      if (type && wsCallbacks[type]) {
        wsCallbacks[type].forEach(cb => cb(data))
      }
    } catch {}
  }

  // Reconnexion automatique après 3 secondes si la connexion se ferme
  ws.onclose = () => {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
    wsReconnectTimer = setTimeout(connectWs, 3000)
  }

  // En cas d'erreur, fermer proprement (ce qui déclenchera la reconnexion)
  ws.onerror = () => ws?.close()
}

/**
 * Envoie un message au serveur via WebSocket.
 * Ne fait rien si la connexion n'est pas ouverte (évite les erreurs).
 */
function wsSend(msg: any) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

/**
 * Enregistre un callback pour un type d'événement WebSocket.
 * Retourne une fonction de "cleanup" pour se désabonner (utile dans les useEffect React).
 *
 * Exemple d'utilisation :
 *   const unsub = onWsEvent('progress', (data) => console.log(data))
 *   // Plus tard, pour se désabonner :
 *   unsub()
 */
function onWsEvent(type: string, callback: WsCallback): () => void {
  if (!wsCallbacks[type]) wsCallbacks[type] = []
  wsCallbacks[type].push(callback)
  // Retourne la fonction de désabonnement
  return () => { wsCallbacks[type] = wsCallbacks[type].filter(cb => cb !== callback) }
}

/**
 * S'abonne au "channel" WebSocket d'un projet spécifique.
 * Le serveur n'enverra que les événements concernant CE projet (progression, résultats, etc.)
 */
function subscribeToProject(projectId: string) {
  currentSubscribedProjectId = projectId
  // S'assurer qu'on est authentifié avant de s'abonner
  const token = localStorage.getItem(AUTH_STORAGE_KEY)
  if (token) wsSend({ type: 'auth', token })
  wsSend({ type: 'subscribe', projectId })
}

/**
 * Se désabonne du channel projet. On ne recevra plus les événements de ce projet.
 */
function unsubscribeFromProject() {
  currentSubscribedProjectId = null
  wsSend({ type: 'unsubscribe' })
}

// Lancer la connexion WebSocket dès le chargement du fichier
connectWs()

// ══════════════════════════════════════════════════════════════════════════════
// ── HELPERS HTTP : Fonctions utilitaires pour les requêtes API REST ──
// Ces fonctions simplifient les appels fetch() en gérant automatiquement :
// - L'authentification (header Authorization)
// - Le parsing de la réponse JSON
// - La gestion des erreurs (throw si le status n'est pas OK)
// ══════════════════════════════════════════════════════════════════════════════

/** Requête GET — pour récupérer des données */
async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

/** Requête POST — pour envoyer des données (créer, déclencher une action) */
async function post<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

/** Requête PATCH — pour modifier partiellement une ressource */
async function patch<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

/** Requête DELETE — pour supprimer une ressource */
async function del<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: getAuthHeaders() })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

// ══════════════════════════════════════════════════════════════════════════════
// ── UPLOAD : Envoi de fichiers au serveur ──
// Deux stratégies selon la taille du fichier :
// - Petit fichier (< 90 Mo) : envoi en une seule requête
// - Gros fichier (>= 90 Mo) : envoi par morceaux (chunks) puis assemblage
// Le chunked upload est nécessaire pour passer les limites de Cloudflare Tunnel (100 Mo)
// ══════════════════════════════════════════════════════════════════════════════

// Taille max d'un chunk : 90 Mo (en dessous de la limite Cloudflare de 100 Mo)
const CHUNK_SIZE = 90 * 1024 * 1024 // 90MB — under Cloudflare Tunnel's 100MB limit

/**
 * Upload un gros fichier en le découpant en morceaux (chunks).
 * Chaque morceau est envoyé séparément, puis le serveur les rassemble.
 * En cas d'échec, chaque chunk est réessayé jusqu'à 3 fois.
 */
async function uploadFileChunked(file: File, onProgress?: (pct: number) => void): Promise<any> {
  // Identifiant unique pour cet upload (permet au serveur de regrouper les chunks)
  const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  // Envoyer chaque chunk un par un
  for (let i = 0; i < totalChunks; i++) {
    // Découper le fichier : prendre les octets de i*CHUNK_SIZE à (i+1)*CHUNK_SIZE
    const blob = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    const form = new FormData()
    form.append('chunk', blob)
    form.append('uploadId', uploadId)
    form.append('chunkIndex', String(i))
    form.append('totalChunks', String(totalChunks))
    form.append('fileName', file.name)

    // Système de retry : 3 tentatives par chunk avec 1s de pause entre chaque
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/api/upload/chunk`, { method: 'POST', body: form, headers: getAuthHeaders() })
        if (!res.ok) throw new Error(`Chunk ${i} echoue: ${res.status}`)
        lastErr = null
        break
      } catch (err: any) {
        lastErr = err
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000))
      }
    }
    if (lastErr) throw lastErr
    // Mettre à jour la progression (0 à 1)
    onProgress?.((i + 1) / totalChunks)
  }

  // Demander au serveur d'assembler tous les chunks en un seul fichier
  const res = await fetch(`${API_BASE}/api/upload/chunk/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ uploadId, fileName: file.name, totalChunks })
  })
  if (!res.ok) throw new Error('Assemblage echoue')
  return res.json()
}

/**
 * Upload un ou plusieurs fichiers. Choisit automatiquement la stratégie :
 * - Petit fichier : envoi classique en une requête (FormData)
 * - Gros fichier : envoi par chunks via uploadFileChunked
 */
async function uploadFiles(files: File[], onProgress?: (pct: number) => void): Promise<any[]> {
  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const results: any[] = []
  let uploaded = 0

  for (const file of files) {
    if (file.size < CHUNK_SIZE) {
      // Petit fichier : upload classique en une seule requête
      const formData = new FormData()
      formData.append('videos', file)
      const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData, headers: getAuthHeaders() })
      if (!res.ok) throw new Error('Upload echoue')
      const arr = await res.json()
      results.push(...arr)
      uploaded += file.size
      onProgress?.(uploaded / totalSize)
    } else {
      // Gros fichier : upload par morceaux
      const result = await uploadFileChunked(file, (chunkPct) => {
        onProgress?.((uploaded + chunkPct * file.size) / totalSize)
      })
      results.push(result)
      uploaded += file.size
      onProgress?.(uploaded / totalSize)
    }
  }

  return results
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DOWNLOAD : Téléchargement de fichiers ──
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Déclenche le téléchargement d'un fichier dans le navigateur.
 * Crée un lien <a> invisible, clique dessus, puis le supprime.
 * C'est la technique standard pour déclencher un téléchargement en JS.
 */
function downloadFile(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// ══════════════════════════════════════════════════════════════════════════════
// ── OBJET API : Regroupe TOUTES les méthodes de l'API ──
// C'est cet objet qui est importé partout dans l'application avec `import api`
// Chaque méthode correspond à un endpoint du serveur Express.
// ══════════════════════════════════════════════════════════════════════════════
const api = {
  // ── Upload de fichiers vidéo/audio ──
  uploadFiles,

  // ── Génération d'URLs pour les fichiers médias ──
  // Le token est passé en paramètre d'URL car les balises <video> et <audio>
  // ne supportent pas les headers d'authentification personnalisés.
  getVideoUrl: (fileId: string) => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/files/${fileId}${token ? `?token=${token}` : ''}`
  },
  getDataFileUrl: (relativePath: string) => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/data-files/${relativePath}${token ? `?token=${token}` : ''}`
  },

  // ── FFmpeg : Manipulation vidéo/audio ──
  getVideoDuration: (videoPath: string) => post<{ duration: number }>('/api/ffmpeg/duration', { videoPath }).then(r => r.duration),
  extractAudio: (videoPath: string) => post<{ audioPath: string }>('/api/ffmpeg/extract-audio', { videoPath }).then(r => r.audioPath),
  cutVideo: (input: string, start: number, end: number, output: string) => post('/api/ffmpeg/cut', { input, start, end, output }),
  concatenateVideos: (inputPaths: string[], output: string) => post('/api/ffmpeg/concatenate', { inputPaths, output }),

  // ── Export : Génération et téléchargement de fichiers ──
  exportSegment: (clips: any[], title: string, index: number) => post<{ filename: string; downloadUrl: string }>('/api/export/segment', { clips, title, index }),
  exportText: (content: string, filename: string) => post<{ downloadUrl: string }>('/api/export/text', { content, filename }),
  downloadExport: (url: string, filename: string) => downloadFile(url, filename),

  // ── Whisper : Transcription audio → texte ──
  transcribe: (audioPath: string, language: string, model?: string, initialPrompt?: string) =>
    post<{ segments: any[] }>('/api/whisper/transcribe', { audioPath, language, model, initialPrompt }).then(r => r.segments),
  cancelTranscription: () => post('/api/whisper/cancel'),

  // ── Ollama : IA locale (analyse thématique) ──
  checkOllama: () => get<{ running: boolean }>('/api/ollama/check').then(r => r.running),
  listOllamaModels: () => get<{ models: string[] }>('/api/ollama/models').then(r => r.models),
  pullOllamaModel: (model: string) => post<{ success: boolean; message: string }>('/api/ollama/pull', { model }),
  analyzeTranscript: (transcript: string, context: string, model: string) =>
    post('/api/ollama/analyze', { transcript, context, model }),

  // ── Analyse semantique : themes, sentiment, insights via Ollama ──
  semanticAnalyze: (segments: any[], model: string) =>
    post<{ semanticAnalysis: { themes: string[]; sentiment: { label: string; explanation: string }; insights: string[] } }>('/api/semantic/analyze', { segments, model }),

  // ── Assistant : Chatbot LLM standalone (multi-conversations par user) ──
  assistantListConversations: () =>
    get<{ id: string; title: string; created_at: string; updated_at: string }[]>('/api/assistant/conversations'),
  assistantCreateConversation: () =>
    post<{ id: string; title: string; created_at: string; updated_at: string }>('/api/assistant/conversations'),
  assistantGetConversation: (id: string) =>
    get<{ conversation: { id: string; title: string }; messages: { id: string; role: 'user' | 'assistant'; content: string; created_at: string }[] }>(`/api/assistant/conversations/${id}`),
  assistantRenameConversation: (id: string, title: string) =>
    patch(`/api/assistant/conversations/${id}`, { title }),
  assistantDeleteConversation: (id: string) =>
    del(`/api/assistant/conversations/${id}`),
  /**
   * Upload un fichier (.txt/.docx/.pdf) et retourne son texte extrait.
   * Le client peut ensuite l'inserer dans son prompt.
   */
  assistantExtractFile: async (file: File): Promise<{ filename: string; text: string }> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${API_BASE}/api/assistant/extract`, {
      method: 'POST',
      body: form,
      headers: getAuthHeaders(),
    })
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`)
    return res.json()
  },
  /**
   * Envoie un message a l'assistant et stream la reponse via SSE.
   * onToken : appele a chaque token recu (texte incremental)
   * onDone : appele a la fin avec le texte complet et le message sauvegarde
   * onError : appele en cas d'erreur
   * Retourne un controleur avec .abort() pour annuler la generation.
   */
  assistantSendMessage: (
    convId: string,
    content: string,
    onToken: (chunk: string) => void,
    onDone: (full: string, message: any) => void,
    onError: (err: string) => void,
    model?: string,
  ) => {
    const ctrl = new AbortController()
    fetch(`${API_BASE}/api/assistant/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ content, model }),
      signal: ctrl.signal,
    }).then(async (res) => {
      if (!res.ok || !res.body) { onError(`HTTP ${res.status}`); return }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE format : lignes "data: {...}" separees par \n\n
        let sepIdx
        while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, sepIdx)
          buffer = buffer.slice(sepIdx + 2)
          const line = event.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.token) { full += data.token; onToken(data.token) }
            if (data.done) { onDone(full, data.message); return }
            if (data.error) { onError(data.error); return }
          } catch {}
        }
      }
    }).catch((err) => {
      if (err.name !== 'AbortError') onError(err.message || 'Erreur reseau')
    })
    return { abort: () => ctrl.abort() }
  },

  // ── Projets : CRUD et gestion de l'historique ──
  getProjectHistory: () => get<any[]>('/api/project/history'),
  createProject: (name: string, type: 'manual' | 'ai' = 'manual') =>
    post<any>('/api/project/create', { name, type }),
  autoSaveProject: (data: any) => post('/api/project/autosave', data),
  saveProject: (data: any) => post<{ id: string }>('/api/project/save', data).then(r => r.id),
  loadProjectById: (id: string) => get<any>(`/api/project/load/${id}`),
  renameProject: (id: string, name: string) => patch(`/api/project/${id}/rename`, { name }),
  deleteProject: (id: string) => del(`/api/project/${id}`),
  updateProjectStatus: (id: string, status: string) => patch(`/api/project/${id}/status`, { status }),

  // ── File d'attente IA et statut ──
  getAiStatus: () => get<{ locked: boolean; lock: any; queue: any }>('/api/ai/status'),
  getQueueState: () => get<any>('/api/queue'),
  getTaskStatus: (taskId: string) => get<any>(`/api/queue/${taskId}`),
  cancelTask: (taskId: string) => del(`/api/queue/${taskId}`),

  // Lance l'analyse IA en arrière-plan (le serveur met la tâche en file d'attente)
  launchAnalysis: (projectId: string, config: any) =>
    post<{ success: boolean; taskId: string; position: number }>(`/api/project/${projectId}/analyze`, { config }),

  // ── Partage de projets entre utilisateurs ──
  shareProject: (projectId: string, username: string, role: 'viewer' | 'editor' = 'viewer') =>
    post(`/api/project/${projectId}/share`, { username, role }),
  unshareProject: (projectId: string, userId: string) =>
    del(`/api/project/${projectId}/share/${userId}`),
  getProjectShares: (projectId: string) => get<any[]>(`/api/project/${projectId}/shares`),
  getSharedProjects: () => get<any[]>('/api/project/shared'),
  searchUsers: (query: string) => get<any[]>(`/api/users/search?q=${encodeURIComponent(query)}`),

  // ── Import/Export de projets complets ──
  exportProject: (data: any) => post<{ downloadUrl: string }>('/api/project/export', data),
  importProject: async (file: File) => {
    const formData = new FormData()
    formData.append('project', file)
    const res = await fetch(`${API_BASE}/api/project/import`, { method: 'POST', body: formData })
    if (!res.ok) throw new Error('Import echoue')
    return res.json()
  },

  // ── Configuration et vérification des dépendances ──
  checkDependencies: () => get('/api/setup/dependencies'),

  // ── Version et mises à jour ──
  getAppVersion: () => get<{ version: string }>('/api/version').then(r => r.version),
  checkForUpdates: () => get('/api/update/check'),
  installUpdate: () => post('/api/update'),

  // ── Logs : export des journaux du serveur ──
  exportLogs: () => downloadFile('/api/logs/export', 'clipr-logs.log'),

  // ── Transcription standalone (outil séparé des projets vidéo) ──
  uploadMedia: async (file: File): Promise<any> => {
    if (file.size >= CHUNK_SIZE) {
      // Gros fichier : upload par morceaux
      return uploadFileChunked(file)
    }
    // Petit fichier : upload classique
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch(`${API_BASE}/api/upload/media`, { method: 'POST', body: formData, headers: getAuthHeaders() })
    if (!res.ok) throw new Error('Upload échoué')
    return res.json()
  },
  startTranscription: (filePath: string, filename: string, config: any) =>
    post<{ success: boolean; taskId: string; position: number }>('/api/transcription/start', { filePath, filename, config }),

  // ── Transcription batch : plusieurs fichiers d'un coup ──
  uploadMediaBatch: async (files: File[]): Promise<any> => {
    // Séparer les gros fichiers (chunked) des petits (batch classique)
    const largeFiles = files.filter(f => f.size >= CHUNK_SIZE)
    const smallFiles = files.filter(f => f.size < CHUNK_SIZE)

    const results: any[] = []

    // Les gros fichiers sont uploadés individuellement par chunks
    for (const file of largeFiles) {
      const result = await uploadFileChunked(file)
      results.push(result)
    }

    // Les petits fichiers sont uploadés ensemble en un seul FormData
    if (smallFiles.length > 0) {
      const formData = new FormData()
      smallFiles.forEach(f => formData.append('files', f))
      const res = await fetch(`${API_BASE}/api/upload/media/batch`, { method: 'POST', body: formData, headers: getAuthHeaders() })
      if (!res.ok) throw new Error('Upload batch échoué')
      const batchResults = await res.json()
      results.push(...batchResults)
    }

    return results
  },
  startTranscriptionBatch: (files: { filePath: string; filename: string }[], config: any) =>
    post<{ success: boolean; batchId: string; tasks: { taskId: string; position: number; filename: string }[] }>('/api/transcription/start/batch', { files, config }),
  getTranscriptionHistory: () => get<any[]>('/api/transcription/history'),
  getTranscription: (id: string) => get<any>(`/api/transcription/${id}`),
  renameSpeaker: (id: string, oldName: string, newName: string) =>
    patch<{ success: boolean; segments: any[] }>(`/api/transcription/${id}/rename-speaker`, { oldName, newName }),
  deleteTranscription: (id: string) => del(`/api/transcription/${id}`),
  getTranscriptionExportUrl: (id: string, format: 'txt' | 'srt') => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/transcription/${id}/export?format=${format}${token ? `&token=${token}` : ''}`
  },

  // ── Événements WebSocket : Analyse IA (projets vidéo) ──
  // Chaque méthode retourne une fonction de désabonnement
  onProgress: (cb: (data: any) => void) => onWsEvent('progress', cb),
  onTranscriptSegment: (cb: (segment: any) => void) => onWsEvent('transcript:segment', cb),
  onModelProgress: (cb: (data: any) => void) => onWsEvent('model:progress', cb),
  onAnalysisComplete: (cb: (data: any) => void) => onWsEvent('analysis:complete', cb),
  onAnalysisError: (cb: (data: any) => void) => onWsEvent('analysis:error', cb),

  // ── Événements WebSocket : File d'attente ──
  onQueueUpdate: (cb: (data: any) => void) => onWsEvent('queue:update', cb),
  onQueueTaskStarted: (cb: (data: any) => void) => onWsEvent('queue:task-started', cb),
  onQueueTaskCompleted: (cb: (data: any) => void) => onWsEvent('queue:task-completed', cb),
  onQueueTaskFailed: (cb: (data: any) => void) => onWsEvent('queue:task-failed', cb),

  // ── Événements WebSocket : Transcription standalone ──
  // Support messaging
  onSupportMessage: (cb: (data: any) => void) => onWsEvent('support:message', cb),

  onTranscriptionProgress: (cb: (data: any) => void) => onWsEvent('transcription:progress', cb),
  onTranscriptionSegment: (cb: (data: any) => void) => onWsEvent('transcription:segment', cb),
  onTranscriptionComplete: (cb: (data: any) => void) => onWsEvent('transcription:complete', cb),
  onDiarizationComplete: (cb: (data: any) => void) => onWsEvent('transcription:diarization-complete', cb),

  // ── Transcription linguistique (analyse patois/vernaculaire) ──
  startLinguistic: (filePath: string, filename: string, config: any) =>
    post<{ success: boolean; taskId: string; position: number; projectId: string }>('/api/linguistic/start', { filePath, filename, config }),
  getLinguistic: (id: string) => get<any>(`/api/linguistic/${id}`),
  getLinguisticHistory: () => get<any[]>('/api/linguistic/history'),
  updateLinguisticSequence: (id: string, seqIdx: number, updates: any) =>
    patch<any>(`/api/linguistic/${id}/sequence/${seqIdx}`, updates),
  updateLinguisticLeader: (id: string, leader: string) =>
    patch<any>(`/api/linguistic/${id}/leader`, { leader }),
  renameLinguisticSpeaker: (id: string, oldName: string, newName: string) =>
    patch<any>(`/api/linguistic/${id}/rename-speaker`, { oldName, newName }),
  deleteLinguistic: (id: string) => del(`/api/linguistic/${id}`),
  getLinguisticExportUrl: (id: string, format: 'json' | 'csv') => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/linguistic/${id}/export?format=${format}${token ? `&token=${token}` : ''}`
  },
  getLinguisticAudioUrl: (id: string, filename: string) => {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
    return `${API_BASE}/api/linguistic/${id}/audio/${filename}${token ? `?token=${token}` : ''}`
  },

  // ── Événements WebSocket : Linguistique ──
  onLinguisticProgress: (cb: (data: any) => void) => onWsEvent('linguistic:progress', cb),
  onLinguisticComplete: (cb: (data: any) => void) => onWsEvent('linguistic:complete', cb),

  // ── ALF (Atlas Linguistique de la France) ──
  getAlfStats: () => get<{ available: boolean; points: number; cartes: number; phrases: number; realisations: number }>('/api/alf/stats'),
  getAlfPoints: () => get<{ available: boolean; points: import('./types').AlfPoint[] }>('/api/alf/points'),
  searchAlfPoints: (q: string) => get<{ points: import('./types').AlfPoint[] }>(`/api/alf/points/search?q=${encodeURIComponent(q)}`),
  findNearestAlfPoints: (lat: number, lng: number, limit = 5) =>
    get<{ points: import('./types').AlfPoint[] }>(`/api/alf/points/nearest?lat=${lat}&lng=${lng}&limit=${limit}`),
  searchAlfCartes: (q: string) =>
    get<{ cartes: import('./types').AlfCarte[] }>(`/api/alf/cartes/search?q=${encodeURIComponent(q)}`),
  getAlfAttestations: (carteId: number, opts?: { dept?: string; langue?: string }) => {
    const params = new URLSearchParams()
    if (opts?.dept) params.set('dept', opts.dept)
    if (opts?.langue) params.set('langue', opts.langue)
    return get<{ attestations: import('./types').AlfAttestation[] }>(
      `/api/alf/cartes/${carteId}/attestations${params.toString() ? '?' + params.toString() : ''}`
    )
  },
  lookupAlf: (mot: string, pointId?: number) => {
    const params = new URLSearchParams({ mot })
    if (pointId !== undefined) params.set('pointId', String(pointId))
    return get<{ results: { carte: import('./types').AlfCarte; attestations: import('./types').AlfAttestation[] }[] }>(
      `/api/alf/lookup?${params.toString()}`
    )
  },
  convertIpaToRousselot: (ipa: string) =>
    get<{ rousselot: string }>(`/api/alf/convert?ipa=${encodeURIComponent(ipa)}`),
  convertRousselotToIpa: (rousselot: string) =>
    get<{ ipa: string }>(`/api/alf/convert?rousselot=${encodeURIComponent(rousselot)}`),

  // ── Atlas moderne (attestations validees) ──
  getAtlasStats: () => get<{ total: number; pointsCount: number; conceptsCount: number; recordings: number }>('/api/atlas/stats'),
  getAtlasAttestations: (opts?: { pointId?: number; carteId?: number; limit?: number }) => {
    const params = new URLSearchParams()
    if (opts?.pointId !== undefined) params.set('pointId', String(opts.pointId))
    if (opts?.carteId !== undefined) params.set('carteId', String(opts.carteId))
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return get<{ attestations: any[] }>(`/api/atlas/attestations${qs ? '?' + qs : ''}`)
  },
  validateLinguisticToAtlas: (linguisticId: string) =>
    post<{ success: boolean; count: number }>(`/api/atlas/validate/${linguisticId}`, {}),

  // ── Abonnement aux channels WebSocket par projet ──
  subscribeToProject,
  unsubscribeFromProject,

  // ── Documentation : ouvre la doc technique dans un nouvel onglet ──
  openDocumentation: () => { window.open('/docs/', '_blank') }
}

// Exposer l'API sur window.electron pour compatibilité avec l'ancienne architecture
;(window as any).electron = api

export default api

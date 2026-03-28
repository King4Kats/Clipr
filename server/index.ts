import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import multer from 'multer'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { join, basename, extname, resolve } from 'path'
import { existsSync, mkdirSync, createReadStream, statSync, readFileSync, writeFileSync } from 'fs'
import { execSync, exec } from 'child_process'
import { logger } from './logger.js'

import * as ffmpegService from './services/ffmpeg.js'
import * as whisperService from './services/whisper.js'
import * as ollamaService from './services/ollama.js'
import * as projectService from './services/project-history.js'
import * as authService from './services/auth.js'
import * as aiLockService from './services/ai-lock.js'
import * as sharingService from './services/sharing.js'
import { requireAuth, requireAdmin, optionalAuth } from './middleware/auth.js'

// ── Config ──
const PORT = parseInt(process.env.PORT || '3000')
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const UPLOAD_DIR = join(DATA_DIR, 'uploads')
const EXPORT_DIR = join(DATA_DIR, 'exports')

for (const dir of [DATA_DIR, UPLOAD_DIR, EXPORT_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── Express ──
const app = express()
const server = createServer(app)

// CORS: restrict to same origin in production
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(',') || []
app.use(cors(ALLOWED_ORIGINS.length > 0 ? { origin: ALLOWED_ORIGINS } : undefined))
app.use(express.json({ limit: '10mb' }))

// Rate limiting on auth routes
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Trop de tentatives, réessayez dans 15 minutes' } })

// ── Path safety helper ──
function safePath(base: string, userPath: string): string | null {
  const resolved = resolve(base, userPath)
  if (!resolved.startsWith(resolve(base))) return null
  return resolved
}

// Servir le frontend build
const distPath = join(__dirname, '..', 'dist')
if (existsSync(distPath)) app.use(express.static(distPath))

// Servir la doc
const docsPath = join(__dirname, '..', 'docs')
if (existsSync(docsPath)) app.use('/docs', express.static(docsPath))

// ── WebSocket (project-scoped channels) ──
const wss = new WebSocketServer({ server, path: '/ws' })

interface WsClient {
  ws: WebSocket
  projectId: string | null
  userId: string | null
}

const clients = new Set<WsClient>()

wss.on('connection', (ws) => {
  const client: WsClient = { ws, projectId: null, userId: null }
  clients.add(client)

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      // Authenticate WebSocket with JWT token
      if (msg.type === 'auth' && msg.token) {
        try {
          const payload = authService.verifyToken(msg.token)
          client.userId = payload.userId
        } catch {
          ws.send(JSON.stringify({ type: 'auth:error', message: 'Token invalide' }))
        }
      }
      // Subscribe to project channel (requires auth)
      if (msg.type === 'subscribe' && msg.projectId && client.userId) {
        client.projectId = msg.projectId
      }
      if (msg.type === 'unsubscribe') {
        client.projectId = null
      }
    } catch {}
  })

  ws.on('close', () => clients.delete(client))
})

// Broadcast to ALL clients (legacy / global events)
function broadcast(type: string, data: any) {
  const msg = JSON.stringify({ type, ...data })
  clients.forEach(c => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg) })
}

// Broadcast to clients subscribed to a specific project
function broadcastToProject(projectId: string, type: string, data: any) {
  const msg = JSON.stringify({ type, projectId, ...data })
  clients.forEach(c => {
    if (c.ws.readyState === WebSocket.OPEN && c.projectId === projectId) {
      c.ws.send(msg)
    }
  })
}

// ── Upload (multer) with file type validation ──
const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/webm', 'video/mp2t']
const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mts']

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, `${Date.now()}_${safeName}`)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB max
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase()
    if (ALLOWED_VIDEO_MIMES.includes(file.mimetype) || ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('Type de fichier non autorisé. Formats acceptés: MP4, MOV, AVI, MKV, WebM, MTS'))
    }
  }
})

// ── Routes API ──

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: Date.now() }))

// ── Auth (rate-limited) ──
app.post('/api/auth/register', authLimiter, (req, res) => {
  try {
    const { username, email, password } = req.body
    const result = authService.register(username, email, password)
    res.json(result)
  } catch (err: any) { res.status(400).json({ error: err.message }) }
})

app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    const { login, password } = req.body
    const result = authService.login(login, password)
    res.json(result)
  } catch (err: any) { res.status(401).json({ error: err.message }) }
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = authService.getUserById(req.user!.userId)
  if (user) res.json(user)
  else res.status(404).json({ error: 'Utilisateur non trouvé' })
})

// Admin: list all users
app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json(authService.listUsers())
})

// Admin: list all projects
app.get('/api/admin/projects', requireAuth, requireAdmin, (_req, res) => {
  res.json(projectService.getAllProjects())
})

// Admin: system health (disk, services, AI lock)
app.get('/api/admin/system', requireAuth, requireAdmin, async (_req, res) => {
  const ollamaOk = await ollamaService.checkOllama()
  const ffmpegOk = await ffmpegService.checkFFmpeg()
  const lock = aiLockService.getActiveLock()

  let diskInfo = { total: 0, used: 0, free: 0 }
  try {
    const df = execSync('df -B1 ' + JSON.stringify(DATA_DIR)).toString().trim().split('\n').pop()!.split(/\s+/)
    diskInfo = { total: parseInt(df[1]) || 0, used: parseInt(df[2]) || 0, free: parseInt(df[3]) || 0 }
  } catch { /* ignore */ }

  const db = require('./services/database.js').getDb()
  const projectCount = (db.prepare('SELECT COUNT(*) as cnt FROM projects WHERE deleted_at IS NULL').get() as any).cnt
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any).cnt

  res.json({
    services: { ollama: ollamaOk, ffmpeg: ffmpegOk },
    aiLock: lock,
    disk: diskInfo,
    counts: { projects: projectCount, users: userCount }
  })
})

// Admin: recent logs (last N lines)
app.get('/api/admin/logs', requireAuth, requireAdmin, (req, res) => {
  try {
    const lines = parseInt(req.query.lines as string) || 100
    const content = readFileSync(logger.logFile, 'utf-8')
    const allLines = content.split('\n').filter(l => l.trim())
    const recent = allLines.slice(-lines)
    res.json({ lines: recent, total: allLines.length })
  } catch {
    res.json({ lines: [], total: 0 })
  }
})

// AI Lock status — any authenticated user can check
app.get('/api/ai/status', requireAuth, (_req, res) => {
  const lock = aiLockService.getActiveLock()
  res.json({ locked: !!lock, lock })
})

// Version
app.get('/api/version', (_req, res) => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    res.json({ version: pkg.version })
  } catch { res.json({ version: 'unknown' }) }
})

// Upload video (auth required)
app.post('/api/upload', requireAuth, upload.array('videos', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[]
    if (!files || files.length === 0) return res.status(400).json({ error: 'Aucun fichier' })

    const results = []
    for (const file of files) {
      const duration = await ffmpegService.getVideoDuration(file.path)
      results.push({ id: file.filename, path: file.path, name: file.originalname, duration, size: file.size })
    }
    res.json(results)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Stream video/audio files (token via query param for <video> tags)
app.get('/api/files/:filename', (req, res) => {
  // Auth via header OR query param (needed for <video src="...?token=xxx">)
  const token = req.headers.authorization?.slice(7) || (req.query.token as string)
  if (!token) return res.status(401).json({ error: 'Authentification requise' })
  try { authService.verifyToken(token) } catch { return res.status(401).json({ error: 'Token invalide' }) }

  const filePath = safePath(UPLOAD_DIR, req.params.filename)
  if (!filePath || !existsSync(filePath)) return res.status(404).json({ error: 'Fichier non trouve' })

  const stat = statSync(filePath)
  const ext = extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mts': 'video/mp2t',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg'
  }

  const range = req.headers.range
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
    const chunkSize = end - start + 1

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeTypes[ext] || 'application/octet-stream'
    })
    createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': mimeTypes[ext] || 'application/octet-stream'
    })
    createReadStream(filePath).pipe(res)
  }
})

// Serve temp/data files (token via query param for media tags)
app.get('/api/data-files/*', (req, res) => {
  const token = req.headers.authorization?.slice(7) || (req.query.token as string)
  if (!token) return res.status(401).json({ error: 'Authentification requise' })
  try { authService.verifyToken(token) } catch { return res.status(401).json({ error: 'Token invalide' }) }

  const relativePath = (req.params as any)[0] as string
  const filePath = safePath(DATA_DIR, relativePath)
  if (!filePath || !existsSync(filePath)) return res.status(404).json({ error: 'Not found' })

  const stat = statSync(filePath)
  const ext = extname(filePath).toLowerCase()
  const mime = ext === '.wav' ? 'audio/wav' : ext === '.mp4' ? 'video/mp4' : 'application/octet-stream'
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime })
  createReadStream(filePath).pipe(res)
})

// FFmpeg duration (auth required)
app.post('/api/ffmpeg/duration', requireAuth, async (req, res) => {
  try {
    const duration = await ffmpegService.getVideoDuration(req.body.videoPath)
    res.json({ duration })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// FFmpeg extract audio (auth required)
app.post('/api/ffmpeg/extract-audio', requireAuth, async (req, res) => {
  try {
    const audioPath = await ffmpegService.extractAudio(req.body.videoPath, (percent) => {
      broadcast('progress', { progress: percent * 0.3, message: 'Extraction audio...' })
    })
    res.json({ audioPath })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// FFmpeg cut (auth required)
app.post('/api/ffmpeg/cut', requireAuth, async (req, res) => {
  try {
    const { input, start, end, output } = req.body
    await ffmpegService.cutVideo(input, start, end, output)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// FFmpeg concatenate (auth required)
app.post('/api/ffmpeg/concatenate', requireAuth, async (req, res) => {
  try {
    await ffmpegService.concatenateVideos(req.body.inputPaths, req.body.output)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Export segment(s) as video (auth required)
app.post('/api/export/segment', requireAuth, async (req, res) => {
  try {
    const { clips, title, index } = req.body
    const safeTitle = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').substring(0, 50)
    const outputPath = join(EXPORT_DIR, `${String(index + 1).padStart(2, '0')}_${safeTitle}.mp4`)

    if (clips.length === 1) {
      await ffmpegService.cutVideo(clips[0].videoPath, clips[0].start, clips[0].end, outputPath)
    } else {
      const tempDir = ffmpegService.getTempDir()
      const tempFiles: string[] = []
      for (let j = 0; j < clips.length; j++) {
        const tempPath = join(tempDir, `temp_clip_${index}_${j}_${Date.now()}.mp4`)
        tempFiles.push(tempPath)
        await ffmpegService.cutVideo(clips[j].videoPath, clips[j].start, clips[j].end, tempPath)
      }
      await ffmpegService.concatenateVideos(tempFiles, outputPath)
    }

    const filename = basename(outputPath)
    res.json({ success: true, filename, downloadUrl: `/api/export/download/${filename}` })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Download exported file (token via query param or header)
app.get('/api/export/download/:filename', (req, res) => {
  const token = req.headers.authorization?.slice(7) || (req.query.token as string)
  if (!token) return res.status(401).json({ error: 'Authentification requise' })
  try { authService.verifyToken(token) } catch { return res.status(401).json({ error: 'Token invalide' }) }
  const filePath = safePath(EXPORT_DIR, req.params.filename)
  if (!filePath || !existsSync(filePath)) return res.status(404).json({ error: 'Fichier non trouve' })
  res.download(filePath)
})

// Export text (auth required, path-safe)
app.post('/api/export/text', requireAuth, (req, res) => {
  try {
    const { content, filename } = req.body
    const safeFilename = basename(filename) // Strip any path components
    const filePath = safePath(EXPORT_DIR, safeFilename)
    if (!filePath) return res.status(400).json({ error: 'Nom de fichier invalide' })
    writeFileSync(filePath, content, 'utf-8')
    res.json({ success: true, downloadUrl: `/api/export/download/${safeFilename}` })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Whisper transcribe (auth required)
app.post('/api/whisper/transcribe', requireAuth, async (req, res) => {
  try {
    const { audioPath, language, model, initialPrompt } = req.body
    if (model) await whisperService.loadWhisperModel(model)
    const segments = await whisperService.transcribe(
      audioPath, language,
      (segment) => broadcast('transcript:segment', segment),
      (percent) => broadcast('progress', { progress: percent, message: 'Transcription...' }),
      initialPrompt
    )
    res.json({ segments })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Whisper cancel (auth required)
app.post('/api/whisper/cancel', requireAuth, (_req, res) => {
  whisperService.cancelTranscription()
  res.json({ success: true })
})

// Ollama check (auth required)
app.get('/api/ollama/check', requireAuth, async (_req, res) => {
  const running = await ollamaService.checkOllama()
  res.json({ running })
})

// Ollama models (auth required)
app.get('/api/ollama/models', requireAuth, async (_req, res) => {
  const models = await ollamaService.listOllamaModels()
  res.json({ models })
})

// Ollama pull (auth required)
app.post('/api/ollama/pull', requireAuth, async (req, res) => {
  try {
    const success = await ollamaService.pullOllamaModel(req.body.model)
    res.json({ success, message: success ? 'Modele telecharge' : 'Echec du telechargement' })
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }) }
})

// Ollama analyze (auth required)
app.post('/api/ollama/analyze', requireAuth, async (req, res) => {
  try {
    const { transcript, context, model } = req.body
    const result = await ollamaService.analyzeTranscript(transcript, context, model, (ci, tc, sf, msg) => {
      broadcast('progress', { progress: 60 + (ci / tc) * 40, message: msg || 'Analyse...' })
    })
    res.json(result)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project list (active projects, max 6) — auth-protected
app.get('/api/project/history', requireAuth, (req, res) => {
  res.json(projectService.getProjectHistory(req.user!.userId))
})

// Project create
app.post('/api/project/create', requireAuth, (req, res) => {
  try {
    const { name, type } = req.body
    const project = projectService.createProject(name || 'Projet Sans Nom', type || 'manual', req.user!.userId)
    res.json(project)
  } catch (err: any) { res.status(400).json({ error: err.message }) }
})

// Project save (with ownership check)
app.post('/api/project/save', requireAuth, (req, res) => {
  try {
    const { id, ...data } = req.body
    if (id) {
      // Verify ownership or editor access
      const { access, role } = sharingService.hasAccess(id, req.user!.userId)
      if (!access || role === 'viewer') return res.status(403).json({ error: 'Accès refusé' })
      projectService.saveProject(id, data)
      res.json({ success: true, id })
    } else {
      const newId = projectService.saveLegacyProject(data, req.user!.userId)
      res.json({ success: true, id: newId })
    }
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project auto-save (with ownership check)
app.post('/api/project/autosave', requireAuth, (req, res) => {
  try {
    const { id, ...data } = req.body
    if (id) {
      const { access, role } = sharingService.hasAccess(id, req.user!.userId)
      if (!access || role === 'viewer') return res.status(403).json({ error: 'Accès refusé' })
      projectService.autoSaveProject(id, data)
    } else {
      projectService.saveLegacyProject(data, req.user!.userId)
    }
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project load by id (owner or shared)
app.get('/api/project/load/:id', requireAuth, (req, res) => {
  const { access, role } = sharingService.hasAccess(req.params.id, req.user!.userId)
  if (!access) return res.status(404).json({ error: 'Projet non trouve' })

  const project = projectService.getProject(req.params.id)
  if (project) res.json({ ...project, accessRole: role })
  else res.status(404).json({ error: 'Projet non trouve' })
})

// Project rename (owner only)
app.patch('/api/project/:id/rename', requireAuth, (req, res) => {
  try {
    const project = projectService.getProject(req.params.id, req.user!.userId)
    if (!project) return res.status(404).json({ error: 'Projet non trouvé' })
    projectService.renameProject(req.params.id, req.body.name)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project delete — owner only
app.delete('/api/project/:id', requireAuth, (req, res) => {
  try {
    const project = projectService.getProject(req.params.id, req.user!.userId)
    if (!project) return res.status(404).json({ error: 'Projet non trouvé' })
    projectService.deleteProject(req.params.id)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project status update (owner only)
app.patch('/api/project/:id/status', requireAuth, (req, res) => {
  try {
    const project = projectService.getProject(req.params.id, req.user!.userId)
    if (!project) return res.status(404).json({ error: 'Projet non trouvé' })
    projectService.updateProjectStatus(req.params.id, req.body.status)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ── Sharing ──

// Share a project with a user
app.post('/api/project/:id/share', requireAuth, (req, res) => {
  try {
    const { username, role } = req.body
    const share = sharingService.shareProject(req.params.id, req.user!.userId, username, role || 'viewer')
    res.json(share)
  } catch (err: any) { res.status(400).json({ error: err.message }) }
})

// Remove a share
app.delete('/api/project/:id/share/:userId', requireAuth, (req, res) => {
  try {
    sharingService.unshareProject(req.params.id, req.user!.userId, req.params.userId)
    res.json({ success: true })
  } catch (err: any) { res.status(400).json({ error: err.message }) }
})

// List shares for a project
app.get('/api/project/:id/shares', requireAuth, (req, res) => {
  const shares = sharingService.getProjectShares(req.params.id)
  res.json(shares)
})

// Get projects shared with me
app.get('/api/project/shared', requireAuth, (req, res) => {
  res.json(sharingService.getSharedProjects(req.user!.userId))
})

// Search users for sharing autocomplete
app.get('/api/users/search', requireAuth, (req, res) => {
  const q = (req.query.q as string) || ''
  if (q.length < 2) return res.json([])
  res.json(sharingService.searchUsers(q, req.user!.userId))
})

// ── Server-side AI Analysis (background processing) ──
app.post('/api/project/:id/analyze', requireAuth, async (req, res) => {
  const projectId = req.params.id
  const userId = req.user!.userId
  const project = projectService.getProject(projectId, userId)
  if (!project) return res.status(404).json({ error: 'Projet non trouve' })

  const { config } = req.body
  const data = project.data

  if (!data.videoFiles || data.videoFiles.length === 0) {
    return res.status(400).json({ error: 'Aucune video dans le projet' })
  }

  // Try to acquire AI lock
  const lockResult = aiLockService.acquireLock(userId, projectId)
  if (!lockResult.success) {
    return res.status(423).json({ error: lockResult.error, lock: lockResult.lock })
  }

  // Respond immediately — analysis runs in background
  res.json({ success: true, message: 'Analyse lancee en arriere-plan' })

  // Mark project as processing
  projectService.updateProjectStatus(projectId, 'processing')

  // Background pipeline
  ;(async () => {
    try {
      const videoFiles = data.videoFiles
      const whisperModel = config?.whisperModel || 'large-v3'
      const whisperPrompt = config?.whisperPrompt || ''
      const ollamaModel = config?.ollamaModel || 'mistral-small:22b'
      const language = config?.language || 'fr'
      const context = config?.context || ''

      // 1. Extract audio
      broadcastToProject(projectId, 'progress', { step: 'extracting-audio', progress: 0, message: 'Extraction des pistes audio...' })
      const audioPaths: string[] = []

      for (let i = 0; i < videoFiles.length; i++) {
        const audioPath = await ffmpegService.extractAudio(videoFiles[i].path, (percent) => {
          broadcastToProject(projectId, 'progress', {
            step: 'extracting-audio',
            progress: ((i + percent / 100) / videoFiles.length) * 100,
            message: `Extraction audio ${i + 1}/${videoFiles.length}...`
          })
        })
        audioPaths.push(audioPath)
      }

      // Auto-save audio paths
      projectService.saveProject(projectId, { ...data, audioPaths, config })

      // 2. Transcribe
      broadcastToProject(projectId, 'progress', { step: 'transcribing', progress: 0, message: 'Transcription de la voix...' })

      await whisperService.loadWhisperModel(whisperModel)
      const allTranscriptSegments: any[] = []

      for (let i = 0; i < audioPaths.length; i++) {
        broadcastToProject(projectId, 'progress', {
          step: 'transcribing',
          progress: (i / audioPaths.length) * 100,
          message: `Transcription video ${i + 1}/${audioPaths.length}...`
        })

        const segments = await whisperService.transcribe(
          audioPaths[i], language,
          (segment) => {
            const offset = videoFiles[i]?.offset || 0
            const adjusted = { ...segment, start: segment.start + offset, end: segment.end + offset }
            broadcastToProject(projectId, 'transcript:segment', adjusted)
          },
          (percent) => {
            broadcastToProject(projectId, 'progress', {
              step: 'transcribing',
              progress: ((i + percent / 100) / audioPaths.length) * 100,
              message: `Transcription video ${i + 1}/${audioPaths.length}...`
            })
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
      broadcastToProject(projectId, 'progress', { step: 'analyzing', progress: 0, message: 'Decoupe intelligente par l\'IA...' })

      const fullText = allTranscriptSegments
        .map((t: any) => `[${t.start.toFixed(1)}s] ${t.text}`)
        .join('\n')

      const result = await ollamaService.analyzeTranscript(fullText, context, ollamaModel, (ci, tc, _sf, msg) => {
        broadcastToProject(projectId, 'progress', {
          step: 'analyzing',
          progress: (ci / tc) * 100,
          message: msg || 'Analyse thematique...'
        })
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

      broadcastToProject(projectId, 'analysis:complete', {
        step: 'done',
        progress: 100,
        message: 'Analyse terminee !',
        segments: finalSegments,
        transcript: allTranscriptSegments,
        audioPaths
      })

      logger.info(`[Analysis] Project ${projectId} completed: ${finalSegments.length} segments`)

      // Release AI lock
      aiLockService.releaseLockForProject(projectId)

    } catch (err: any) {
      logger.error(`[Analysis] Project ${projectId} failed:`, err)
      projectService.updateProjectStatus(projectId, 'draft')

      // Release AI lock on error
      aiLockService.releaseLockForProject(projectId)

      broadcastToProject(projectId, 'analysis:error', {
        step: 'error',
        progress: 0,
        message: `Echec: ${err.message}`
      })
    }
  })()
})

// Project export (auth required)
app.post('/api/project/export', requireAuth, (req, res) => {
  const filename = `projet-${new Date().toISOString().split('T')[0]}.json`
  const filePath = join(EXPORT_DIR, filename)
  writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf-8')
  res.json({ downloadUrl: `/api/export/download/${filename}` })
})

// Project import (auth required)
app.post('/api/project/import', requireAuth, upload.single('project'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' })
    const content = readFileSync(req.file.path, 'utf-8')
    const data = JSON.parse(content)
    res.json(data)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Setup dependencies check (auth required)
app.get('/api/setup/dependencies', requireAuth, async (_req, res) => {
  const deps = []

  // FFmpeg
  const ffmpegOk = await ffmpegService.checkFFmpeg()
  deps.push({ name: 'FFmpeg', installed: ffmpegOk, version: ffmpegOk ? 'Installe' : undefined })

  // Python + faster-whisper
  try {
    execSync('python3 -c "import faster_whisper"', { timeout: 10000 })
    deps.push({ name: 'Whisper (faster-whisper)', installed: true, version: 'Installe' })
  } catch {
    deps.push({ name: 'Whisper (faster-whisper)', installed: false })
  }

  // Ollama
  const ollamaOk = await ollamaService.checkOllama()
  deps.push({ name: 'Ollama', installed: ollamaOk, version: ollamaOk ? 'Actif' : undefined })

  res.json(deps)
})

// Logs export (admin only)
app.get('/api/logs/export', requireAuth, requireAdmin, (_req, res) => {
  if (existsSync(logger.logFile)) res.download(logger.logFile)
  else res.status(404).json({ error: 'Aucun log' })
})

// Update check (admin only)
app.get('/api/update/check', requireAuth, requireAdmin, (_req, res) => {
  try {
    const repoDir = existsSync('/repo/.git') ? '/repo' : process.cwd()
    execSync('git fetch origin', { cwd: repoDir, timeout: 30000 })
    const local = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim()
    const remote = execSync('git rev-parse origin/main', { cwd: repoDir }).toString().trim()

    if (local === remote) {
      res.json({ available: false, message: 'A jour' })
    } else {
      const log = execSync(`git log --oneline ${local}..${remote}`, { cwd: repoDir }).toString().trim()
      const commits = log.split('\n').filter(l => l.trim())
      res.json({ available: true, commits: commits.length, details: commits })
    }
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Update apply (admin only)
app.post('/api/update', requireAuth, requireAdmin, (_req, res) => {
  res.json({ success: true, message: 'Mise a jour en cours...' })

  const repoDir = existsSync('/repo/.git') ? '/repo' : process.cwd()
  setTimeout(() => {
    exec(`cd ${repoDir} && git pull origin main && docker compose up -d --build`, (err) => {
      if (err) logger.error('Update error:', err)
      else logger.info('Update: rebuild lance')
    })
  }, 500)
})

// Fallback SPA
app.get('*', (_req, res) => {
  const indexPath = join(distPath, 'index.html')
  if (existsSync(indexPath)) res.sendFile(indexPath)
  else res.status(404).json({ error: 'Not found' })
})

// ── Start ──
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Clipr server running on port ${PORT}`)
  logger.info(`Data directory: ${DATA_DIR}`)
})

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import multer from 'multer'
import cors from 'cors'
import { join, basename, extname } from 'path'
import { existsSync, mkdirSync, createReadStream, statSync, readFileSync, writeFileSync } from 'fs'
import { execSync, exec } from 'child_process'
import { logger } from './logger.js'

import * as ffmpegService from './services/ffmpeg.js'
import * as whisperService from './services/whisper.js'
import * as ollamaService from './services/ollama.js'
import * as projectService from './services/project-history.js'
import * as authService from './services/auth.js'
import * as aiLockService from './services/ai-lock.js'
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

app.use(cors())
app.use(express.json({ limit: '50mb' }))

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
}

const clients = new Set<WsClient>()

wss.on('connection', (ws) => {
  const client: WsClient = { ws, projectId: null }
  clients.add(client)

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      // Client subscribes to a project channel: { type: 'subscribe', projectId: '...' }
      if (msg.type === 'subscribe' && msg.projectId) {
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

// ── Upload (multer) ──
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
})
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } }) // 10GB max

// ── Routes API ──

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: Date.now() }))

// ── Auth ──
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, email, password } = req.body
    const result = authService.register(username, email, password)
    res.json(result)
  } catch (err: any) { res.status(400).json({ error: err.message }) }
})

app.post('/api/auth/login', (req, res) => {
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

// Upload video
app.post('/api/upload', upload.array('videos', 20), async (req, res) => {
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

// Stream video/audio files
app.get('/api/files/:filename', (req, res) => {
  const filePath = join(UPLOAD_DIR, req.params.filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Fichier non trouve' })

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

// Serve temp/data files (audio extracts etc.)
app.get('/api/data-files/*', (req, res) => {
  const relativePath = req.params[0]
  const filePath = join(DATA_DIR, relativePath)
  if (!existsSync(filePath) || !filePath.startsWith(DATA_DIR)) return res.status(404).json({ error: 'Not found' })

  const stat = statSync(filePath)
  const ext = extname(filePath).toLowerCase()
  const mime = ext === '.wav' ? 'audio/wav' : ext === '.mp4' ? 'video/mp4' : 'application/octet-stream'
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime })
  createReadStream(filePath).pipe(res)
})

// FFmpeg duration
app.post('/api/ffmpeg/duration', async (req, res) => {
  try {
    const duration = await ffmpegService.getVideoDuration(req.body.videoPath)
    res.json({ duration })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// FFmpeg extract audio
app.post('/api/ffmpeg/extract-audio', async (req, res) => {
  try {
    const audioPath = await ffmpegService.extractAudio(req.body.videoPath, (percent) => {
      broadcast('progress', { progress: percent * 0.3, message: 'Extraction audio...' })
    })
    res.json({ audioPath })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// FFmpeg cut
app.post('/api/ffmpeg/cut', async (req, res) => {
  try {
    const { input, start, end, output } = req.body
    await ffmpegService.cutVideo(input, start, end, output)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// FFmpeg concatenate
app.post('/api/ffmpeg/concatenate', async (req, res) => {
  try {
    await ffmpegService.concatenateVideos(req.body.inputPaths, req.body.output)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Export segment(s) as video
app.post('/api/export/segment', async (req, res) => {
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

// Download exported file
app.get('/api/export/download/:filename', (req, res) => {
  const filePath = join(EXPORT_DIR, req.params.filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Fichier non trouve' })
  res.download(filePath)
})

// Export text
app.post('/api/export/text', (req, res) => {
  try {
    const { content, filename } = req.body
    const filePath = join(EXPORT_DIR, filename)
    writeFileSync(filePath, content, 'utf-8')
    res.json({ success: true, downloadUrl: `/api/export/download/${filename}` })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Whisper transcribe
app.post('/api/whisper/transcribe', async (req, res) => {
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

// Whisper cancel
app.post('/api/whisper/cancel', (_req, res) => {
  whisperService.cancelTranscription()
  res.json({ success: true })
})

// Ollama check
app.get('/api/ollama/check', async (_req, res) => {
  const running = await ollamaService.checkOllama()
  res.json({ running })
})

// Ollama models
app.get('/api/ollama/models', async (_req, res) => {
  const models = await ollamaService.listOllamaModels()
  res.json({ models })
})

// Ollama pull
app.post('/api/ollama/pull', async (req, res) => {
  try {
    const success = await ollamaService.pullOllamaModel(req.body.model)
    res.json({ success, message: success ? 'Modele telecharge' : 'Echec du telechargement' })
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }) }
})

// Ollama analyze
app.post('/api/ollama/analyze', async (req, res) => {
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

// Project save (with id)
app.post('/api/project/save', requireAuth, (req, res) => {
  try {
    const { id, ...data } = req.body
    if (id) {
      projectService.saveProject(id, data)
      res.json({ success: true, id })
    } else {
      const newId = projectService.saveLegacyProject(data, req.user!.userId)
      res.json({ success: true, id: newId })
    }
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project auto-save
app.post('/api/project/autosave', requireAuth, (req, res) => {
  try {
    const { id, ...data } = req.body
    if (id) {
      projectService.autoSaveProject(id, data)
    } else {
      projectService.saveLegacyProject(data, req.user!.userId)
    }
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project load by id
app.get('/api/project/load/:id', requireAuth, (req, res) => {
  const project = projectService.getProject(req.params.id, req.user!.userId)
  if (project) res.json(project)
  else res.status(404).json({ error: 'Projet non trouve' })
})

// Project rename
app.patch('/api/project/:id/rename', requireAuth, (req, res) => {
  try {
    projectService.renameProject(req.params.id, req.body.name)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project delete (soft)
app.delete('/api/project/:id', requireAuth, (req, res) => {
  try {
    projectService.deleteProject(req.params.id)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Project status update
app.patch('/api/project/:id/status', requireAuth, (req, res) => {
  try {
    projectService.updateProjectStatus(req.params.id, req.body.status)
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
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

// Project export (download JSON)
app.post('/api/project/export', (req, res) => {
  const filename = `projet-${new Date().toISOString().split('T')[0]}.json`
  const filePath = join(EXPORT_DIR, filename)
  writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf-8')
  res.json({ downloadUrl: `/api/export/download/${filename}` })
})

// Project import (upload JSON)
app.post('/api/project/import', upload.single('project'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' })
    const content = readFileSync(req.file.path, 'utf-8')
    const data = JSON.parse(content)
    res.json(data)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Setup dependencies check
app.get('/api/setup/dependencies', async (_req, res) => {
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

// Logs export
app.get('/api/logs/export', (_req, res) => {
  if (existsSync(logger.logFile)) res.download(logger.logFile)
  else res.status(404).json({ error: 'Aucun log' })
})

// Update check
app.get('/api/update/check', (_req, res) => {
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

// Update apply
app.post('/api/update', (_req, res) => {
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

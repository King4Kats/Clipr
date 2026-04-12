/**
 * =============================================================================
 * Fichier : server/index.ts
 * Rôle    : Point d'entrée du serveur Express — le "chef d'orchestre" backend.
 *
 *           Ce fichier fait TOUT le câblage de l'application côté serveur :
 *           - Configure Express (middlewares, CORS, rate limiting, upload)
 *           - Crée le serveur HTTP et le WebSocket (temps réel)
 *           - Définit TOUTES les routes API REST (auth, projets, upload,
 *             FFmpeg, Whisper, Ollama, transcription, partage, admin, etc.)
 *           - Initialise la file d'attente des tâches IA
 *           - Sert le frontend build (fichiers statiques) et la documentation
 *
 *           C'est un gros fichier parce qu'il centralise toutes les routes.
 *           La logique métier est déléguée aux services (./services/*.ts).
 * =============================================================================
 */

// ── Imports des bibliothèques ──
import express from 'express'                          // Framework web HTTP
import { createServer } from 'http'                    // Serveur HTTP natif Node.js
import { WebSocketServer, WebSocket } from 'ws'        // WebSocket pour le temps réel
import multer from 'multer'                            // Gestion des uploads de fichiers
import cors from 'cors'                                // Cross-Origin Resource Sharing
import rateLimit from 'express-rate-limit'             // Protection contre le spam de requêtes
import { join, basename, extname, resolve } from 'path' // Manipulation de chemins de fichiers
import { existsSync, mkdirSync, createReadStream, createWriteStream, statSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, unlinkSync } from 'fs'
import { execSync, exec } from 'child_process'         // Exécution de commandes système
import { logger } from './logger.js'                   // Système de log (console + fichier)

// ── Imports des services métier (chaque service gère une responsabilité) ──
import * as ffmpegService from './services/ffmpeg.js'
import * as whisperService from './services/whisper.js'
import * as ollamaService from './services/ollama.js'
import * as projectService from './services/project-history.js'
import * as authService from './services/auth.js'
import * as aiLockService from './services/ai-lock.js'
import * as sharingService from './services/sharing.js'
import * as taskQueueService from './services/task-queue.js'
import { runAnalysisPipeline } from './services/analysis-pipeline.js'
import { runTranscriptionPipeline, getTranscription, getTranscriptionHistory, deleteTranscription, exportAsText, exportAsSrt } from './services/transcription-pipeline.js'
import { runLinguisticPipeline, getLinguisticTranscription, getLinguisticHistory, deleteLinguisticTranscription, updateLinguisticSequence, updateLinguisticLeader, renameLinguisticSpeaker, exportLinguistic } from './services/linguistic-pipeline.js'
import { getDb } from './services/database.js'
import { requireAuth, requireAdmin, optionalAuth } from './middleware/auth.js'

// ══════════════════════════════════════════════════════════════════════════════
// ── CONFIGURATION : Dossiers de données et port du serveur ──
// ══════════════════════════════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT || '3000')
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')  // Dossier racine des données
const UPLOAD_DIR = join(DATA_DIR, 'uploads')   // Fichiers vidéo/audio uploadés
const EXPORT_DIR = join(DATA_DIR, 'exports')   // Fichiers exportés (clips vidéo, texte)
const CHUNK_DIR = join(DATA_DIR, 'chunks')     // Morceaux temporaires (chunked upload)

// Créer les dossiers s'ils n'existent pas
for (const dir of [DATA_DIR, UPLOAD_DIR, EXPORT_DIR, CHUNK_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ══════════════════════════════════════════════════════════════════════════════
// ── INITIALISATION EXPRESS : Serveur HTTP et middlewares ──
// ══════════════════════════════════════════════════════════════════════════════
const app = express()
app.set('trust proxy', true)  // Nécessaire derrière un reverse proxy (Caddy, Nginx)
const server = createServer(app)

// CORS : autoriser les requêtes cross-origin (utile en développement)
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(',') || []
app.use(cors(ALLOWED_ORIGINS.length > 0 ? { origin: ALLOWED_ORIGINS } : undefined))

// Parser JSON avec une limite de 10 Mo (pour les transcriptions volumineuses)
app.use(express.json({ limit: '10mb' }))

// Forcer l'encodage UTF-8 sur toutes les réponses JSON
// (évite les problèmes d'accents dans les noms de fichiers français)
app.use((_req, res, next) => {
  const originalJson = res.json.bind(res)
  res.json = (body: any) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    return originalJson(body)
  }
  next()
})

// Protection anti-spam : max 10 tentatives de login/register par 15 minutes
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Trop de tentatives, réessayez dans 15 minutes' }, validate: { trustProxy: false } })

/**
 * Vérifie qu'un chemin fourni par l'utilisateur ne sort pas du dossier autorisé.
 * Protection contre les attaques de type "path traversal" (ex: ../../etc/passwd)
 */
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

// ══════════════════════════════════════════════════════════════════════════════
// ── WEBSOCKET : Communication temps réel avec les clients ──
// Chaque client peut s'abonner à un "channel" projet pour recevoir
// uniquement les événements qui le concernent (progression, résultats, etc.)
// ══════════════════════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server, path: '/ws' })

/** Représente un client WebSocket connecté avec son contexte */
interface WsClient {
  ws: WebSocket
  projectId: string | null  // Le projet qu'il écoute (null = aucun)
  userId: string | null      // L'utilisateur authentifié (null = pas encore auth)
}

// Ensemble de tous les clients WebSocket connectés
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
        // Si le projet est terminé, envoyer les résultats immédiatement au client
        const record = projectService.getProject(msg.projectId)
        if (record && record.status === 'done' && record.data?.segments?.length > 0) {
          ws.send(JSON.stringify({
            type: 'analysis:complete',
            projectId: msg.projectId,
            segments: record.data.segments,
            transcript: record.data.transcript || [],
            audioPaths: record.data.audioPaths || []
          }))
        }
      }
      if (msg.type === 'unsubscribe') {
        client.projectId = null
      }
    } catch {}
  })

  ws.on('close', () => clients.delete(client))
})

/** Diffuse un message à TOUS les clients connectés (événements globaux) */
function broadcast(type: string, data: any) {
  const msg = JSON.stringify({ type, ...data })
  clients.forEach(c => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg) })
}

/** Diffuse un message uniquement aux clients abonnés à un projet spécifique */
function broadcastToProject(projectId: string, type: string, data: any) {
  const msg = JSON.stringify({ type, projectId, ...data })
  clients.forEach(c => {
    if (c.ws.readyState === WebSocket.OPEN && c.projectId === projectId) {
      c.ws.send(msg)
    }
  })
}

/** Diffuse un message à un utilisateur spécifique (tous ses onglets/appareils) */
function broadcastToUser(userId: string, type: string, data: any) {
  const msg = JSON.stringify({ type, ...data })
  clients.forEach(c => {
    if (c.ws.readyState === WebSocket.OPEN && c.userId === userId) {
      c.ws.send(msg)
    }
  })
}

/**
 * Broadcast unifié pour la file d'attente IA :
 * - Les événements liés à un projet (progress, analyse) → envoyés au channel projet
 * - Les événements globaux (queue update) → envoyés à l'utilisateur
 */
function queueBroadcast(userId: string, projectId: string | null, type: string, data: any) {
  if (projectId && (type === 'progress' || type === 'transcript:segment' || type === 'analysis:complete' || type === 'analysis:error')) {
    broadcastToProject(projectId, type, data)
  } else {
    broadcastToUser(userId, type, data)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── UPLOAD : Configuration de Multer pour la gestion des fichiers ──
// Multer est un middleware Express qui gère les uploads multipart/form-data.
// On configure les types de fichiers acceptés et la taille max (5 Go).
// ══════════════════════════════════════════════════════════════════════════════
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

// ── Media upload (audio + video) for standalone transcription ──
const ALLOWED_AUDIO_MIMES = ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/ogg', 'audio/x-m4a', 'audio/aac', 'audio/mp4']
const ALLOWED_AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac']
const ALL_MEDIA_MIMES = [...ALLOWED_VIDEO_MIMES, ...ALLOWED_AUDIO_MIMES]
const ALL_MEDIA_EXTENSIONS = [...ALLOWED_EXTENSIONS, ...ALLOWED_AUDIO_EXTENSIONS]

const mediaUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase()
    if (ALL_MEDIA_MIMES.includes(file.mimetype) || ALL_MEDIA_EXTENSIONS.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('Type de fichier non autorisé. Formats acceptés: MP4, MOV, AVI, MKV, WebM, MTS, WAV, MP3, FLAC, OGG, M4A, AAC'))
    }
  }
})

// ── Upload par morceaux (chunked) pour les gros fichiers ──
// Nécessaire pour passer la limite de 100 Mo de Cloudflare Tunnel
const chunkStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CHUNK_DIR),
  filename: (_req, _file, cb) => cb(null, `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
})
const chunkUpload = multer({ storage: chunkStorage, limits: { fileSize: 100 * 1024 * 1024 } })

async function assembleChunks(chunkDir: string, outputPath: string, totalChunks: number): Promise<void> {
  const ws = createWriteStream(outputPath)
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = join(chunkDir, `chunk_${i.toString().padStart(5, '0')}`)
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(chunkPath)
      rs.pipe(ws, { end: false })
      rs.on('end', resolve)
      rs.on('error', reject)
    })
  }
  ws.end()
  await new Promise<void>((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject) })
}

function cleanStaleChunks() {
  try {
    const now = Date.now()
    for (const name of readdirSync(CHUNK_DIR)) {
      const dir = join(CHUNK_DIR, name)
      try {
        const st = statSync(dir)
        if (st.isDirectory() && now - st.mtimeMs > 3600_000) {
          rmSync(dir, { recursive: true, force: true })
          logger.info(`Cleaned stale chunk dir: ${name}`)
        }
      } catch {}
    }
  } catch {}
}
cleanStaleChunks()
setInterval(cleanStaleChunks, 30 * 60_000)

// ── Remux : Convertir les formats non compatibles navigateur (MTS) en MP4 ──
// Les caméras pro génèrent souvent du MTS, que les navigateurs ne lisent pas
const NEEDS_REMUX = ['.mts']
async function remuxToMp4(inputPath: string): Promise<{ path: string, filename: string }> {
  const ext = extname(inputPath).toLowerCase()
  if (!NEEDS_REMUX.includes(ext)) return { path: inputPath, filename: basename(inputPath) }

  const mp4Name = basename(inputPath, ext) + '.mp4'
  const mp4Path = join(UPLOAD_DIR, mp4Name)
  await new Promise<void>((resolve, reject) => {
    exec(`ffmpeg -i "${inputPath}" -c copy -movflags +faststart "${mp4Path}"`, (err) => {
      if (err) reject(new Error(`Remux failed: ${err.message}`))
      else resolve()
    })
  })
  // Remove original MTS file
  try { unlinkSync(inputPath) } catch {}
  return { path: mp4Path, filename: mp4Name }
}

// ── Initialisation de la file d'attente IA ──
// On enregistre les 3 types de pipelines (analyse, transcription, linguistique)
// et la fonction de broadcast pour envoyer la progression aux clients
taskQueueService.initQueue(
  {
    analysis: runAnalysisPipeline,
    transcription: runTranscriptionPipeline,
    linguistic: runLinguisticPipeline
  },
  queueBroadcast
)

// ══════════════════════════════════════════════════════════════════════════════
// ── ROUTES API REST ──
// Toutes les routes de l'application sont définies ci-dessous.
// Chaque route délègue la logique aux services (auth, project, ffmpeg, etc.)
// ══════════════════════════════════════════════════════════════════════════════

// Vérification que le serveur tourne (utile pour les health checks Docker)
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: Date.now() }))

// ── Authentification (protégée par rate limiting) ──
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

// AI Lock status — now returns queue info for backward compatibility
app.get('/api/ai/status', requireAuth, (req, res) => {
  const queue = taskQueueService.getQueueState(req.user!.userId)
  const isLocked = !!queue.currentTask
  res.json({ locked: isLocked, lock: queue.currentTask, queue })
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
      // Remux MTS to MP4 for browser compatibility
      const { path: filePath, filename: fileId } = await remuxToMp4(file.path)
      const duration = await ffmpegService.getVideoDuration(filePath)
      // Multer decodes originalname as latin1 — re-encode to UTF-8 for accented characters
      const name = Buffer.from(file.originalname, 'latin1').toString('utf-8')
        .replace(/\.mts$/i, '.mp4')
      const size = statSync(filePath).size
      results.push({ id: fileId, path: filePath, name, duration, size })
    }
    res.json(results)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Chunked upload: receive a single chunk
app.post('/api/upload/chunk', requireAuth, chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks } = req.body
    if (!uploadId || !/^\d+_[a-z0-9]+$/.test(uploadId)) return res.status(400).json({ error: 'uploadId invalide' })
    const idx = parseInt(chunkIndex, 10)
    const total = parseInt(totalChunks, 10)
    if (isNaN(idx) || isNaN(total) || idx < 0 || idx >= total) return res.status(400).json({ error: 'chunkIndex invalide' })

    const chunkDir = join(CHUNK_DIR, uploadId)
    if (!existsSync(chunkDir)) mkdirSync(chunkDir, { recursive: true })

    const file = req.file as Express.Multer.File
    if (!file) return res.status(400).json({ error: 'Aucun chunk' })

    renameSync(file.path, join(chunkDir, `chunk_${idx.toString().padStart(5, '0')}`))
    res.json({ ok: true, chunkIndex: idx })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Chunked upload: assemble all chunks into final file
app.post('/api/upload/chunk/complete', requireAuth, express.json(), async (req, res) => {
  try {
    const { uploadId, fileName, totalChunks } = req.body
    if (!uploadId || !/^\d+_[a-z0-9]+$/.test(uploadId)) return res.status(400).json({ error: 'uploadId invalide' })

    const chunkDir = join(CHUNK_DIR, uploadId)
    if (!existsSync(chunkDir)) return res.status(400).json({ error: 'Chunks introuvables' })

    const total = parseInt(totalChunks, 10)
    const chunks = readdirSync(chunkDir).filter(f => f.startsWith('chunk_'))
    if (chunks.length !== total) return res.status(400).json({ error: `Chunks incomplets: ${chunks.length}/${total}` })

    const safeName = (fileName || 'video').replace(/[^a-zA-Z0-9._-]/g, '_')
    const finalName = `${Date.now()}_${safeName}`
    const finalPath = join(UPLOAD_DIR, finalName)

    await assembleChunks(chunkDir, finalPath, total)
    rmSync(chunkDir, { recursive: true, force: true })

    // Remux MTS to MP4 for browser compatibility
    const { path: remuxedPath, filename: remuxedName } = await remuxToMp4(finalPath)
    const duration = await ffmpegService.getVideoDuration(remuxedPath)
    const size = statSync(remuxedPath).size
    const displayName = (fileName || safeName).replace(/\.mts$/i, '.mp4')
    res.json({ id: remuxedName, path: remuxedPath, name: displayName, duration, size })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Streaming vidéo/audio avec support du Range (lecture progressive)
// Le token est passé en query param car les balises <video> ne supportent pas les headers custom
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

// ── Analyse semantique (themes, sentiment, insights) ──
// Envoie la transcription au LLM pour extraire les themes principaux,
// le sentiment general et les points cles du contenu.
app.post('/api/semantic/analyze', requireAuth, async (req, res) => {
  try {
    const { segments, model } = req.body
    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'segments requis (tableau non vide)' })
    }
    // Construction du texte complet avec speakers pour l'analyse
    const fullText = segments
      .map((s: any) => {
        const speaker = s.speaker ? `[${s.speaker}] ` : ''
        return `${speaker}${s.text}`
      })
      .join('\n')

    const ollamaModel = model || 'qwen2.5:14b'
    const result = await ollamaService.semanticAnalysis(fullText, ollamaModel)
    res.json({ semanticAnalysis: result })
  } catch (err: any) {
    logger.error('[Semantic] Analysis failed:', err.message)
    res.status(500).json({ error: err.message })
  }
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
  const { access, role } = sharingService.hasAccess(req.params.id, req.user!.userId, req.user!.role)
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

// ── Server-side AI Analysis (via task queue) ──
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

  // Enqueue analysis task
  const task = taskQueueService.enqueueTask(userId, 'analysis', config, projectId)

  res.json({ success: true, message: 'Analyse mise en file d\'attente', taskId: task.id, position: task.position })
})

// ── Queue status ──
app.get('/api/queue', requireAuth, (req, res) => {
  const state = taskQueueService.getQueueState(req.user!.userId)
  res.json(state)
})

app.get('/api/queue/:taskId', requireAuth, (req, res) => {
  const task = taskQueueService.getTaskById(req.params.taskId)
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' })
  res.json(task)
})

app.delete('/api/queue/:taskId', requireAuth, (req, res) => {
  const result = taskQueueService.cancelTask(req.params.taskId, req.user!.userId)
  if (!result.success) return res.status(400).json({ error: result.error })
  res.json({ success: true })
})

// ── Transcription standalone (outil séparé de la segmentation vidéo) ──
app.post('/api/upload/media', requireAuth, mediaUpload.single('file'), async (req, res) => {
  try {
    const file = req.file
    if (!file) return res.status(400).json({ error: 'Aucun fichier' })

    const name = Buffer.from(file.originalname, 'latin1').toString('utf-8')
    let duration = 0
    try { duration = await ffmpegService.getVideoDuration(file.path) } catch { /* audio files may not have video duration */ }

    res.json({ id: file.filename, path: file.path, name, duration, size: file.size })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

app.post('/api/transcription/start', requireAuth, (req, res) => {
  const userId = req.user!.userId
  const { filePath, filename, config, projectName } = req.body

  if (!filePath) return res.status(400).json({ error: 'filePath requis' })

  // Créer un projet pour ce projet de transcription
  let projectId: string | undefined
  try {
    const name = projectName || filename || 'Transcription audio'
    const project = projectService.createProject(name, 'manual', userId)
    projectService.saveProject(project.id, {
      videoFiles: [], transcript: [], segments: [], audioPaths: [],
      config: config || {}, timestamp: Date.now(), projectName: name,
      toolType: 'transcription',
      transcriptionItems: [{ filename: filename || 'audio', status: 'processing' }]
    })
    projectService.updateProjectStatus(project.id, 'processing')
    projectId = project.id
  } catch { /* limite atteinte, on continue sans projet */ }

  const taskConfig = {
    filePath,
    filename: filename || 'audio',
    whisperModel: config?.whisperModel || 'large-v3',
    language: config?.language || 'fr',
    whisperPrompt: config?.whisperPrompt || '',
    projectId
  }

  const task = taskQueueService.enqueueTask(userId, 'transcription', taskConfig)
  res.json({ success: true, taskId: task.id, position: task.position, projectId })
})


// ── Batch upload (multiple media files) ──
app.post('/api/upload/media/batch', requireAuth, mediaUpload.array('files', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[]
    if (!files || files.length === 0) return res.status(400).json({ error: 'Aucun fichier' })

    const results = []
    for (const file of files) {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf-8')
      let duration = 0
      try { duration = await ffmpegService.getVideoDuration(file.path) } catch { /* audio files may not have video duration */ }
      results.push({ id: file.filename, path: file.path, name, duration, size: file.size })
    }
    res.json({ files: results })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ── Batch transcription start ──
app.post('/api/transcription/start/batch', requireAuth, (req, res) => {
  const userId = req.user!.userId
  const { files, config, projectName } = req.body

  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] requis' })
  }
  if (files.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 fichiers par batch' })
  }

  // Créer un projet unique pour tout le batch
  let projectId: string | undefined
  try {
    const name = projectName || (files.length === 1 ? files[0].filename : `Transcription - ${files.length} fichiers`)
    const project = projectService.createProject(name, 'manual', userId)
    const transcriptionItems = files.map((f: any) => ({ filename: f.filename, status: 'processing' as const }))
    projectService.saveProject(project.id, {
      videoFiles: [], transcript: [], segments: [], audioPaths: [],
      config: config || {}, timestamp: Date.now(), projectName: name,
      toolType: 'transcription', transcriptionItems
    })
    projectService.updateProjectStatus(project.id, 'processing')
    projectId = project.id
  } catch { /* limite atteinte */ }

  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tasks = files.map((f: { filePath: string; filename: string }) => {
    const taskConfig = {
      filePath: f.filePath,
      filename: f.filename || 'audio',
      whisperModel: config?.whisperModel || 'large-v3',
      language: config?.language || 'fr',
      whisperPrompt: config?.whisperPrompt || '',
      batchId,
      projectId
    }
    const task = taskQueueService.enqueueTask(userId, 'transcription', taskConfig)
    return { taskId: task.id, position: task.position, filename: f.filename }
  })

  res.json({ success: true, batchId, tasks, projectId })
})
app.get('/api/transcription/history', requireAuth, (req, res) => {
  res.json(getTranscriptionHistory(req.user!.userId))
})

app.get('/api/transcription/:id', requireAuth, (req, res) => {
  const result = getTranscription(req.params.id, req.user!.userId, req.user!.role)
  if (!result) return res.status(404).json({ error: 'Transcription introuvable' })
  res.json(result)
})

app.get('/api/transcription/:id/export', (req, res) => {
  // Support token from query param for direct download links
  const token = req.headers.authorization?.slice(7) || (req.query.token as string)
  if (!token) return res.status(401).json({ error: 'Authentification requise' })
  let userId: string
  let userRole: string | undefined
  try {
    const payload = authService.verifyToken(token)
    userId = payload.userId
    userRole = payload.role
  } catch { return res.status(401).json({ error: 'Token invalide' }) }

  const transcription = getTranscription(req.params.id, userId, userRole)
  if (!transcription) return res.status(404).json({ error: 'Transcription introuvable' })

  const format = req.query.format as string || 'txt'
  const segments = transcription.segments

  if (format === 'srt') {
    const content = exportAsSrt(segments)
    const filename = `${transcription.filename.replace(/\.[^.]+$/, '')}.srt`
    res.setHeader('Content-Type', 'text/srt; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(content)
  } else {
    const content = exportAsText(segments)
    const filename = `${transcription.filename.replace(/\.[^.]+$/, '')}.txt`
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(content)
  }
})

// Rename a speaker in a transcription (updates all segments)
app.patch('/api/transcription/:id/rename-speaker', requireAuth, (req, res) => {
  const { oldName, newName } = req.body
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName et newName requis' })

  const transcription = getTranscription(req.params.id, req.user!.userId, req.user!.role)
  if (!transcription) return res.status(404).json({ error: 'Transcription introuvable' })

  const segments = transcription.segments.map((s: any) =>
    s.speaker === oldName ? { ...s, speaker: newName } : s
  )

  const db = getDb()
  db.prepare('UPDATE transcriptions SET segments = ? WHERE id = ?')
    .run(JSON.stringify(segments), req.params.id)

  res.json({ success: true, segments })
})

app.delete('/api/transcription/:id', requireAuth, (req, res) => {
  const ok = deleteTranscription(req.params.id, req.user!.userId)
  if (!ok) return res.status(404).json({ error: 'Transcription introuvable' })
  res.json({ success: true })
})

// ── Routes de transcription linguistique (patois/vernaculaire) ──

// Démarrer une analyse linguistique
app.post('/api/linguistic/start', requireAuth, (req, res) => {
  try {
    const { filePath, filename, config, projectName } = req.body
    if (!filePath) return res.status(400).json({ error: 'filePath requis' })

    const userId = req.user!.userId
    const name = projectName || filename || 'Transcription linguistique'

    const project = projectService.createProject(name, 'manual', userId)
    projectService.saveProject(project.id, {
      videoFiles: [], transcript: [], segments: [], audioPaths: [],
      config: config || {}, timestamp: Date.now(), projectName: name,
      toolType: 'linguistic',
      linguisticItems: [{ filename: filename || 'audio', status: 'processing', filePath }]
    })
    projectService.updateProjectStatus(project.id, 'processing')

    const taskConfig = {
      filePath, filename,
      whisperModel: config?.whisperModel || 'large-v3',
      language: config?.language || 'fr',
      whisperPrompt: config?.whisperPrompt || '',
      numSpeakers: config?.numSpeakers || 10,
      projectId: project.id,
      leaderSpeaker: config?.leaderSpeaker || ''
    }

    const task = taskQueueService.enqueueTask(userId, 'linguistic', taskConfig)
    res.json({ success: true, taskId: task.id, position: task.position, projectId: project.id })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// Get linguistic transcription history
app.get('/api/linguistic/history', requireAuth, (req, res) => {
  res.json(getLinguisticHistory(req.user!.userId))
})

// Get linguistic transcription by id
app.get('/api/linguistic/:id', requireAuth, (req, res) => {
  const result = getLinguisticTranscription(req.params.id, req.user!.userId, req.user!.role)
  if (!result) return res.status(404).json({ error: 'Transcription introuvable' })
  res.json(result)
})

// Update a sequence (french text or variant IPA)
app.patch('/api/linguistic/:id/sequence/:seqIdx', requireAuth, (req, res) => {
  const seqIdx = parseInt(req.params.seqIdx, 10)
  const result = updateLinguisticSequence(req.params.id, seqIdx, req.body)
  if (!result) return res.status(404).json({ error: 'Sequence introuvable' })
  res.json({ success: true, sequences: result })
})

// Update leader speaker
app.patch('/api/linguistic/:id/leader', requireAuth, (req, res) => {
  const { leader } = req.body
  if (!leader) return res.status(400).json({ error: 'leader requis' })
  updateLinguisticLeader(req.params.id, leader)
  res.json({ success: true })
})

// Rename speaker globally
app.patch('/api/linguistic/:id/rename-speaker', requireAuth, (req, res) => {
  const { oldName, newName } = req.body
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName et newName requis' })
  const result = renameLinguisticSpeaker(req.params.id, oldName, newName)
  if (!result) return res.status(404).json({ error: 'Transcription introuvable' })
  res.json(result)
})

// Delete linguistic transcription
app.delete('/api/linguistic/:id', requireAuth, (req, res) => {
  const ok = deleteLinguisticTranscription(req.params.id, req.user!.userId)
  if (!ok) return res.status(404).json({ error: 'Transcription introuvable' })
  res.json({ success: true })
})

// Export linguistic transcription
app.get('/api/linguistic/:id/export', requireAuth, (req, res) => {
  try {
    const format = req.query.format as string || 'json'
    const result = exportLinguistic(req.params.id, format)
    res.setHeader('Content-Type', result.mime)
    res.setHeader('Content-Disposition', `attachment; filename="linguistic.${result.ext}"`)
    res.send(result.content)
  } catch (err: any) { res.status(404).json({ error: err.message }) }
})

// Serve linguistic audio extract
app.get('/api/linguistic/:id/audio/:filename', (req, res) => {
  const token = req.headers.authorization?.slice(7) || (req.query.token as string)
  if (!token) return res.status(401).json({ error: 'Authentification requise' })
  try { authService.verifyToken(token) } catch { return res.status(401).json({ error: 'Token invalide' }) }

  const DATA_DIR_L = process.env.DATA_DIR || join(process.cwd(), 'data')
  const clipPath = join(DATA_DIR_L, 'linguistic', req.params.id, req.params.filename)
  if (!existsSync(clipPath)) return res.status(404).json({ error: 'Fichier introuvable' })

  res.setHeader('Content-Type', 'audio/wav')
  createReadStream(clipPath).pipe(res)
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

// Fallback SPA : toutes les routes non-API renvoient index.html
// C'est nécessaire pour que le routing côté client (React Router) fonctionne
app.get('*', (_req, res) => {
  const indexPath = join(distPath, 'index.html')
  if (existsSync(indexPath)) res.sendFile(indexPath)
  else res.status(404).json({ error: 'Not found' })
})

// ── Démarrage du serveur ──
// Écoute sur 0.0.0.0 pour être accessible depuis l'extérieur du container Docker
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Clipr server running on port ${PORT}`)
  logger.info(`Data directory: ${DATA_DIR}`)
})

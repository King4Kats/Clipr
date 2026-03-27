/**
 * INDEX.TS : Serveur Express principal (remplace Electron main process)
 *
 * Point d'entrée de l'application web Clipr.
 * - API REST pour toutes les opérations (remplace les IPC handlers)
 * - WebSocket pour les événements temps réel (progression, segments)
 * - Sert les fichiers statiques du frontend React
 * - Sert les fichiers vidéo/audio uploadés
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import multer from 'multer'
import { join, basename, extname } from 'path'
import { existsSync, readFileSync, createReadStream, statSync, mkdirSync } from 'fs'
import { logger, logSystemInfo, getDataDir } from './logger.js'

// Services
import {
  getVideoDuration, extractAudio, cutVideo, concatenateVideos,
  checkFFmpeg, convertToMp4, getUploadsDir, getExportsDir
} from './services/ffmpeg.js'
import {
  loadWhisperModel,
  transcribe as whisperTranscribe,
  cancelTranscription
} from './services/whisper.js'
import {
  checkOllama, listOllamaModels, pullOllamaModel,
  analyzeTranscript, ensureOllamaRunning
} from './services/ollama.js'
import {
  autoSaveProject, getProjectHistory, saveProject, loadProject
} from './services/project-history.js'

// ============================================
// CONFIGURATION
// ============================================

const PORT = parseInt(process.env.PORT || '3000')
const app = express()
const server = createServer(app)

// WebSocket server pour les events temps réel
const wss = new WebSocketServer({ server })

// Middleware
app.use(express.json({ limit: '50mb' }))

// Multer pour l'upload de fichiers vidéo
const upload = multer({
  dest: getUploadsDir(),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB max
  fileFilter: (_, file, cb) => {
    const allowed = ['.mp4', '.avi', '.mov', '.mkv', '.mts', '.webm']
    const ext = extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  }
})

// ============================================
// WEBSOCKET : broadcast d'événements
// ============================================

function broadcast(event: string, data: any): void {
  const message = JSON.stringify({ event, data })
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  })
}

function sendProgress(progress: number, message: string): void {
  broadcast('processing:progress', { progress, message })
}

wss.on('connection', (ws) => {
  logger.info('Client WebSocket connecté')
  ws.on('close', () => logger.info('Client WebSocket déconnecté'))
})

// ============================================
// FICHIERS STATIQUES
// ============================================

// Servir le frontend React (build statique)
const DIST_DIR = join(process.cwd(), 'dist')
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
}

// Servir les fichiers vidéo/audio depuis le data dir
app.get('/api/files/*', (req, res) => {
  // Décoder le chemin du fichier depuis l'URL
  const filePath = req.params[0]
  if (!filePath || !existsSync(filePath)) {
    return res.status(404).json({ error: 'Fichier non trouvé' })
  }

  const stat = statSync(filePath)
  const fileSize = stat.size
  const range = req.headers.range

  if (range) {
    // Support du streaming avec Range requests
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    const chunksize = end - start + 1

    const stream = createReadStream(filePath, { start, end })
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4'
    })
    stream.pipe(res)
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4'
    })
    createReadStream(filePath).pipe(res)
  }
})

// Servir les fichiers audio (pour la waveform)
app.get('/api/audio/*', (req, res) => {
  const filePath = req.params[0]
  if (!filePath || !existsSync(filePath)) {
    return res.status(404).json({ error: 'Fichier audio non trouvé' })
  }

  const stat = statSync(filePath)
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': 'audio/wav'
  })
  createReadStream(filePath).pipe(res)
})

// ============================================
// API ROUTES
// ============================================

// --- Health check ---
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', version: '2.0.0-web' })
})

// --- Upload vidéo ---
app.post('/api/upload', upload.array('videos', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[]
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Aucun fichier' })
    }

    const results = []
    for (const file of files) {
      // Renommer avec l'extension originale
      const ext = extname(file.originalname).toLowerCase()
      const newPath = file.path + ext
      require('fs').renameSync(file.path, newPath)

      const UNSUPPORTED_FORMATS = ['.mts', '.avi', '.mkv', '.mov', '.wmv', '.flv']
      let playablePath = newPath

      if (UNSUPPORTED_FORMATS.includes(ext)) {
        sendProgress(0, 'Conversion vidéo en cours...')
        playablePath = await convertToMp4(newPath, (percent) => {
          sendProgress(percent, 'Conversion vidéo en cours...')
        })
      }

      const duration = await getVideoDuration(newPath)

      results.push({
        path: playablePath,
        originalPath: newPath,
        name: file.originalname,
        duration,
        size: file.size
      })
    }

    res.json({ files: results })
  } catch (error: any) {
    logger.error('Erreur upload :', error)
    res.status(500).json({ error: error.message })
  }
})

// --- FFmpeg ---
app.post('/api/ffmpeg/duration', async (req, res) => {
  try {
    const duration = await getVideoDuration(req.body.videoPath)
    res.json({ duration })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/ffmpeg/extract-audio', async (req, res) => {
  try {
    logger.info('Extraction audio pour :', req.body.videoPath)
    const result = await extractAudio(req.body.videoPath, (percent) => {
      sendProgress(percent, 'Extraction audio...')
    })
    logger.info('Extraction audio terminée :', result)
    res.json({ audioPath: result })
  } catch (error: any) {
    logger.error('Erreur FFmpeg extraction :', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/ffmpeg/cut', async (req, res) => {
  try {
    const { input, start, end, output } = req.body
    await cutVideo(input, start, end, output, 23, (percent) => {
      sendProgress(percent, 'Export en cours...')
    })
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/ffmpeg/convert', async (req, res) => {
  try {
    const result = await convertToMp4(req.body.videoPath, (percent) => {
      sendProgress(percent, 'Conversion vidéo en cours...')
    })
    res.json({ path: result })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/ffmpeg/concatenate', async (req, res) => {
  try {
    const { inputPaths, output } = req.body
    await concatenateVideos(inputPaths, output, (percent) => {
      sendProgress(percent, 'Concaténation en cours...')
    })
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// --- Whisper ---
app.post('/api/whisper/load-model', async (req, res) => {
  try {
    await loadWhisperModel(req.body.model)
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/whisper/transcribe', async (req, res) => {
  try {
    const { audioPath, language } = req.body
    logger.info('Transcription :', audioPath, 'Langue :', language)

    sendProgress(10, 'Transcription en cours...')

    const segments = await whisperTranscribe(
      audioPath,
      language,
      (segment) => {
        broadcast('whisper:segment', segment)
      },
      (percent) => {
        sendProgress(10 + (percent * 0.8), 'Transcription en cours...')
      }
    )

    sendProgress(100, 'Transcription terminée')
    logger.info(`Transcription terminée : ${segments.length} segments`)
    res.json({ segments })
  } catch (error: any) {
    logger.error('Erreur transcription :', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/whisper/cancel', async (_, res) => {
  cancelTranscription()
  res.json({ success: true })
})

// --- Ollama ---
app.get('/api/ollama/check', async (_, res) => {
  const running = await ensureOllamaRunning()
  res.json({ running })
})

app.get('/api/ollama/models', async (_, res) => {
  const models = await listOllamaModels()
  res.json({ models })
})

app.post('/api/ollama/pull', async (req, res) => {
  try {
    const ok = await pullOllamaModel(req.body.modelName)
    res.json({ success: ok, message: ok ? 'Modèle téléchargé' : 'Échec' })
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message })
  }
})

app.post('/api/ollama/analyze', async (req, res) => {
  try {
    const { transcript, context, model } = req.body
    logger.info('Analyse sémantique avec Ollama')

    const result = await analyzeTranscript(transcript, context, model, (chunkIndex, totalChunks, segmentsSoFar, overrideMessage) => {
      const percent = 70 + Math.round(((chunkIndex + 1) / totalChunks) * 18)
      let message = totalChunks > 1
        ? `Analyse IA bloc ${chunkIndex + 1}/${totalChunks} — ${segmentsSoFar} segments trouvés...`
        : `Analyse IA en cours — ${segmentsSoFar} segments trouvés...`

      if (overrideMessage) message = overrideMessage
      sendProgress(percent, message)
    })

    res.json(result)
  } catch (error: any) {
    logger.error('Erreur analyse :', error)
    res.status(500).json({ error: error.message })
  }
})

// --- Setup & Dependencies ---
app.get('/api/setup/check', async (_, res) => {
  const ffmpegOk = await checkFFmpeg()
  const ollamaOk = await checkOllama()

  res.json({
    dependencies: [
      {
        name: 'FFmpeg',
        installed: ffmpegOk,
        version: ffmpegOk ? 'system' : undefined
      },
      {
        name: 'Python + Whisper',
        installed: true, // En Docker, toujours installé
        version: 'faster-whisper'
      },
      {
        name: 'Ollama',
        installed: ollamaOk,
        version: ollamaOk ? 'running' : undefined,
        installInstructions: 'Ollama doit être démarré comme service Docker.'
      }
    ]
  })
})

// --- Projets ---
app.post('/api/project/auto-save', async (req, res) => {
  try {
    await autoSaveProject(req.body)
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/project/history', async (_, res) => {
  const history = getProjectHistory()
  res.json({ history })
})

app.post('/api/project/save', async (req, res) => {
  try {
    const filePath = saveProject(req.body)
    res.json({ path: filePath })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/project/load', async (req, res) => {
  try {
    const data = loadProject(req.body.path)
    res.json({ data })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// --- Export vidéo (retourne un fichier téléchargeable) ---
app.post('/api/export/video', async (req, res) => {
  try {
    const { segments, videoFiles, clips: clipsData } = req.body
    const exportDir = getExportsDir()
    const sessionDir = join(exportDir, `export_${Date.now()}`)
    mkdirSync(sessionDir, { recursive: true })

    const exportedFiles: string[] = []

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const clips = clipsData[i]
      const safeTitle = segment.title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 50)

      const outputPath = join(sessionDir, `${String(i + 1).padStart(2, '0')}_${safeTitle}.mp4`)

      sendProgress(((i / segments.length) * 100), `Export ${i + 1}/${segments.length}: ${segment.title}`)

      if (!clips || clips.length === 0) continue

      if (clips.length === 1) {
        await cutVideo(clips[0].videoPath, clips[0].start, clips[0].end, outputPath)
      } else {
        const tempFiles: string[] = []
        for (let j = 0; j < clips.length; j++) {
          const clip = clips[j]
          const tempPath = join(sessionDir, `temp_clip_${i}_${j}.mp4`)
          tempFiles.push(tempPath)
          await cutVideo(clip.videoPath, clip.start, clip.end, tempPath)
        }
        await concatenateVideos(tempFiles, outputPath)
      }

      exportedFiles.push(outputPath)
    }

    sendProgress(100, 'Export terminé !')
    res.json({ success: true, exportDir: sessionDir, files: exportedFiles })
  } catch (error: any) {
    logger.error('Erreur export :', error)
    res.status(500).json({ error: error.message })
  }
})

// Télécharger un fichier exporté
app.get('/api/export/download/*', (req, res) => {
  const filePath = req.params[0]
  if (!filePath || !existsSync(filePath)) {
    return res.status(404).json({ error: 'Fichier non trouvé' })
  }
  res.download(filePath)
})

// --- Servir le texte d'export ---
app.post('/api/export/text', (req, res) => {
  const { content, filename } = req.body
  const exportDir = getExportsDir()
  const filePath = join(exportDir, filename)
  require('fs').writeFileSync(filePath, content, 'utf-8')
  res.json({ path: filePath })
})

// --- Version ---
app.get('/api/version', (_, res) => {
  // Lire la version depuis le dernier commit git
  const repoDir = existsSync('/repo/.git') ? '/repo' : process.cwd()
  let gitHash = ''
  let gitDate = ''
  try {
    gitHash = require('child_process').execSync('git rev-parse --short HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim()
    gitDate = require('child_process').execSync('git log -1 --format=%ci', { cwd: repoDir, encoding: 'utf-8' }).trim()
  } catch { /* pas de git disponible */ }

  res.json({ version: '2.0.0-web', gitHash, gitDate })
})

// --- Mise à jour : git pull + rebuild Docker ---
app.post('/api/update', async (_, res) => {
  const { spawn } = require('child_process')
  const repoDir = existsSync('/repo/.git') ? '/repo' : process.cwd()

  // Étape 1 : vérifier s'il y a des mises à jour disponibles
  try {
    const fetchResult = require('child_process').execSync(
      'git fetch origin && git log HEAD..origin/HEAD --oneline',
      { cwd: repoDir, encoding: 'utf-8', timeout: 30000 }
    ).trim()

    if (!fetchResult) {
      return res.json({ status: 'up-to-date', message: 'Déjà à jour, aucune mise à jour disponible.' })
    }

    // Il y a des commits à récupérer — on lance le processus de MAJ
    logger.info('[Update] Mise à jour détectée, lancement du rebuild...')
    logger.info('[Update] Nouveaux commits :\n' + fetchResult)

    // Répondre immédiatement au client — le rebuild va redémarrer le container
    res.json({
      status: 'updating',
      message: 'Mise à jour en cours... L\'application va redémarrer automatiquement.',
      commits: fetchResult
    })

    // Étape 2 : lancer le rebuild en arrière-plan (détaché du process Node)
    // Le repo est monté en read-only sur /repo, on fait le git pull sur le host via docker exec
    // ou directement si on a accès au socket Docker
    setTimeout(() => {
      // Le working_dir du container est /repo (le repo git monté du host)
      // On utilise le socket Docker monté pour relancer docker compose
      const repoDir = '/repo'
      const updateScript = `
        cd ${repoDir} && \
        git pull origin 2>&1 && \
        docker compose up -d --build 2>&1 | tee /tmp/clipr-update.log
      `

      const child = spawn('sh', ['-c', updateScript], {
        detached: true,
        stdio: 'ignore',
        cwd: repoDir
      })
      child.unref()

      logger.info('[Update] Processus de rebuild lancé (PID: ' + child.pid + ')')
    }, 500)

  } catch (error: any) {
    logger.error('[Update] Erreur :', error)
    res.status(500).json({ status: 'error', message: error.message })
  }
})

// --- Vérifier si une MAJ est disponible (sans l'appliquer) ---
app.get('/api/update/check', async (_, res) => {
  const repoDir = existsSync('/repo/.git') ? '/repo' : process.cwd()
  try {
    require('child_process').execSync('git fetch origin', {
      cwd: repoDir, encoding: 'utf-8', timeout: 30000
    })

    const behind = require('child_process').execSync(
      'git log HEAD..origin/HEAD --oneline',
      { cwd: repoDir, encoding: 'utf-8' }
    ).trim()

    if (behind) {
      const commitCount = behind.split('\n').length
      res.json({
        available: true,
        commits: commitCount,
        details: behind
      })
    } else {
      res.json({ available: false })
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// --- Logs ---
app.get('/api/logs/download', (_, res) => {
  const logFile = join(getDataDir(), 'logs', 'main.log')
  if (existsSync(logFile)) {
    res.download(logFile)
  } else {
    res.status(404).json({ error: 'Pas de fichier de log' })
  }
})

// --- SPA fallback : toutes les routes non-API servent index.html ---
app.get('*', (_, res) => {
  const indexPath = join(DIST_DIR, 'index.html')
  if (existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.status(200).send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #0a0a0a; color: white;">
          <div style="text-align: center;">
            <h1>Clipr</h1>
            <p>Le frontend n'est pas encore buildé. Lancez <code>npm run build:web</code></p>
          </div>
        </body>
      </html>
    `)
  }
})

// ============================================
// DÉMARRAGE
// ============================================

logSystemInfo()

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Clipr Web Server démarré sur http://0.0.0.0:${PORT}`)
  console.log(`\n  🎬 Clipr Web Server\n  → http://localhost:${PORT}\n`)
})

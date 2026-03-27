import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { logger } from './logger.js'

export interface DependencyStatus {
  name: string
  installed: boolean
  version?: string
  installUrl?: string
  installInstructions?: string
}

// Cache pour les vérifications de dépendances (évite les CMD flash répétitifs)
let dependencyCache: Record<string, { exists: boolean; version?: string; timestamp: number }> = {}
const CACHE_TTL = 30000 // 30 secondes

/**
 * Vérifie l'existence et l'opérabilité d'une commande système.
 */
async function checkCommand(command: string, args: string[] = ['--version']): Promise<{ exists: boolean; version?: string }> {
  const cacheKey = `${command} ${args.join(' ')}`
  const now = Date.now()

  if (dependencyCache[cacheKey] && (now - dependencyCache[cacheKey].timestamp) < CACHE_TTL) {
    return { exists: dependencyCache[cacheKey].exists, version: dependencyCache[cacheKey].version }
  }

  return new Promise((resolve) => {
    try {
      // On force windowsHide: true et on évite shell: true pour masquer la fenêtre sur Windows.
      const proc = spawn(command, args, {
        windowsHide: true,
        shell: false
      })
      let output = ''

      proc.stdout?.on('data', (data) => {
        output += data.toString()
      })

      proc.stderr?.on('data', (data) => {
        output += data.toString()
      })

      proc.on('close', (code) => {
        let result = { exists: false, version: undefined as string | undefined }
        if (code === 0) {
          const versionMatch = output.match(/(\d+\.\d+(\.\d+)?)/)?.[1]
          result = { exists: true, version: versionMatch }
        }

        dependencyCache[cacheKey] = { ...result, timestamp: Date.now() }
        resolve(result)
      })

      proc.on('error', () => {
        dependencyCache[cacheKey] = { exists: false, timestamp: Date.now() }
        resolve({ exists: false })
      })

      // Timeout court pour les vérifications
      setTimeout(() => {
        if (!dependencyCache[cacheKey]) {
          proc.kill()
          resolve({ exists: false })
        }
      }, 3000)
    } catch {
      resolve({ exists: false })
    }
  })
}

/**
 * Vérifie si FFmpeg est installé et accessible.
 */
export async function checkFFmpeg(): Promise<DependencyStatus> {
  const result = await checkCommand('ffmpeg', ['-version'])

  // Vérification complémentaire dans les emplacements système Windows standards
  if (!result.exists) {
    const possiblePaths = [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ]

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return {
          name: 'FFmpeg',
          installed: true,
          version: 'trouvé à ' + path,
          installUrl: 'https://ffmpeg.org/download.html'
        }
      }
    }
  }

  return {
    name: 'FFmpeg',
    installed: result.exists,
    version: result.version,
    installUrl: 'https://ffmpeg.org/download.html',
    installInstructions: `
1. Téléchargez FFmpeg depuis https://github.com/BtbN/FFmpeg-Builds/releases
2. Choisissez "ffmpeg-master-latest-win64-gpl.zip"
3. Extrayez le contenu dans C:\\ffmpeg
4. Ajoutez C:\\ffmpeg\\bin au PATH système
5. Redémarrez l'application
    `.trim()
  }
}

/**
 * Vérifie la présence de Python sur le système.
 */
export async function checkPython(): Promise<DependencyStatus> {
  // Test de différentes commandes Python usuelles
  for (const cmd of ['python', 'python3', 'py']) {
    const result = await checkCommand(cmd, ['--version'])
    if (result.exists) {
      return {
        name: 'Python',
        installed: true,
        version: result.version,
        installUrl: 'https://www.python.org/downloads/'
      }
    }
  }

  return {
    name: 'Python',
    installed: false,
    installUrl: 'https://www.python.org/downloads/',
    installInstructions: `
1. Téléchargez Python 3.10+ depuis https://www.python.org/downloads/
2. Lors de l'installation, COCHEZ "Add Python to PATH"
3. Redémarrez l'application
    `.trim()
  }
}

/**
 * Vérifie si le package faster-whisper est installé dans l'environnement Python.
 */
export async function checkFasterWhisper(): Promise<DependencyStatus> {
  const result = await checkCommand('pip', ['show', 'faster-whisper'])

  return {
    name: 'faster-whisper',
    installed: result.exists,
    installUrl: 'https://github.com/SYSTRAN/faster-whisper',
    installInstructions: `
1. Ouvrez un terminal (cmd ou PowerShell)
2. Exécutez: pip install faster-whisper
3. Redémarrez l'application

Note: Si vous avez une carte graphique NVIDIA, installez aussi CUDA pour de meilleures performances.
    `.trim()
  }
}

/**
 * Vérifie si Ollama est installé et si le serveur est opérationnel.
 */
export async function checkOllamaInstalled(): Promise<DependencyStatus> {
  // Vérification de l'existence de la commande ollama
  const cmdResult = await checkCommand('ollama', ['--version'])

  if (!cmdResult.exists) {
    return {
      name: 'Ollama',
      installed: false,
      installUrl: 'https://ollama.com/download',
      installInstructions: `
1. Téléchargez Ollama depuis https://ollama.com/download
2. Installez-le et lancez-le
3. Dans un terminal, exécutez: ollama pull qwen2.5:3b
4. Redémarrez l'application

Modèles recommandés:
- qwen2.5:3b (léger, rapide)
- llama3.2:3b (bon équilibre)
- mistral:7b (plus précis mais plus lent)
      `.trim()
    }
  }

  // Vérification de l'état de fonctionnement du serveur Ollama
  try {
    const response = await fetch('http://localhost:11434/api/tags')
    if (response.ok) {
      const data = await response.json()
      const modelCount = data.models?.length || 0
      return {
        name: 'Ollama',
        installed: true,
        version: `${modelCount} modèle(s) installé(s)`,
        installUrl: 'https://ollama.com/download'
      }
    }
  } catch {
    // Le serveur ne répond pas -> Tentative de lancement automatique
    const { ensureOllamaRunning } = require('./ollama')
    const started = await ensureOllamaRunning()

    if (started) {
      return {
        name: 'Ollama',
        installed: true,
        version: 'Démarré automatiquement',
        installUrl: 'https://ollama.com/download'
      }
    }

    return {
      name: 'Ollama',
      installed: true,
      version: 'installé mais non démarré',
      installUrl: 'https://ollama.com/download',
      installInstructions: 'Lancement automatique échoué. Lancez Ollama manuellement ou exécutez "ollama serve".'
    }
  }

  return {
    name: 'Ollama',
    installed: true,
    version: cmdResult.version,
    installUrl: 'https://ollama.com/download'
  }
}

/**
 * Analyse l'ensemble des dépendances logicielles requises.
 */
export async function checkAllDependencies(): Promise<DependencyStatus[]> {
  const results = await Promise.all([
    checkFFmpeg(),
    checkPython(),
    checkFasterWhisper(),
    checkOllamaInstalled()
  ])

  return results
}

/**
 * Installe la bibliothèque faster-whisper via pip.
 */
export async function installFasterWhisper(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const proc = spawn('pip', ['install', 'faster-whisper'], { windowsHide: true })
    let output = ''

    proc.stdout?.on('data', (data) => {
      output += data.toString()
    })

    proc.stderr?.on('data', (data) => {
      output += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: 'faster-whisper installé avec succès' })
      } else {
        resolve({ success: false, message: `Erreur d'installation: ${output}` })
      }
    })

    proc.on('error', (err) => {
      resolve({ success: false, message: `Erreur: ${err.message}` })
    })
  })
}

/**
 * Télécharge (pull) un modèle Ollama spécifié.
 */
export async function pullOllamaModel(modelName: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const proc = spawn('ollama', ['pull', modelName], { windowsHide: true })
    let output = ''

    proc.stdout?.on('data', (data) => {
      output += data.toString()
    })

    proc.stderr?.on('data', (data) => {
      output += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: `Modèle ${modelName} téléchargé avec succès` })
      } else {
        resolve({ success: false, message: `Erreur: ${output}` })
      }
    })

    proc.on('error', (err) => {
      resolve({ success: false, message: `Erreur : ${err.message}` })
    })

    // Délai d'attente de 10 minutes pour le téléchargement du modèle
    setTimeout(() => {
      proc.kill()
      resolve({ success: false, message: 'Délai dépassé - le téléchargement est trop long' })
    }, 600000)
  })
}
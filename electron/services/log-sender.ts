import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import archiver from 'archiver'
import { createWriteStream } from 'fs'
import { logger, getLogsDirectory } from './logger.js'

/**
 * LOG-SENDER.TS : Export des logs de diagnostic
 *
 * Gere l'identification unique de chaque installation (UUID)
 * et la compression des logs en ZIP pour export manuel par l'utilisateur.
 */

/**
 * Recupere ou genere l'UUID d'installation.
 * Stocke dans userData/installation-id.json
 */
export function getInstallationId(): string {
  const idPath = join(app.getPath('userData'), 'installation-id.json')

  if (existsSync(idPath)) {
    try {
      const data = JSON.parse(readFileSync(idPath, 'utf-8'))
      if (data.id) return data.id
    } catch (e) {
      logger.warn('Could not read installation ID, generating new one:', e)
    }
  }

  const newId = uuidv4()
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  writeFileSync(idPath, JSON.stringify({
    id: newId,
    createdAt: new Date().toISOString()
  }), 'utf-8')

  logger.info(`Generated new installation ID: ${newId}`)
  return newId
}

/**
 * Compresse tous les fichiers de log en un ZIP.
 * Retourne le chemin du fichier ZIP cree (dans le dossier temp).
 */
export async function zipLogs(): Promise<string> {
  const logsDir = getLogsDirectory()
  const tempDir = app.getPath('temp')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const zipPath = join(tempDir, `clipr-logs-${timestamp}.zip`)

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => {
      logger.info(`Logs zipped: ${archive.pointer()} bytes -> ${zipPath}`)
      resolve(zipPath)
    })

    archive.on('error', (err) => reject(err))
    archive.pipe(output)

    if (existsSync(logsDir)) {
      archive.directory(logsDir, 'logs')
    }

    // Inclure aussi l'installation-id.json pour identifier l'installation
    const idPath = join(app.getPath('userData'), 'installation-id.json')
    if (existsSync(idPath)) {
      archive.file(idPath, { name: 'installation-id.json' })
    }

    archive.finalize()
  })
}

/**
 * Exporte les logs : compression en ZIP puis copie vers le chemin choisi par l'utilisateur.
 * Retourne le chemin final du fichier ZIP.
 */
export async function exportLogs(
  savePath: string,
  onProgress?: (percent: number, message: string) => void
): Promise<{ success: boolean; message: string }> {
  try {
    onProgress?.(10, 'Compression des logs...')
    const zipPath = await zipLogs()

    onProgress?.(80, 'Enregistrement...')
    copyFileSync(zipPath, savePath)

    onProgress?.(100, 'Logs exportes avec succes')
    logger.info('Logs exported to:', savePath)
    return { success: true, message: `Logs exportes : ${savePath}` }
  } catch (error: any) {
    logger.error('Failed to export logs:', error)
    return { success: false, message: `Erreur : ${error.message}` }
  }
}

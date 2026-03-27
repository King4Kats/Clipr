import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater'
import { BrowserWindow } from 'electron'
import { logger } from './logger.js'

/**
 * UPDATER.TS : Mise a jour automatique via GitHub Releases
 *
 * Utilise electron-updater pour verifier, telecharger et installer
 * les mises a jour depuis les GitHub Releases du depot.
 * L'utilisateur est notifie via IPC et peut redemarrer l'app.
 */

export type UpdateStatus =
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | { status: 'not-available'; version: string }
  | { status: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

let mainWindowRef: BrowserWindow | null = null

/**
 * Initialise l'auto-updater avec les gestionnaires d'evenements.
 * Doit etre appele une fois au demarrage de l'application.
 */
export function initUpdater(window: BrowserWindow): void {
  mainWindowRef = window

  // Configuration
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Utiliser notre logger
  autoUpdater.logger = {
    info: (...args: unknown[]) => logger.info('[Updater]', ...args),
    warn: (...args: unknown[]) => logger.warn('[Updater]', ...args),
    error: (...args: unknown[]) => logger.error('[Updater]', ...args),
    debug: (...args: unknown[]) => logger.debug('[Updater]', ...args),
  }

  // Evenements
  autoUpdater.on('checking-for-update', () => {
    logger.info('[Updater] Checking for updates...')
    sendUpdateStatus({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info(`[Updater] Update available: ${info.version}`)
    sendUpdateStatus({
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined
    })
    // Lancer le telechargement automatiquement
    autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    logger.info(`[Updater] No update available. Current: ${info.version}`)
    sendUpdateStatus({ status: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    logger.debug(`[Updater] Download progress: ${progress.percent.toFixed(1)}%`)
    sendUpdateStatus({
      status: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    logger.info(`[Updater] Update downloaded: ${info.version}`)
    sendUpdateStatus({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (error: Error) => {
    logger.error('[Updater] Error:', error.message)
    sendUpdateStatus({ status: 'error', message: error.message })
  })
}

/**
 * Envoie le statut de mise a jour au renderer via IPC.
 */
function sendUpdateStatus(status: UpdateStatus): void {
  mainWindowRef?.webContents.send('updater:status', status)
}

/**
 * Verifie les mises a jour disponibles.
 * Appele manuellement depuis les parametres ou automatiquement au demarrage.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (error: any) {
    logger.error('[Updater] Check failed:', error.message)
    sendUpdateStatus({ status: 'error', message: error.message })
  }
}

/**
 * Quitte l'application et installe la mise a jour telechargee.
 */
export function installUpdate(): void {
  logger.info('[Updater] Installing update and restarting...')
  autoUpdater.quitAndInstall()
}

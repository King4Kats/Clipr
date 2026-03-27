import log from 'electron-log'
import { app } from 'electron'
import { join } from 'path'
import os from 'os'

/**
 * LOGGER.TS : Service de logging centralise
 *
 * Remplace tous les console.log/error par un logger structure
 * qui ecrit dans des fichiers persistants avec rotation.
 * Les logs sont stockes dans %APPDATA%/decoupeur-video/logs/
 */

// Configure le chemin du fichier de log
log.transports.file.resolvePathFn = () => {
  return join(app.getPath('userData'), 'logs', 'main.log')
}

// Rotation : max 5MB par fichier
log.transports.file.maxSize = 5 * 1024 * 1024

// Format avec timestamp et niveau
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

// En dev : afficher aussi dans la console ; en prod : fichier uniquement
log.transports.console.level = app.isPackaged ? false : 'debug'

// Logger type pour toute l'application
export const logger = {
  info: (...args: unknown[]) => log.info(...args),
  warn: (...args: unknown[]) => log.warn(...args),
  error: (...args: unknown[]) => log.error(...args),
  debug: (...args: unknown[]) => log.debug(...args),
}

/**
 * Logge les informations systeme au demarrage de l'application.
 */
export function logSystemInfo(): void {
  logger.info('=== Application Starting ===')
  logger.info(`App Version: ${app.getVersion()}`)
  logger.info(`Electron: ${process.versions.electron}`)
  logger.info(`Chrome: ${process.versions.chrome}`)
  logger.info(`Node: ${process.versions.node}`)
  logger.info(`OS: ${os.type()} ${os.release()} (${os.arch()})`)
  logger.info(`Platform: ${process.platform}`)
  logger.info(`Memory: ${Math.round(os.totalmem() / 1024 / 1024)} MB total, ${Math.round(os.freemem() / 1024 / 1024)} MB free`)
  logger.info(`CPUs: ${os.cpus().length}x ${os.cpus()[0]?.model}`)
  logger.info(`User Data: ${app.getPath('userData')}`)
  logger.info(`Packaged: ${app.isPackaged}`)
  logger.info('============================')
}

/**
 * Retourne le repertoire ou les fichiers de log sont stockes.
 */
export function getLogsDirectory(): string {
  return join(app.getPath('userData'), 'logs')
}

export default log

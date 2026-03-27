/**
 * LOGGER.TS : Service de logging centralise (version web/serveur)
 *
 * Remplace electron-log par un logger simple basé sur console + fichier.
 */

import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import os from 'os'

const DATA_DIR = process.env.CLIPR_DATA_DIR || join(os.homedir(), '.clipr')
const LOGS_DIR = join(DATA_DIR, 'logs')

if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true })
}

const LOG_FILE = join(LOGS_DIR, 'main.log')

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function writeLog(level: string, args: unknown[]): void {
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  const line = `[${timestamp()}] [${level}] ${message}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch { /* ignore */ }
  if (process.env.NODE_ENV !== 'production') {
    console.log(line.trimEnd())
  }
}

export const logger = {
  info: (...args: unknown[]) => writeLog('info', args),
  warn: (...args: unknown[]) => writeLog('warn', args),
  error: (...args: unknown[]) => writeLog('error', args),
  debug: (...args: unknown[]) => writeLog('debug', args),
}

export function logSystemInfo(): void {
  logger.info('=== Clipr Web Server Starting ===')
  logger.info(`Node: ${process.versions.node}`)
  logger.info(`OS: ${os.type()} ${os.release()} (${os.arch()})`)
  logger.info(`Platform: ${process.platform}`)
  logger.info(`Memory: ${Math.round(os.totalmem() / 1024 / 1024)} MB total, ${Math.round(os.freemem() / 1024 / 1024)} MB free`)
  logger.info(`CPUs: ${os.cpus().length}x ${os.cpus()[0]?.model}`)
  logger.info(`Data Dir: ${DATA_DIR}`)
  logger.info('============================')
}

export function getLogsDirectory(): string {
  return LOGS_DIR
}

export function getDataDir(): string {
  return DATA_DIR
}

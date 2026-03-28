import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

const LOG_DIR = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'logs') : join(process.cwd(), 'data', 'logs')

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

const LOG_FILE = join(LOG_DIR, 'clipr.log')

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function write(level: string, ...args: any[]) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  const line = `[${timestamp()}] [${level}] ${msg}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
  if (level === 'ERROR') console.error(`[${level}]`, ...args)
  else console.log(`[${level}]`, ...args)
}

export const logger = {
  info: (...args: any[]) => write('INFO', ...args),
  warn: (...args: any[]) => write('WARN', ...args),
  error: (...args: any[]) => write('ERROR', ...args),
  debug: (...args: any[]) => write('DEBUG', ...args),
  logDir: LOG_DIR,
  logFile: LOG_FILE
}

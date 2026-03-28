import { getDb } from './database.js'
import { logger } from '../logger.js'

// Lock timeout: 30 minutes max per analysis
const LOCK_TIMEOUT_MINUTES = 30

export interface AiLockInfo {
  user_id: string
  username: string
  project_id: string
  project_name: string
  started_at: string
  expires_at: string
}

// ── Clean expired locks ──
function cleanExpiredLocks() {
  const db = getDb()
  const now = new Date().toISOString()
  const deleted = db.prepare(
    `DELETE FROM ai_locks WHERE expires_at < ?`
  ).run(now)
  if (deleted.changes > 0) {
    logger.info(`[AI Lock] Cleaned ${deleted.changes} expired lock(s)`)
  }
}

// ── Check if AI is currently locked ──
export function getActiveLock(): AiLockInfo | null {
  cleanExpiredLocks()
  const db = getDb()
  const row = db.prepare(
    `SELECT l.user_id, u.username, l.project_id, p.name as project_name, l.started_at, l.expires_at
     FROM ai_locks l
     JOIN users u ON l.user_id = u.id
     JOIN projects p ON l.project_id = p.id
     ORDER BY l.started_at DESC LIMIT 1`
  ).get() as any
  return row || null
}

// ── Try to acquire the AI lock ──
export function acquireLock(userId: string, projectId: string): { success: boolean; lock?: AiLockInfo; error?: string } {
  cleanExpiredLocks()
  const db = getDb()

  // Check if already locked by someone else
  const existing = getActiveLock()
  if (existing && existing.user_id !== userId) {
    return {
      success: false,
      lock: existing,
      error: `L'IA est utilisée par ${existing.username} sur le projet "${existing.project_name}"`
    }
  }

  // Release any existing lock for this user (they might be re-running)
  db.prepare('DELETE FROM ai_locks WHERE user_id = ?').run(userId)

  // Acquire new lock
  const now = new Date()
  const expires = new Date(now.getTime() + LOCK_TIMEOUT_MINUTES * 60 * 1000)

  db.prepare(
    'INSERT INTO ai_locks (user_id, project_id, started_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(userId, projectId, now.toISOString(), expires.toISOString())

  logger.info(`[AI Lock] Acquired by user ${userId} for project ${projectId}`)

  return { success: true }
}

// ── Release the AI lock ──
export function releaseLock(userId: string) {
  const db = getDb()
  db.prepare('DELETE FROM ai_locks WHERE user_id = ?').run(userId)
  logger.info(`[AI Lock] Released by user ${userId}`)
}

// ── Release lock for a specific project ──
export function releaseLockForProject(projectId: string) {
  const db = getDb()
  db.prepare('DELETE FROM ai_locks WHERE project_id = ?').run(projectId)
}

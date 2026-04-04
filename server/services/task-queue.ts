/**
 * TASK-QUEUE.TS : File d'attente FIFO pour les tâches IA
 *
 * Remplace le verrou binaire ai-lock. Une seule tâche tourne à la fois
 * (VRAM partagée entre Whisper et Ollama). Les tâches en attente sont
 * traitées automatiquement dans l'ordre d'insertion.
 */

import { getDb } from './database.js'
import { randomUUID } from 'crypto'
import { logger } from '../logger.js'

export type TaskType = 'analysis' | 'transcription' | 'linguistic'
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface QueueTask {
  id: string
  user_id: string
  type: TaskType
  status: TaskStatus
  project_id: string | null
  config: any
  result: any | null
  progress: number
  progress_message: string | null
  position: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

// Callback types for pipeline execution
type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void
type PipelineRunner = (task: QueueTask, broadcastFn: BroadcastFn) => Promise<any>

let currentRunningTaskId: string | null = null
let pipelineRunners: Record<TaskType, PipelineRunner> = {} as any
let broadcastFn: BroadcastFn | null = null

// ── Initialize with pipeline runners and broadcast function ──
export function initQueue(
  runners: Record<TaskType, PipelineRunner>,
  broadcast: BroadcastFn
) {
  pipelineRunners = runners
  broadcastFn = broadcast
  recoverOnStartup()
}

// ── Enqueue a new task ──
export function enqueueTask(
  userId: string,
  type: TaskType,
  config: any,
  projectId?: string
): QueueTask {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()

  // Get next position
  const maxPos = db.prepare(
    `SELECT MAX(position) as maxPos FROM task_queue WHERE status IN ('pending', 'running')`
  ).get() as any
  const position = (maxPos?.maxPos ?? 0) + 1

  db.prepare(
    `INSERT INTO task_queue (id, user_id, type, status, project_id, config, progress, position, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, 0, ?, ?)`
  ).run(id, userId, type, projectId || null, JSON.stringify(config), position, now)

  logger.info(`[Queue] Task ${id} enqueued: type=${type} user=${userId} position=${position}`)

  const task = getTaskById(id)!

  // Notify user
  if (broadcastFn) {
    broadcastFn(userId, null, 'queue:update', { task, queue: getQueueState(userId) })
  }

  // Try to process next
  processNext()

  return task
}

// ── Process the next pending task ──
function processNext() {
  if (currentRunningTaskId) return // Already running a task

  const db = getDb()
  const next = db.prepare(
    `SELECT * FROM task_queue WHERE status = 'pending' ORDER BY position ASC LIMIT 1`
  ).get() as any

  if (!next) return // Nothing to do

  currentRunningTaskId = next.id
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE task_queue SET status = 'running', started_at = ? WHERE id = ?`
  ).run(now, next.id)

  const task = getTaskById(next.id)!
  logger.info(`[Queue] Starting task ${task.id}: type=${task.type}`)

  // Notify user their task started
  if (broadcastFn) {
    broadcastFn(task.user_id, task.project_id, 'queue:task-started', { taskId: task.id, type: task.type })
    // Also notify all users with pending tasks about updated positions
    broadcastQueueUpdates()
  }

  // Execute in background
  const runner = pipelineRunners[task.type]
  if (!runner) {
    completeTask(task.id, 'failed', null, `Unknown task type: ${task.type}`)
    return
  }

  runner(task, broadcastFn!).then(
    (result) => completeTask(task.id, 'completed', result),
    (err) => completeTask(task.id, 'failed', null, err?.message || 'Unknown error')
  )
}

// ── Complete a task ──
function completeTask(taskId: string, status: 'completed' | 'failed', result: any, errorMessage?: string) {
  const db = getDb()
  const now = new Date().toISOString()

  const resultJson = status === 'failed'
    ? JSON.stringify({ error: errorMessage })
    : result ? JSON.stringify(result) : null

  db.prepare(
    `UPDATE task_queue SET status = ?, result = ?, completed_at = ?, progress = ?, progress_message = ? WHERE id = ?`
  ).run(status, resultJson, now, status === 'completed' ? 100 : 0, errorMessage || null, taskId)

  const task = getTaskById(taskId)
  if (task && broadcastFn) {
    const eventType = status === 'completed' ? 'queue:task-completed' : 'queue:task-failed'
    broadcastFn(task.user_id, task.project_id, eventType, {
      taskId: task.id,
      type: task.type,
      result: task.result,
      error: errorMessage
    })
  }

  logger.info(`[Queue] Task ${taskId} ${status}${errorMessage ? ': ' + errorMessage : ''}`)

  currentRunningTaskId = null
  processNext()
}

// ── Update task progress (called by pipelines) ──
export function updateTaskProgress(taskId: string, progress: number, message: string) {
  const db = getDb()
  // Only update DB every 10% to reduce write pressure
  const current = db.prepare(`SELECT progress FROM task_queue WHERE id = ?`).get(taskId) as any
  if (current && Math.abs(current.progress - progress) >= 5) {
    db.prepare(
      `UPDATE task_queue SET progress = ?, progress_message = ? WHERE id = ?`
    ).run(Math.round(progress), message, taskId)
  }
}

// ── Cancel a task ──
export function cancelTask(taskId: string, userId: string): { success: boolean; error?: string } {
  const db = getDb()
  const task = getTaskById(taskId)

  if (!task) return { success: false, error: 'Tâche introuvable' }
  if (task.user_id !== userId) return { success: false, error: 'Non autorisé' }

  if (task.status === 'pending') {
    db.prepare(`UPDATE task_queue SET status = 'cancelled', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), taskId)
    logger.info(`[Queue] Task ${taskId} cancelled (was pending)`)

    if (broadcastFn) {
      broadcastFn(userId, null, 'queue:update', { task: getTaskById(taskId), queue: getQueueState(userId) })
    }
    return { success: true }
  }

  if (task.status === 'running') {
    // Cancel running task - the pipeline should handle interruption
    // For now, we import whisper cancel dynamically
    try {
      const whisperService = require('./whisper.js')
      whisperService.cancelTranscription()
    } catch { /* ignore */ }

    completeTask(taskId, 'failed', null, 'Annulé par l\'utilisateur')
    return { success: true }
  }

  return { success: false, error: 'La tâche ne peut pas être annulée (statut: ' + task.status + ')' }
}

// ── Get a single task by ID ──
export function getTaskById(taskId: string): QueueTask | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM task_queue WHERE id = ?`).get(taskId) as any
  if (!row) return null
  return parseTaskRow(row)
}

// ── Get queue state for a user ──
export function getQueueState(userId?: string): {
  currentTask: QueueTask | null
  userTasks: QueueTask[]
  totalPending: number
} {
  const db = getDb()

  // Currently running task
  const runningRow = db.prepare(
    `SELECT q.*, u.username FROM task_queue q JOIN users u ON q.user_id = u.id WHERE q.status = 'running' LIMIT 1`
  ).get() as any

  const currentTask = runningRow ? { ...parseTaskRow(runningRow), username: runningRow.username } : null

  // User's tasks (pending + running)
  let userTasks: QueueTask[] = []
  if (userId) {
    const rows = db.prepare(
      `SELECT * FROM task_queue WHERE user_id = ? AND status IN ('pending', 'running') ORDER BY position ASC`
    ).all(userId) as any[]
    userTasks = rows.map(parseTaskRow)

    // Compute position among all pending tasks
    const allPending = db.prepare(
      `SELECT id FROM task_queue WHERE status = 'pending' ORDER BY position ASC`
    ).all() as any[]
    userTasks.forEach(t => {
      if (t.status === 'pending') {
        const idx = allPending.findIndex((p: any) => p.id === t.id)
        t.position = idx + 1
      } else {
        t.position = 0
      }
    })
  }

  const totalPending = (db.prepare(
    `SELECT COUNT(*) as cnt FROM task_queue WHERE status = 'pending'`
  ).get() as any).cnt

  return { currentTask, userTasks, totalPending }
}

// ── Recovery on startup ──
function recoverOnStartup() {
  const db = getDb()
  const now = new Date().toISOString()

  // Mark orphaned running tasks as failed
  const orphaned = db.prepare(
    `UPDATE task_queue SET status = 'failed', result = ?, completed_at = ? WHERE status = 'running'`
  ).run(JSON.stringify({ error: 'Le serveur a redémarré pendant l\'exécution' }), now)

  if (orphaned.changes > 0) {
    logger.info(`[Queue] Recovery: marked ${orphaned.changes} orphaned task(s) as failed`)
  }

  currentRunningTaskId = null

  // Try to process any pending tasks
  processNext()
}

// ── Notify all users with pending tasks about updated positions ──
function broadcastQueueUpdates() {
  if (!broadcastFn) return
  const db = getDb()
  const pendingUsers = db.prepare(
    `SELECT DISTINCT user_id FROM task_queue WHERE status IN ('pending', 'running')`
  ).all() as any[]

  for (const { user_id } of pendingUsers) {
    broadcastFn(user_id, null, 'queue:update', { queue: getQueueState(user_id) })
  }
}

// ── Get recent completed tasks for a user ──
export function getRecentTasks(userId: string, limit: number = 10): QueueTask[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM task_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit) as any[]
  return rows.map(parseTaskRow)
}

// ── Parse a DB row into a QueueTask ──
function parseTaskRow(row: any): QueueTask {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    status: row.status,
    project_id: row.project_id,
    config: row.config ? JSON.parse(row.config) : {},
    result: row.result ? JSON.parse(row.result) : null,
    progress: row.progress || 0,
    progress_message: row.progress_message,
    position: row.position,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at
  }
}

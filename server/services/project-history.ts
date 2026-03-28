import { getDb } from './database.js'
import { logger } from '../logger.js'
import { randomUUID } from 'crypto'

const MAX_PROJECTS_PER_USER = 6

// Fix mojibake: detect and repair latin1-decoded UTF-8 strings (e.g. "rescapÃ©e" → "rescapée")
function fixMojibake(str: string): string {
  try {
    // Check if the string contains typical mojibake patterns (Ã followed by another char)
    if (/[\xC0-\xDF][\x80-\xBF]/.test(str) || /\xC3[\x80-\xBF]/.test(str)) {
      const fixed = Buffer.from(str, 'latin1').toString('utf-8')
      // Verify the result is valid and different
      if (fixed !== str && !fixed.includes('\uFFFD')) return fixed
    }
  } catch { /* ignore, return original */ }
  return str
}

export interface ProjectData {
  videoFiles: any[]
  transcript: any[]
  segments: any[]
  audioPaths?: string[]
  config: any
  timestamp: number
  projectName: string
}

export interface ProjectRecord {
  id: string
  user_id: string | null
  name: string
  type: 'manual' | 'ai'
  status: 'draft' | 'processing' | 'done'
  data: ProjectData
  created_at: string
  updated_at: string
}

// ── List active projects for a user, max 6, newest first ──
export function getProjectHistory(userId?: string): ProjectRecord[] {
  const db = getDb()
  let rows: any[]

  if (userId) {
    rows = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE deleted_at IS NULL AND user_id = ?
       ORDER BY updated_at DESC LIMIT ?`
    ).all(userId, MAX_PROJECTS_PER_USER)
  } else {
    rows = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE deleted_at IS NULL AND user_id IS NULL
       ORDER BY updated_at DESC LIMIT ?`
    ).all(MAX_PROJECTS_PER_USER)
  }

  return rows.map(row => {
    const data = JSON.parse(row.data)
    // Fix mojibake in videoFiles names
    if (data.videoFiles) {
      data.videoFiles = data.videoFiles.map((vf: any) => ({
        ...vf,
        name: vf.name ? fixMojibake(vf.name) : vf.name
      }))
    }
    if (data.projectName) data.projectName = fixMojibake(data.projectName)
    return { ...row, name: fixMojibake(row.name), data }
  })
}

// ── List ALL projects (admin) ──
export function getAllProjects(): ProjectRecord[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT p.id, p.user_id, p.name, p.type, p.status, p.data, p.created_at, p.updated_at,
            u.username as owner_username
     FROM projects p LEFT JOIN users u ON p.user_id = u.id
     WHERE p.deleted_at IS NULL
     ORDER BY p.updated_at DESC`
  ).all() as any[]

  return rows.map(row => ({
    ...row,
    name: fixMojibake(row.name),
    data: JSON.parse(row.data)
  }))
}

// ── Get single project by id ──
export function getProject(id: string, userId?: string): ProjectRecord | null {
  const db = getDb()
  let row: any

  if (userId) {
    row = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).get(id, userId)
  } else {
    row = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE id = ? AND deleted_at IS NULL`
    ).get(id)
  }

  if (!row) return null
  return { ...row, data: JSON.parse(row.data) }
}

// ── Create a new project ──
export function createProject(name: string, type: 'manual' | 'ai' = 'manual', userId?: string): ProjectRecord {
  const db = getDb()

  // Check active project count for user
  let count: number
  if (userId) {
    count = (db.prepare(
      `SELECT COUNT(*) as cnt FROM projects WHERE deleted_at IS NULL AND user_id = ?`
    ).get(userId) as any).cnt
  } else {
    count = (db.prepare(
      `SELECT COUNT(*) as cnt FROM projects WHERE deleted_at IS NULL AND user_id IS NULL`
    ).get() as any).cnt
  }

  if (count >= MAX_PROJECTS_PER_USER) {
    throw new Error(`Limite de ${MAX_PROJECTS_PER_USER} projets atteinte. Supprimez un projet avant d'en créer un nouveau.`)
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  const emptyData: ProjectData = {
    videoFiles: [],
    transcript: [],
    segments: [],
    audioPaths: [],
    config: {},
    timestamp: Date.now(),
    projectName: name
  }

  db.prepare(
    `INSERT INTO projects (id, user_id, name, type, status, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`
  ).run(id, userId || null, name, type, JSON.stringify(emptyData), now, now)

  logger.info(`Project created: ${id} "${name}" (${type}) for user ${userId || 'anonymous'}`)
  return { id, user_id: userId || null, name, type, status: 'draft', data: emptyData, created_at: now, updated_at: now }
}

// ── Save/update project data ──
export function saveProject(id: string, data: ProjectData): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET data = ?, updated_at = ?, status = CASE
       WHEN status = 'processing' THEN status ELSE
       CASE WHEN json_array_length(json_extract(?, '$.segments')) > 0 THEN 'done' ELSE 'draft' END
     END
     WHERE id = ? AND deleted_at IS NULL`
  ).run(JSON.stringify(data), now, JSON.stringify(data), id)
}

// ── Auto-save ──
export function autoSaveProject(id: string, data: ProjectData): void {
  saveProject(id, data)
}

// ── Rename project ──
export function renameProject(id: string, name: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(name, now, id)
  logger.info(`Project renamed: ${id} → "${name}"`)
}

// ── Soft delete project ──
export function deleteProject(id: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(now, id)
  logger.info(`Project deleted: ${id}`)
}

// ── Update project status ──
export function updateProjectStatus(id: string, status: 'draft' | 'processing' | 'done'): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(status, now, id)
}

// ── Legacy compat: save without project id ──
export function saveLegacyProject(data: ProjectData, userId?: string): string {
  const name = data.projectName || 'Projet Sans Nom'
  const type = data.segments && data.segments.length > 0 ? 'ai' : 'manual'

  try {
    const project = createProject(name, type as 'manual' | 'ai', userId)
    saveProject(project.id, data)
    return project.id
  } catch {
    const db = getDb()
    const condition = userId
      ? { sql: 'deleted_at IS NULL AND user_id = ?', params: [userId] }
      : { sql: 'deleted_at IS NULL AND user_id IS NULL', params: [] }

    const oldest = db.prepare(
      `SELECT id FROM projects WHERE ${condition.sql} ORDER BY updated_at ASC LIMIT 1`
    ).get(...condition.params) as any

    if (oldest) {
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE projects SET name = ?, type = ?, data = ?, updated_at = ? WHERE id = ?`
      ).run(name, type, JSON.stringify(data), now, oldest.id)
      return oldest.id
    }
    throw new Error('Impossible de sauvegarder le projet')
  }
}

// ── Load project ──
export function loadProject(id: string): ProjectData | null {
  const record = getProject(id)
  return record ? record.data : null
}

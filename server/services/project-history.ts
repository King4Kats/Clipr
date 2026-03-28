import { getDb } from './database.js'
import { logger } from '../logger.js'
import { randomUUID } from 'crypto'

const MAX_PROJECTS = 6

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
  name: string
  type: 'manual' | 'ai'
  status: 'draft' | 'processing' | 'done'
  data: ProjectData
  created_at: string
  updated_at: string
}

// ── List active projects (not deleted), max 6, newest first ──
export function getProjectHistory(): ProjectRecord[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, name, type, status, data, created_at, updated_at
     FROM projects WHERE deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT ?`
  ).all(MAX_PROJECTS) as any[]

  return rows.map(row => ({
    ...row,
    data: JSON.parse(row.data)
  }))
}

// ── Get single project by id ──
export function getProject(id: string): ProjectRecord | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT id, name, type, status, data, created_at, updated_at
     FROM projects WHERE id = ? AND deleted_at IS NULL`
  ).get(id) as any
  if (!row) return null
  return { ...row, data: JSON.parse(row.data) }
}

// ── Create a new project ──
export function createProject(name: string, type: 'manual' | 'ai' = 'manual'): ProjectRecord {
  const db = getDb()

  // Check active project count
  const count = (db.prepare(
    `SELECT COUNT(*) as cnt FROM projects WHERE deleted_at IS NULL`
  ).get() as any).cnt

  if (count >= MAX_PROJECTS) {
    throw new Error(`Limite de ${MAX_PROJECTS} projets atteinte. Supprimez un projet avant d'en créer un nouveau.`)
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
    `INSERT INTO projects (id, name, type, status, data, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)`
  ).run(id, name, type, JSON.stringify(emptyData), now, now)

  logger.info(`Project created: ${id} "${name}" (${type})`)
  return { id, name, type, status: 'draft', data: emptyData, created_at: now, updated_at: now }
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

// ── Auto-save (same as save but also called during processing) ──
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

// ── Legacy compat: save without project id (creates new project) ──
export function saveLegacyProject(data: ProjectData): string {
  const name = data.projectName || 'Projet Sans Nom'
  const type = data.segments && data.segments.length > 0 ? 'ai' : 'manual'

  try {
    const project = createProject(name, type as 'manual' | 'ai')
    saveProject(project.id, data)
    return project.id
  } catch {
    // If at limit, overwrite the oldest
    const db = getDb()
    const oldest = db.prepare(
      `SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY updated_at ASC LIMIT 1`
    ).get() as any
    if (oldest) {
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE projects SET name = ?, type = ?, data = ?, updated_at = ?
         WHERE id = ?`
      ).run(name, type, JSON.stringify(data), now, oldest.id)
      return oldest.id
    }
    throw new Error('Impossible de sauvegarder le projet')
  }
}

// ── Load project (legacy compat) ──
export function loadProject(id: string): ProjectData | null {
  const record = getProject(id)
  return record ? record.data : null
}

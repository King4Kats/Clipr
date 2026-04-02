import { getDb } from './database.js'
import { logger } from '../logger.js'

export interface ShareRecord {
  id: number
  project_id: string
  user_id: string
  username: string
  email: string
  role: 'viewer' | 'editor'
  created_at: string
}

// ── Share a project with a user ──
export function shareProject(projectId: string, ownerId: string, targetUsername: string, role: 'viewer' | 'editor' = 'viewer'): ShareRecord {
  const db = getDb()

  // Verify project ownership
  const project = db.prepare(
    'SELECT id, user_id FROM projects WHERE id = ? AND deleted_at IS NULL'
  ).get(projectId) as any
  if (!project) throw new Error('Projet non trouvé')
  if (project.user_id !== ownerId) throw new Error('Seul le propriétaire peut partager ce projet')

  // Find target user
  const target = db.prepare(
    'SELECT id, username, email FROM users WHERE username = ?'
  ).get(targetUsername) as any
  if (!target) throw new Error(`Utilisateur "${targetUsername}" non trouvé`)
  if (target.id === ownerId) throw new Error('Vous ne pouvez pas partager avec vous-même')

  // Check if already shared
  const existing = db.prepare(
    'SELECT id FROM project_shares WHERE project_id = ? AND user_id = ?'
  ).get(projectId, target.id) as any
  if (existing) {
    // Update role
    db.prepare('UPDATE project_shares SET role = ? WHERE id = ?').run(role, existing.id)
    logger.info(`[Share] Updated share: project ${projectId} → ${targetUsername} (${role})`)
  } else {
    db.prepare(
      'INSERT INTO project_shares (project_id, user_id, role) VALUES (?, ?, ?)'
    ).run(projectId, target.id, role)
    logger.info(`[Share] Created share: project ${projectId} → ${targetUsername} (${role})`)
  }

  return {
    id: existing?.id || 0,
    project_id: projectId,
    user_id: target.id,
    username: target.username,
    email: target.email,
    role,
    created_at: new Date().toISOString()
  }
}

// ── Remove a share ──
export function unshareProject(projectId: string, ownerId: string, targetUserId: string): void {
  const db = getDb()

  const project = db.prepare(
    'SELECT user_id FROM projects WHERE id = ? AND deleted_at IS NULL'
  ).get(projectId) as any
  if (!project || project.user_id !== ownerId) throw new Error('Accès refusé')

  db.prepare('DELETE FROM project_shares WHERE project_id = ? AND user_id = ?').run(projectId, targetUserId)
  logger.info(`[Share] Removed share: project ${projectId}, user ${targetUserId}`)
}

// ── List shares for a project ──
export function getProjectShares(projectId: string): ShareRecord[] {
  const db = getDb()
  return db.prepare(
    `SELECT s.id, s.project_id, s.user_id, u.username, u.email, s.role, s.created_at
     FROM project_shares s JOIN users u ON s.user_id = u.id
     WHERE s.project_id = ?
     ORDER BY s.created_at`
  ).all(projectId) as ShareRecord[]
}

// ── Get projects shared WITH a user (not owned by them) ──
export function getSharedProjects(userId: string): any[] {
  const db = getDb()
  return db.prepare(
    `SELECT p.id, p.name, p.type, p.status, p.data, p.created_at, p.updated_at,
            s.role as share_role, u.username as owner_username
     FROM project_shares s
     JOIN projects p ON s.project_id = p.id
     JOIN users u ON p.user_id = u.id
     WHERE s.user_id = ? AND p.deleted_at IS NULL
     ORDER BY p.updated_at DESC`
  ).all(userId).map((row: any) => ({
    ...row,
    data: JSON.parse(row.data),
    shared: true
  }))
}

// ── Check if a user has access to a project (owner, shared, or admin) ──
export function hasAccess(projectId: string, userId: string, userRole?: string): { access: boolean; role: 'owner' | 'editor' | 'viewer' | 'admin' | null } {
  const db = getDb()

  // Check ownership
  const project = db.prepare(
    'SELECT user_id FROM projects WHERE id = ? AND deleted_at IS NULL'
  ).get(projectId) as any
  if (!project) return { access: false, role: null }
  if (project.user_id === userId) return { access: true, role: 'owner' }

  // Admin can access all projects (read-only)
  if (userRole === 'admin') return { access: true, role: 'admin' }

  // Check share
  const share = db.prepare(
    'SELECT role FROM project_shares WHERE project_id = ? AND user_id = ?'
  ).get(projectId, userId) as any
  if (share) return { access: true, role: share.role }

  return { access: false, role: null }
}

// ── Search users for sharing (autocomplete) ──
export function searchUsers(query: string, excludeUserId: string): { id: string; username: string; email: string }[] {
  const db = getDb()
  return db.prepare(
    `SELECT id, username, email FROM users
     WHERE id != ? AND (username LIKE ? OR email LIKE ?)
     LIMIT 10`
  ).all(excludeUserId, `%${query}%`, `%${query}%`) as any[]
}

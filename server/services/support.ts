/**
 * SUPPORT.TS — Messagerie utilisateur ↔ admins.
 *
 * Chaque utilisateur a UN fil de discussion avec l'equipe admin (DM).
 * Les messages sont stockes plat dans support_messages avec sender_role.
 * Les pieces jointes (images) sont sauvees dans data/support-attachments/.
 */

import { randomUUID } from 'crypto'
import { getDb } from './database.js'
import { logger } from '../logger.js'

export interface SupportMessage {
  id: string
  user_id: string
  sender_role: 'user' | 'admin'
  sender_id: string | null
  content: string
  attachment_path: string | null
  read_by_user: number
  read_by_admin: number
  created_at: string
}

/** Cree un message (user ou admin). attachmentPath = nom de fichier dans le dossier dedie. */
export function createMessage(args: {
  userId: string
  senderRole: 'user' | 'admin'
  senderId: string
  content: string
  attachmentPath?: string | null
}): SupportMessage {
  const db = getDb()
  const id = randomUUID()
  // Marque comme lu cote expediteur (l'autre partie devra ouvrir le chat pour le marquer)
  const readByUser = args.senderRole === 'user' ? 1 : 0
  const readByAdmin = args.senderRole === 'admin' ? 1 : 0
  db.prepare(
    `INSERT INTO support_messages
       (id, user_id, sender_role, sender_id, content, attachment_path, read_by_user, read_by_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.userId, args.senderRole, args.senderId, args.content, args.attachmentPath || null, readByUser, readByAdmin)
  logger.info(`[Support] Message ${args.senderRole} dans fil ${args.userId} (${args.content.length} chars${args.attachmentPath ? ', + image' : ''})`)
  return getMessageById(id)!
}

export function getMessageById(id: string): SupportMessage | null {
  const db = getDb()
  return db.prepare('SELECT * FROM support_messages WHERE id = ?').get(id) as SupportMessage | null
}

/** Recupere tous les messages d'un fil (un user). */
export function getThreadByUser(userId: string): SupportMessage[] {
  const db = getDb()
  return db.prepare('SELECT * FROM support_messages WHERE user_id = ? ORDER BY created_at ASC').all(userId) as SupportMessage[]
}

/** Compteur de messages non-lus cote user (envoyes par l'admin et non lus). */
export function unreadForUser(userId: string): number {
  const db = getDb()
  const r = db.prepare("SELECT COUNT(*) as cnt FROM support_messages WHERE user_id = ? AND sender_role = 'admin' AND read_by_user = 0").get(userId) as any
  return r.cnt
}

/** Marque tous les messages admin comme lus pour ce user. */
export function markReadByUser(userId: string): void {
  getDb().prepare("UPDATE support_messages SET read_by_user = 1 WHERE user_id = ? AND sender_role = 'admin'").run(userId)
}

/** Marque tous les messages user comme lus cote admin pour un fil donne. */
export function markReadByAdmin(userId: string): void {
  getDb().prepare("UPDATE support_messages SET read_by_admin = 1 WHERE user_id = ? AND sender_role = 'user'").run(userId)
}

/**
 * Liste de toutes les conversations avec aperçu pour l'admin :
 *   { user_id, username, email, last_message, last_at, unread_admin }
 * Triees par derniere activite descendante.
 */
export function listConversationsForAdmin(): Array<{
  user_id: string
  username: string
  email: string
  last_message: string
  last_at: string
  unread_admin: number
  has_attachment: number
}> {
  const db = getDb()
  return db.prepare(`
    SELECT
      u.id AS user_id,
      u.username,
      u.email,
      (SELECT content FROM support_messages WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM support_messages WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_at,
      (SELECT CASE WHEN attachment_path IS NOT NULL THEN 1 ELSE 0 END FROM support_messages WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS has_attachment,
      (SELECT COUNT(*) FROM support_messages WHERE user_id = u.id AND sender_role = 'user' AND read_by_admin = 0) AS unread_admin
    FROM users u
    WHERE EXISTS (SELECT 1 FROM support_messages WHERE user_id = u.id)
    ORDER BY last_at DESC
  `).all() as any
}

/** Total de messages user non lus tous fils confondus (pour le badge global de l'admin). */
export function totalUnreadForAdmins(): number {
  const r = getDb().prepare("SELECT COUNT(*) as cnt FROM support_messages WHERE sender_role = 'user' AND read_by_admin = 0").get() as any
  return r.cnt
}

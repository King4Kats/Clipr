/**
 * ASSISTANT.TS : CRUD conversations + messages pour l'outil chatbot.
 *
 * Stocke un fil de discussion par conversation (par utilisateur). Le streaming
 * de la reponse IA se fait dans la couche endpoint (server/index.ts) via SSE,
 * ce module se contente de la persistance.
 */

import { randomUUID } from 'node:crypto'
import { getDb } from './database.js'

export interface Conversation {
  id: string
  user_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

/** Liste les conversations d'un utilisateur, triees par date de mise a jour decroissante. */
export function listConversations(userId: string): Conversation[] {
  return getDb()
    .prepare('SELECT * FROM assistant_conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Conversation[]
}

/** Cree une nouvelle conversation vide pour l'utilisateur. */
export function createConversation(userId: string, title = 'Nouvelle conversation'): Conversation {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO assistant_conversations (id, user_id, title) VALUES (?, ?, ?)')
    .run(id, userId, title)
  return getDb().prepare('SELECT * FROM assistant_conversations WHERE id = ?').get(id) as Conversation
}

/** Recupere une conversation + tous ses messages, ou null si l'user n'a pas acces. */
export function getConversation(userId: string, convId: string): { conversation: Conversation; messages: Message[] } | null {
  const conv = getDb()
    .prepare('SELECT * FROM assistant_conversations WHERE id = ? AND user_id = ?')
    .get(convId, userId) as Conversation | undefined
  if (!conv) return null
  const messages = getDb()
    .prepare('SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(convId) as Message[]
  return { conversation: conv, messages }
}

/** Supprime une conversation (et tous ses messages via ON DELETE CASCADE). */
export function deleteConversation(userId: string, convId: string): boolean {
  const r = getDb()
    .prepare('DELETE FROM assistant_conversations WHERE id = ? AND user_id = ?')
    .run(convId, userId)
  return r.changes > 0
}

/** Renomme une conversation. */
export function renameConversation(userId: string, convId: string, title: string): boolean {
  const r = getDb()
    .prepare("UPDATE assistant_conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(title, convId, userId)
  return r.changes > 0
}

/** Ajoute un message dans une conversation (verifie que l'user en est proprietaire). */
export function addMessage(userId: string, convId: string, role: 'user' | 'assistant', content: string): Message | null {
  const owner = getDb()
    .prepare('SELECT user_id FROM assistant_conversations WHERE id = ?')
    .get(convId) as { user_id: string } | undefined
  if (!owner || owner.user_id !== userId) return null
  const id = randomUUID()
  getDb().prepare('INSERT INTO assistant_messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(id, convId, role, content)
  // Met aussi a jour updated_at de la conversation pour la remonter dans la sidebar
  getDb().prepare("UPDATE assistant_conversations SET updated_at = datetime('now') WHERE id = ?").run(convId)
  return getDb().prepare('SELECT * FROM assistant_messages WHERE id = ?').get(id) as Message
}

/** Genere un titre court (~40 chars) a partir du premier message user. */
export function generateTitle(firstUserMessage: string): string {
  const clean = firstUserMessage.replace(/\s+/g, ' ').trim()
  if (clean.length <= 40) return clean || 'Nouvelle conversation'
  return clean.slice(0, 37) + '...'
}

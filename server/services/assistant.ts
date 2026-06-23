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
  /** 'chat' = chat texte classique ; 'vision' = lecture d'image / OCR (qwen2.5vl). */
  kind: 'chat' | 'vision'
  created_at: string
  updated_at: string
}

/**
 * Une image jointe a un message du sous-outil "vision".
 * - id   : identifiant unique (UUID) genere a l'upload
 * - file : nom du fichier sur le disque (ex: "a1b2c3.jpg"), JAMAIS un chemin
 * - name : nom d'origine cote utilisateur (ex: "page12.jpg"), purement informatif
 */
export interface MessageImage {
  id: string
  file: string
  name: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  /** Images jointes (sous-outil vision). Vide pour les messages texte. */
  images?: MessageImage[]
}

/**
 * Liste les conversations d'un utilisateur, triees par date de mise a jour decroissante.
 * @param kind - Filtre optionnel : 'chat' ou 'vision'. Si omis, renvoie tout.
 */
export function listConversations(userId: string, kind?: 'chat' | 'vision'): Conversation[] {
  if (kind) {
    return getDb()
      .prepare('SELECT * FROM assistant_conversations WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC')
      .all(userId, kind) as Conversation[]
  }
  return getDb()
    .prepare('SELECT * FROM assistant_conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Conversation[]
}

/**
 * Cree une nouvelle conversation vide pour l'utilisateur.
 * @param kind - Type de conversation : 'chat' (defaut) ou 'vision'.
 */
export function createConversation(userId: string, title = 'Nouvelle conversation', kind: 'chat' | 'vision' = 'chat'): Conversation {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO assistant_conversations (id, user_id, title, kind) VALUES (?, ?, ?, ?)')
    .run(id, userId, title, kind)
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
  // Pour une conversation vision, on rattache a chaque message ses images.
  // (Une seule requete groupee plutot qu'une par message.)
  if (conv.kind === 'vision') {
    const imgs = getDb()
      .prepare(
        `SELECT ai.id, ai.file, ai.name, ai.message_id
         FROM assistant_images ai
         WHERE ai.conversation_id = ? AND ai.message_id IS NOT NULL`,
      )
      .all(convId) as (MessageImage & { message_id: string })[]
    const byMessage = new Map<string, MessageImage[]>()
    for (const im of imgs) {
      const list = byMessage.get(im.message_id) ?? []
      list.push({ id: im.id, file: im.file, name: im.name })
      byMessage.set(im.message_id, list)
    }
    for (const m of messages) {
      const list = byMessage.get(m.id)
      if (list && list.length) m.images = list
    }
  }
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

// ============================================================
// IMAGES DES MESSAGES "vision"
// ------------------------------------------------------------
// Les images jointes par l'utilisateur (pages de livre a lire) sont stockees
// sur le disque (cote endpoint) et reference es dans la table assistant_images.
// Cycle de vie :
//   1. Upload  -> addImage(...)            : la ligne est creee, message_id = NULL
//   2. Envoi   -> attachImagesToMessage(...) : on rattache les images au message
//   3. Lecture -> getConversation(...)     : chaque message porte ses images
// La cascade ON DELETE de la conversation supprime aussi les lignes ; les
// fichiers disque sont nettoyes cote endpoint avant suppression.
// ============================================================

/**
 * Enregistre une image fraichement uploadee pour une conversation vision.
 * Verifie que la conversation appartient bien a l'utilisateur ET qu'elle est
 * de type 'vision' (on n'accepte pas d'images dans un chat texte).
 *
 * @returns L'image creee (id/file/name) ou null si acces refuse.
 */
export function addImage(userId: string, convId: string, file: string, name: string): MessageImage | null {
  const conv = getDb()
    .prepare("SELECT user_id, kind FROM assistant_conversations WHERE id = ?")
    .get(convId) as { user_id: string; kind: string } | undefined
  if (!conv || conv.user_id !== userId || conv.kind !== 'vision') return null
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO assistant_images (id, conversation_id, file, name) VALUES (?, ?, ?, ?)')
    .run(id, convId, file, name.slice(0, 200))
  return { id, file, name }
}

/**
 * Rattache des images (deja uploadees, message_id NULL) au message qui vient
 * d'etre cree. Ne touche que les images de CETTE conversation encore libres,
 * ce qui empeche de "voler" l'image d'une autre conversation via son id.
 *
 * @returns La liste des images effectivement rattachees.
 */
export function attachImagesToMessage(convId: string, messageId: string, imageIds: string[]): MessageImage[] {
  if (!imageIds || imageIds.length === 0) return []
  const db = getDb()
  const attached: MessageImage[] = []
  const stmt = db.prepare(
    'UPDATE assistant_images SET message_id = ? WHERE id = ? AND conversation_id = ? AND message_id IS NULL',
  )
  const sel = db.prepare('SELECT id, file, name FROM assistant_images WHERE id = ?')
  for (const imgId of imageIds) {
    const r = stmt.run(messageId, imgId, convId)
    if (r.changes > 0) attached.push(sel.get(imgId) as MessageImage)
  }
  return attached
}

/** Renvoie les images d'un message donne (pour reconstruire le contexte / l'affichage). */
export function getImagesForMessage(messageId: string): MessageImage[] {
  return getDb()
    .prepare('SELECT id, file, name FROM assistant_images WHERE message_id = ? ORDER BY created_at ASC')
    .all(messageId) as MessageImage[]
}

/**
 * Pour servir une image en toute securite : renvoie son nom de fichier disque
 * SEULEMENT si elle appartient (via sa conversation) a l'utilisateur demandeur.
 *
 * @returns Le nom de fichier sur disque, ou null si introuvable / non autorise.
 */
export function getOwnedImageFile(userId: string, imageId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT ai.file AS file
       FROM assistant_images ai
       JOIN assistant_conversations c ON c.id = ai.conversation_id
       WHERE ai.id = ? AND c.user_id = ?`,
    )
    .get(imageId, userId) as { file: string } | undefined
  return row?.file ?? null
}

/** Liste tous les fichiers image d'une conversation (pour nettoyage disque avant suppression). */
export function listConversationImageFiles(userId: string, convId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT ai.file AS file
       FROM assistant_images ai
       JOIN assistant_conversations c ON c.id = ai.conversation_id
       WHERE ai.conversation_id = ? AND c.user_id = ?`,
    )
    .all(convId, userId) as { file: string }[]
  return rows.map((r) => r.file)
}

/** Genere un titre court (~40 chars) a partir du premier message user. */
export function generateTitle(firstUserMessage: string): string {
  const clean = firstUserMessage.replace(/\s+/g, ' ').trim()
  if (clean.length <= 40) return clean || 'Nouvelle conversation'
  return clean.slice(0, 37) + '...'
}

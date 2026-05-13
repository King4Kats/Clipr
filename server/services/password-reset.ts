/**
 * PASSWORD-RESET.TS — Reinitialisation de mot de passe par code a 6 chiffres.
 *
 * Workflow :
 * 1. Utilisateur saisit son email -> on genere un code 6 chiffres + l'envoie par mail
 * 2. Utilisateur saisit le code + nouveau mdp -> on verifie + met a jour
 *
 * Securite :
 * - Code stocke en hash (bcrypt), jamais en clair
 * - Expiration 15 min
 * - Max 5 tentatives par code
 * - Anciens codes invalides quand un nouveau est genere (utilise les memes endpoints)
 * - Reponse identique pour email inconnu et email connu (anti-enumeration)
 */

import bcrypt from 'bcryptjs'
import { randomUUID, randomInt } from 'crypto'
import { getDb } from './database.js'
import { logger } from '../logger.js'

const CODE_TTL_MIN = 15
const MAX_ATTEMPTS = 5

/**
 * Genere un code a 6 chiffres + cree une demande en DB.
 * Retourne { user, code } si l'email existe, sinon null.
 * Le code RETOURNE est en clair (pour l'envoi mail), seule sa version hash est en DB.
 */
export function createResetCode(email: string): { userId: string; username: string; email: string; code: string } | null {
  const db = getDb()
  const user = db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(email.toLowerCase()) as any
  if (!user) return null

  // Invalide les codes precedents non utilises pour cet user
  db.prepare("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0").run(user.id)

  // Genere code 6 chiffres (000000-999999) avec randomInt cryptographique
  const code = String(randomInt(0, 1000000)).padStart(6, '0')
  const codeHash = bcrypt.hashSync(code, 10)
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString()

  db.prepare(
    'INSERT INTO password_resets (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), user.id, codeHash, expiresAt)

  logger.info(`[PasswordReset] Code genere pour ${user.username}`)
  return { userId: user.id, username: user.username, email: user.email, code }
}

/**
 * Verifie le code soumis par l'utilisateur. Si valide, met a jour le mdp.
 * Throws une erreur claire (pour que le front l'affiche) en cas d'echec.
 */
export function verifyCodeAndResetPassword(email: string, code: string, newPassword: string): void {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Mot de passe trop court (min 8 caractères)')
  }
  const db = getDb()
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()) as any
  if (!user) throw new Error('Code invalide ou expire')

  // Recupere la derniere demande active pour cet user
  const reset = db.prepare(
    "SELECT id, code_hash, expires_at, attempts FROM password_resets WHERE user_id = ? AND used = 0 ORDER BY created_at DESC LIMIT 1"
  ).get(user.id) as any
  if (!reset) throw new Error('Code invalide ou expire')

  // Expire ?
  if (new Date(reset.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(reset.id)
    throw new Error('Code expire — redemandez un nouveau code')
  }

  // Trop de tentatives ?
  if (reset.attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(reset.id)
    throw new Error('Trop de tentatives — redemandez un nouveau code')
  }

  // Verifie le code
  if (!bcrypt.compareSync(code, reset.code_hash)) {
    db.prepare("UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?").run(reset.id)
    const remaining = MAX_ATTEMPTS - (reset.attempts + 1)
    throw new Error(`Code incorrect (${remaining} tentative${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''})`)
  }

  // Tout bon : update du mot de passe + marque le code comme utilise
  const newHash = bcrypt.hashSync(newPassword, 10)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id)
  db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(reset.id)

  logger.info(`[PasswordReset] Mot de passe reinitialise pour user ${user.id}`)
}

/**
 * Action admin : reset direct du mdp d'un utilisateur (sans code).
 * Genere un nouveau mdp aleatoire et le retourne (a afficher a l'admin).
 */
export function adminResetUserPassword(userId: string): string {
  const db = getDb()
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as any
  if (!user) throw new Error('Utilisateur introuvable')
  // Mdp temporaire de 12 caracteres (alphanum) facile a copier-coller
  const charset = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let newPwd = ''
  for (let i = 0; i < 12; i++) newPwd += charset[randomInt(0, charset.length)]
  const hash = bcrypt.hashSync(newPwd, 10)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)
  // Invalide aussi tous les codes de reset en cours
  db.prepare("UPDATE password_resets SET used = 1 WHERE user_id = ?").run(userId)
  logger.info(`[PasswordReset] Admin a reinitialise le mdp de ${user.username}`)
  return newPwd
}

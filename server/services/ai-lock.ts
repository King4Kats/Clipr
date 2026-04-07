/**
 * =============================================================================
 * Fichier : services/ai-lock.ts
 * Rôle    : Gère un système de verrou (lock) pour l'utilisation de l'IA.
 *           Comme l'IA est une ressource coûteuse et limitée, un seul utilisateur
 *           à la fois peut lancer une analyse IA. Ce service empêche les conflits
 *           en s'assurant qu'un seul "verrou" est actif à un instant donné.
 *
 *           Fonctionnement simplifié :
 *           - Avant de lancer une analyse IA, on "acquiert" le verrou.
 *           - Si quelqu'un d'autre utilise déjà l'IA, l'acquisition échoue.
 *           - Le verrou expire automatiquement après 30 minutes (sécurité).
 *           - Une fois l'analyse terminée, on "libère" le verrou.
 * =============================================================================
 */

// Importation de la fonction pour accéder à la base de données SQLite
import { getDb } from './database.js'

// Importation du logger pour tracer les événements liés aux verrous
import { logger } from '../logger.js'

/** Durée maximale d'un verrou en minutes. Au-delà, il est considéré comme expiré. */
const LOCK_TIMEOUT_MINUTES = 30

/**
 * Interface décrivant les informations d'un verrou actif.
 * Contient toutes les données nécessaires pour afficher qui utilise l'IA
 * et sur quel projet.
 */
export interface AiLockInfo {
  /** Identifiant unique de l'utilisateur qui détient le verrou */
  user_id: string
  /** Nom d'affichage de l'utilisateur */
  username: string
  /** Identifiant du projet en cours d'analyse */
  project_id: string
  /** Nom du projet en cours d'analyse */
  project_name: string
  /** Date/heure de début du verrou (format ISO) */
  started_at: string
  /** Date/heure d'expiration du verrou (format ISO) */
  expires_at: string
}

/**
 * Nettoie les verrous expirés de la base de données.
 * Cette fonction est appelée automatiquement avant chaque opération sur les verrous.
 * Cela évite qu'un verrou "fantôme" (par ex. si le serveur a crashé) bloque
 * indéfiniment l'accès à l'IA.
 */
function cleanExpiredLocks() {
  const db = getDb()
  const now = new Date().toISOString()

  // On supprime tous les verrous dont la date d'expiration est dépassée
  const deleted = db.prepare(
    `DELETE FROM ai_locks WHERE expires_at < ?`
  ).run(now)

  // On log un message si des verrous ont été nettoyés (utile pour le suivi)
  if (deleted.changes > 0) {
    logger.info(`[AI Lock] Cleaned ${deleted.changes} expired lock(s)`)
  }
}

/**
 * Vérifie s'il existe un verrou actif sur l'IA.
 * @returns Les informations du verrou actif, ou null si l'IA est disponible.
 *
 * Cette fonction est utile pour afficher dans l'interface qui utilise
 * actuellement l'IA et depuis combien de temps.
 */
export function getActiveLock(): AiLockInfo | null {
  // On nettoie d'abord les verrous expirés pour éviter les faux positifs
  cleanExpiredLocks()

  const db = getDb()

  // Requête SQL avec des JOIN pour récupérer le nom de l'utilisateur et du projet
  // en plus des données du verrou lui-même. On prend le verrou le plus récent.
  const row = db.prepare(
    `SELECT l.user_id, u.username, l.project_id, p.name as project_name, l.started_at, l.expires_at
     FROM ai_locks l
     JOIN users u ON l.user_id = u.id
     JOIN projects p ON l.project_id = p.id
     ORDER BY l.started_at DESC LIMIT 1`
  ).get() as any

  // Retourne le verrou trouvé ou null si aucun verrou actif
  return row || null
}

/**
 * Tente d'acquérir le verrou de l'IA pour un utilisateur et un projet donnés.
 * @param userId    - L'identifiant de l'utilisateur qui veut utiliser l'IA
 * @param projectId - L'identifiant du projet à analyser
 * @returns Un objet indiquant si l'acquisition a réussi, avec un message d'erreur le cas échéant
 *
 * Cas possibles :
 * 1. L'IA est libre -> on acquiert le verrou -> success: true
 * 2. L'IA est déjà utilisée par un AUTRE utilisateur -> success: false + message d'erreur
 * 3. L'IA est déjà utilisée par le MEME utilisateur -> on renouvelle le verrou -> success: true
 */
export function acquireLock(userId: string, projectId: string): { success: boolean; lock?: AiLockInfo; error?: string } {
  // Nettoyage préalable des verrous expirés
  cleanExpiredLocks()
  const db = getDb()

  // On vérifie si un verrou actif existe déjà
  const existing = getActiveLock()

  // Si un autre utilisateur détient le verrou, on refuse l'acquisition
  if (existing && existing.user_id !== userId) {
    return {
      success: false,
      lock: existing,
      error: `L'IA est utilisée par ${existing.username} sur le projet "${existing.project_name}"`
    }
  }

  // On supprime tout verrou existant de cet utilisateur (cas de relance d'analyse)
  db.prepare('DELETE FROM ai_locks WHERE user_id = ?').run(userId)

  // On calcule la date d'expiration : maintenant + 30 minutes
  const now = new Date()
  const expires = new Date(now.getTime() + LOCK_TIMEOUT_MINUTES * 60 * 1000)

  // On insère le nouveau verrou dans la base de données
  db.prepare(
    'INSERT INTO ai_locks (user_id, project_id, started_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(userId, projectId, now.toISOString(), expires.toISOString())

  logger.info(`[AI Lock] Acquired by user ${userId} for project ${projectId}`)

  return { success: true }
}

/**
 * Libère le verrou de l'IA pour un utilisateur donné.
 * Appelée quand l'analyse IA est terminée (succès ou échec).
 * @param userId - L'identifiant de l'utilisateur dont on libère le verrou
 */
export function releaseLock(userId: string) {
  const db = getDb()
  db.prepare('DELETE FROM ai_locks WHERE user_id = ?').run(userId)
  logger.info(`[AI Lock] Released by user ${userId}`)
}

/**
 * Libère le verrou associé à un projet spécifique.
 * Utile par exemple quand un projet est supprimé : on libère automatiquement
 * le verrou qui pourrait y être associé.
 * @param projectId - L'identifiant du projet dont on libère le verrou
 */
export function releaseLockForProject(projectId: string) {
  const db = getDb()
  db.prepare('DELETE FROM ai_locks WHERE project_id = ?').run(projectId)
}

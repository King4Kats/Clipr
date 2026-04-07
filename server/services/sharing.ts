/**
 * SHARING.TS : Service de partage de projets entre utilisateurs
 *
 * Ce fichier gère tout ce qui concerne le partage de projets :
 * - Partager un projet avec un autre utilisateur (avec rôle viewer ou editor)
 * - Retirer un partage
 * - Lister les partages d'un projet
 * - Lister les projets partagés AVEC un utilisateur (ceux qu'on lui a partagés)
 * - Vérifier les droits d'accès d'un utilisateur sur un projet
 * - Rechercher des utilisateurs (pour l'autocomplétion dans l'UI de partage)
 *
 * Modèle de permissions :
 * - 'owner'  : le propriétaire du projet (tous les droits)
 * - 'editor' : peut modifier le projet
 * - 'viewer' : peut uniquement consulter le projet
 * - 'admin'  : les administrateurs peuvent voir tous les projets (lecture seule)
 *
 * Les partages sont stockés dans la table "project_shares" de la base SQLite.
 */

// Accès à la base de données SQLite
import { getDb } from './database.js'
// Logger pour les messages de debug/info
import { logger } from '../logger.js'

/**
 * Interface décrivant un enregistrement de partage.
 * Chaque partage lie un projet à un utilisateur avec un rôle spécifique.
 */
export interface ShareRecord {
  id: number            // ID auto-incrémenté du partage en BDD
  project_id: string    // ID du projet partagé
  user_id: string       // ID de l'utilisateur avec qui le projet est partagé
  username: string      // Nom d'utilisateur (pour l'affichage dans l'UI)
  email: string         // Email de l'utilisateur
  role: 'viewer' | 'editor'  // Rôle accordé : lecteur ou éditeur
  created_at: string    // Date de création du partage
}

/**
 * Partage un projet avec un autre utilisateur.
 *
 * Seul le propriétaire du projet peut le partager. Si le partage existe déjà
 * (même projet + même utilisateur), on met simplement à jour le rôle.
 *
 * @param projectId - ID du projet à partager
 * @param ownerId - ID du propriétaire qui initie le partage
 * @param targetUsername - Nom d'utilisateur du destinataire
 * @param role - Rôle à attribuer : 'viewer' (défaut) ou 'editor'
 * @returns L'enregistrement de partage créé/mis à jour
 * @throws Error si le projet n'existe pas, si l'utilisateur n'est pas propriétaire,
 *         si le destinataire n'existe pas, ou si on essaie de partager avec soi-même
 */
export function shareProject(projectId: string, ownerId: string, targetUsername: string, role: 'viewer' | 'editor' = 'viewer'): ShareRecord {
  const db = getDb()

  // Vérification 1 : le projet existe-t-il et appartient-il à l'utilisateur ?
  const project = db.prepare(
    'SELECT id, user_id FROM projects WHERE id = ? AND deleted_at IS NULL'
  ).get(projectId) as any
  if (!project) throw new Error('Projet non trouvé')
  if (project.user_id !== ownerId) throw new Error('Seul le propriétaire peut partager ce projet')

  // Vérification 2 : l'utilisateur cible existe-t-il ?
  const target = db.prepare(
    'SELECT id, username, email FROM users WHERE username = ?'
  ).get(targetUsername) as any
  if (!target) throw new Error(`Utilisateur "${targetUsername}" non trouvé`)

  // Vérification 3 : on ne peut pas partager avec soi-même
  if (target.id === ownerId) throw new Error('Vous ne pouvez pas partager avec vous-même')

  // Vérification 4 : le partage existe-t-il déjà ?
  const existing = db.prepare(
    'SELECT id FROM project_shares WHERE project_id = ? AND user_id = ?'
  ).get(projectId, target.id) as any

  if (existing) {
    // Le partage existe déjà → on met à jour le rôle (ex: viewer → editor)
    db.prepare('UPDATE project_shares SET role = ? WHERE id = ?').run(role, existing.id)
    logger.info(`[Share] Updated share: project ${projectId} → ${targetUsername} (${role})`)
  } else {
    // Nouveau partage → on l'insère en base
    db.prepare(
      'INSERT INTO project_shares (project_id, user_id, role) VALUES (?, ?, ?)'
    ).run(projectId, target.id, role)
    logger.info(`[Share] Created share: project ${projectId} → ${targetUsername} (${role})`)
  }

  // On retourne l'objet ShareRecord pour que le client puisse l'afficher
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

/**
 * Retire un partage : l'utilisateur cible n'aura plus accès au projet.
 * Seul le propriétaire du projet peut retirer un partage.
 *
 * @param projectId - ID du projet
 * @param ownerId - ID du propriétaire qui retire le partage
 * @param targetUserId - ID de l'utilisateur à retirer
 * @throws Error si le projet n'existe pas ou si l'utilisateur n'est pas propriétaire
 */
export function unshareProject(projectId: string, ownerId: string, targetUserId: string): void {
  const db = getDb()

  // Vérification : seul le propriétaire peut retirer un partage
  const project = db.prepare(
    'SELECT user_id FROM projects WHERE id = ? AND deleted_at IS NULL'
  ).get(projectId) as any
  if (!project || project.user_id !== ownerId) throw new Error('Accès refusé')

  // Suppression du partage en base de données
  db.prepare('DELETE FROM project_shares WHERE project_id = ? AND user_id = ?').run(projectId, targetUserId)
  logger.info(`[Share] Removed share: project ${projectId}, user ${targetUserId}`)
}

/**
 * Liste tous les partages d'un projet donné.
 * Retourne la liste des utilisateurs avec qui le projet est partagé,
 * avec leur rôle et leurs informations.
 *
 * Fait une jointure avec la table "users" pour avoir le username et l'email.
 *
 * @param projectId - ID du projet
 * @returns Tableau de ShareRecord triés par date de création
 */
export function getProjectShares(projectId: string): ShareRecord[] {
  const db = getDb()
  return db.prepare(
    `SELECT s.id, s.project_id, s.user_id, u.username, u.email, s.role, s.created_at
     FROM project_shares s JOIN users u ON s.user_id = u.id
     WHERE s.project_id = ?
     ORDER BY s.created_at`
  ).all(projectId) as ShareRecord[]
}

/**
 * Récupère la liste des projets partagés AVEC un utilisateur.
 * Ce sont les projets dont il n'est PAS propriétaire mais auxquels
 * il a accès via un partage.
 *
 * Utile pour afficher la section "Projets partagés avec moi" dans l'interface.
 *
 * Fait une double jointure :
 * - project_shares → projects : pour avoir les détails du projet
 * - projects → users : pour avoir le nom du propriétaire
 *
 * @param userId - ID de l'utilisateur
 * @returns Tableau de projets avec les infos de partage (rôle, propriétaire)
 */
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
    data: JSON.parse(row.data),  // On parse le JSON stocké en BDD
    shared: true  // Flag pour que le client sache que c'est un projet partagé
  }))
}

/**
 * Vérifie si un utilisateur a accès à un projet et retourne son rôle.
 *
 * Ordre de vérification :
 * 1. Est-il le propriétaire ? → rôle 'owner'
 * 2. Est-il admin ? → rôle 'admin' (accès en lecture à tout)
 * 3. A-t-il un partage ? → rôle 'editor' ou 'viewer'
 * 4. Sinon → pas d'accès
 *
 * Cette fonction est utilisée comme garde (middleware) avant chaque opération
 * sur un projet pour s'assurer que l'utilisateur a les droits nécessaires.
 *
 * @param projectId - ID du projet
 * @param userId - ID de l'utilisateur
 * @param userRole - Rôle global de l'utilisateur ('admin' ou autre)
 * @returns { access: boolean, role: string | null }
 */
export function hasAccess(projectId: string, userId: string, userRole?: string): { access: boolean; role: 'owner' | 'editor' | 'viewer' | 'admin' | null } {
  const db = getDb()

  // Étape 1 : le projet existe-t-il ?
  const project = db.prepare(
    'SELECT user_id FROM projects WHERE id = ? AND deleted_at IS NULL'
  ).get(projectId) as any
  if (!project) return { access: false, role: null }

  // Étape 2 : l'utilisateur est-il le propriétaire ?
  if (project.user_id === userId) return { access: true, role: 'owner' }

  // Étape 3 : l'utilisateur est-il admin ? (accès lecture seule à tous les projets)
  if (userRole === 'admin') return { access: true, role: 'admin' }

  // Étape 4 : l'utilisateur a-t-il un partage sur ce projet ?
  const share = db.prepare(
    'SELECT role FROM project_shares WHERE project_id = ? AND user_id = ?'
  ).get(projectId, userId) as any
  if (share) return { access: true, role: share.role }

  // Aucun accès trouvé
  return { access: false, role: null }
}

/**
 * Recherche des utilisateurs par nom ou email (autocomplétion).
 * Utilisée dans l'interface de partage : quand l'utilisateur tape un nom,
 * cette fonction retourne les correspondances pour les suggérer.
 *
 * L'utilisateur courant est exclu des résultats (on ne peut pas se partager un projet).
 * Le résultat est limité à 10 suggestions maximum.
 *
 * @param query - Texte recherché (nom d'utilisateur ou email, même partiel)
 * @param excludeUserId - ID de l'utilisateur à exclure (l'utilisateur courant)
 * @returns Tableau d'utilisateurs correspondants { id, username, email }
 */
export function searchUsers(query: string, excludeUserId: string): { id: string; username: string; email: string }[] {
  const db = getDb()
  // LIKE '%query%' : recherche le texte n'importe où dans le username ou l'email
  return db.prepare(
    `SELECT id, username, email FROM users
     WHERE id != ? AND (username LIKE ? OR email LIKE ?)
     LIMIT 10`
  ).all(excludeUserId, `%${query}%`, `%${query}%`) as any[]
}

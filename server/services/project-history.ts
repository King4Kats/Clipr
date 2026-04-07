/**
 * PROJECT-HISTORY.TS : Gestion des projets et de leur historique
 *
 * Ce fichier gère tout le cycle de vie des projets dans Clipr :
 * - Créer, lire, modifier, renommer et supprimer des projets
 * - Lister les projets d'un utilisateur (max 6 actifs)
 * - Sauvegarder automatiquement les données d'un projet
 * - Gérer la compatibilité avec l'ancien système (legacy)
 *
 * Un projet contient les données d'une session de travail :
 * fichiers vidéo/audio, transcriptions, segments de montage, configuration, etc.
 *
 * La suppression est "soft" (douce) : on ne supprime pas vraiment le projet,
 * on met une date dans "deleted_at". Cela permet de récupérer un projet
 * supprimé par erreur.
 *
 * Limite : chaque utilisateur peut avoir au maximum 6 projets actifs.
 * Au-delà, il doit en supprimer un avant d'en créer un nouveau.
 */

// Accès à la base de données SQLite
import { getDb } from './database.js'
// Logger pour les messages de debug/info
import { logger } from '../logger.js'
// Génération d'identifiants uniques (UUID v4)
import { randomUUID } from 'crypto'

/**
 * Nombre maximum de projets actifs par utilisateur.
 * Cette limite évite d'accumuler trop de projets et de surcharger l'interface.
 */
const MAX_PROJECTS_PER_USER = 6

/**
 * Corrige les problèmes d'encodage "mojibake".
 *
 * Le mojibake, c'est quand un texte UTF-8 est mal décodé en latin1.
 * Par exemple : "rescapée" → "rescapÃ©e"
 *
 * Cette fonction détecte ces patterns typiques (Ã suivi d'un autre caractère)
 * et corrige l'encodage en repassant par un Buffer.
 *
 * @param str - La chaîne potentiellement corrompue
 * @returns La chaîne corrigée, ou l'originale si pas de problème détecté
 */
function fixMojibake(str: string): string {
  try {
    // On vérifie si la chaîne contient des séquences typiques de mojibake
    // (caractères UTF-8 mal interprétés en latin1)
    if (/[\xC0-\xDF][\x80-\xBF]/.test(str) || /\xC3[\x80-\xBF]/.test(str)) {
      // On ré-encode en latin1 puis on décode en UTF-8 pour corriger
      const fixed = Buffer.from(str, 'latin1').toString('utf-8')
      // On vérifie que le résultat est valide et différent de l'original
      // \uFFFD = caractère de remplacement Unicode (indique un décodage raté)
      if (fixed !== str && !fixed.includes('\uFFFD')) return fixed
    }
  } catch { /* En cas d'erreur, on retourne l'original sans modification */ }
  return str
}

/**
 * Interface décrivant un élément de transcription dans un projet.
 * Quand un projet contient plusieurs fichiers à transcrire,
 * chaque fichier est représenté par un TranscriptionItem.
 */
export interface TranscriptionItem {
  transcriptionId?: string    // ID de la transcription une fois terminée
  filename: string            // Nom du fichier audio/vidéo
  duration?: number           // Durée en secondes
  status: 'processing' | 'done' | 'error'  // État de la transcription
  taskId?: string             // ID de la tâche dans la queue
}

/**
 * Interface décrivant les données internes d'un projet.
 * C'est le contenu stocké dans la colonne "data" (JSON) de la table projects.
 * Contient toutes les informations de travail du projet.
 */
export interface ProjectData {
  videoFiles: any[]               // Liste des fichiers vidéo importés
  transcript: any[]               // Transcription complète
  segments: any[]                 // Segments de montage
  audioPaths?: string[]           // Chemins des fichiers audio extraits
  config: any                     // Configuration du projet (langue, modèle, etc.)
  timestamp: number               // Timestamp de création (millisecondes)
  projectName: string             // Nom du projet
  toolType?: 'transcription' | 'linguistic'  // Type d'outil utilisé
  transcriptionItems?: TranscriptionItem[]   // Éléments de transcription (multi-fichiers)
  linguisticId?: string           // ID de l'analyse linguistique associée
  linguisticItems?: any[]         // Éléments d'analyse linguistique
  sequenceCount?: number          // Nombre de séquences de montage
}

/**
 * Interface décrivant un enregistrement de projet complet (tel que stocké en BDD).
 * Combine les métadonnées du projet (id, nom, type, statut, dates) et ses données.
 */
export interface ProjectRecord {
  id: string                      // Identifiant unique du projet (UUID)
  user_id: string | null          // ID du propriétaire (null = anonyme)
  name: string                    // Nom du projet
  type: 'manual' | 'ai'          // Type : manuel ou généré par IA
  status: 'draft' | 'processing' | 'done'  // Statut : brouillon, en cours, terminé
  data: ProjectData               // Données internes du projet (objet JSON)
  created_at: string              // Date de création (ISO)
  updated_at: string              // Date de dernière modification (ISO)
}

/**
 * Liste les projets actifs d'un utilisateur (max 6, les plus récents en premier).
 * Les projets "soft-deleted" (avec deleted_at rempli) sont exclus.
 *
 * Applique la correction mojibake sur les noms de projets et de fichiers
 * pour éviter les caractères corrompus dans l'interface.
 *
 * @param userId - ID de l'utilisateur (undefined = projets anonymes)
 * @returns Tableau de ProjectRecord triés par date de modification décroissante
 */
export function getProjectHistory(userId?: string): ProjectRecord[] {
  const db = getDb()
  let rows: any[]

  if (userId) {
    // Récupère les projets de l'utilisateur spécifié
    rows = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE deleted_at IS NULL AND user_id = ?
       ORDER BY updated_at DESC LIMIT ?`
    ).all(userId, MAX_PROJECTS_PER_USER)
  } else {
    // Récupère les projets anonymes (sans propriétaire)
    rows = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE deleted_at IS NULL AND user_id IS NULL
       ORDER BY updated_at DESC LIMIT ?`
    ).all(MAX_PROJECTS_PER_USER)
  }

  // On parse les données JSON et on corrige les problèmes d'encodage
  return rows.map(row => {
    const data = JSON.parse(row.data)
    // Correction mojibake sur les noms de fichiers vidéo
    if (data.videoFiles) {
      data.videoFiles = data.videoFiles.map((vf: any) => ({
        ...vf,
        name: vf.name ? fixMojibake(vf.name) : vf.name
      }))
    }
    // Correction mojibake sur le nom du projet dans les données
    if (data.projectName) data.projectName = fixMojibake(data.projectName)
    // Correction mojibake sur le nom du projet dans les métadonnées
    return { ...row, name: fixMojibake(row.name), data }
  })
}

/**
 * Liste TOUS les projets de tous les utilisateurs (réservé aux administrateurs).
 * Inclut le nom du propriétaire via une jointure avec la table users.
 *
 * @returns Tableau de tous les projets actifs avec le username du propriétaire
 */
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

/**
 * Récupère un projet par son ID.
 * Si userId est fourni, on vérifie que le projet appartient bien à cet utilisateur.
 * Si userId n'est pas fourni, on retourne le projet sans vérification de propriété
 * (utilisé en interne par d'autres services).
 *
 * @param id - ID du projet
 * @param userId - ID du propriétaire (optionnel, pour filtrage de sécurité)
 * @returns Le projet trouvé, ou null s'il n'existe pas
 */
export function getProject(id: string, userId?: string): ProjectRecord | null {
  const db = getDb()
  let row: any

  if (userId) {
    // Requête avec vérification du propriétaire
    row = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).get(id, userId)
  } else {
    // Requête sans vérification (usage interne)
    row = db.prepare(
      `SELECT id, user_id, name, type, status, data, created_at, updated_at
       FROM projects WHERE id = ? AND deleted_at IS NULL`
    ).get(id)
  }

  if (!row) return null
  // On parse le JSON des données du projet
  return { ...row, data: JSON.parse(row.data) }
}

/**
 * Crée un nouveau projet avec des données vides.
 * Vérifie d'abord que l'utilisateur n'a pas atteint la limite de 6 projets.
 *
 * @param name - Nom du projet
 * @param type - Type : 'manual' (créé à la main) ou 'ai' (généré par IA)
 * @param userId - ID du propriétaire (optionnel, undefined = anonyme)
 * @returns Le projet créé
 * @throws Error si la limite de projets est atteinte
 */
export function createProject(name: string, type: 'manual' | 'ai' = 'manual', userId?: string): ProjectRecord {
  const db = getDb()

  // Vérification du nombre de projets actifs de l'utilisateur
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

  // Si la limite est atteinte, on lève une erreur
  if (count >= MAX_PROJECTS_PER_USER) {
    throw new Error(`Limite de ${MAX_PROJECTS_PER_USER} projets atteinte. Supprimez un projet avant d'en créer un nouveau.`)
  }

  // Création du projet avec des données vides
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

  // Insertion en base de données avec le statut initial 'draft' (brouillon)
  db.prepare(
    `INSERT INTO projects (id, user_id, name, type, status, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`
  ).run(id, userId || null, name, type, JSON.stringify(emptyData), now, now)

  logger.info(`Project created: ${id} "${name}" (${type}) for user ${userId || 'anonymous'}`)
  return { id, user_id: userId || null, name, type, status: 'draft', data: emptyData, created_at: now, updated_at: now }
}

/**
 * Sauvegarde les données d'un projet existant.
 * Met aussi à jour le statut automatiquement :
 * - Si le projet a des segments → statut 'done'
 * - Sinon → statut 'draft'
 * - Exception : si le statut est 'processing', on ne le change pas
 *   (pour ne pas interférer avec une transcription en cours)
 *
 * @param id - ID du projet
 * @param data - Les nouvelles données du projet
 */
export function saveProject(id: string, data: ProjectData): void {
  const db = getDb()
  const now = new Date().toISOString()
  // La requête SQL utilise un CASE pour déterminer le statut automatiquement
  // json_array_length + json_extract vérifie si le tableau "segments" contient des éléments
  db.prepare(
    `UPDATE projects SET data = ?, updated_at = ?, status = CASE
       WHEN status = 'processing' THEN status ELSE
       CASE WHEN json_array_length(json_extract(?, '$.segments')) > 0 THEN 'done' ELSE 'draft' END
     END
     WHERE id = ? AND deleted_at IS NULL`
  ).run(JSON.stringify(data), now, JSON.stringify(data), id)
}

/**
 * Sauvegarde automatique du projet (alias de saveProject).
 * Existe pour des raisons sémantiques : le code appelant peut distinguer
 * une sauvegarde explicite d'une sauvegarde automatique (auto-save).
 *
 * @param id - ID du projet
 * @param data - Les données à sauvegarder
 */
export function autoSaveProject(id: string, data: ProjectData): void {
  saveProject(id, data)
}

/**
 * Renomme un projet. Met aussi à jour la date de modification.
 *
 * @param id - ID du projet
 * @param name - Nouveau nom
 */
export function renameProject(id: string, name: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(name, now, id)
  logger.info(`Project renamed: ${id} → "${name}"`)
}

/**
 * Supprime un projet de manière "soft" (douce).
 * Au lieu de supprimer la ligne en base, on met une date dans "deleted_at".
 * Le projet ne sera plus visible mais pourra être récupéré si besoin.
 *
 * @param id - ID du projet à supprimer
 */
export function deleteProject(id: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(now, id)
  logger.info(`Project deleted: ${id}`)
}

/**
 * Met à jour le statut d'un projet manuellement.
 * Utilisé par le pipeline de transcription pour indiquer que le projet
 * est en cours de traitement ('processing') ou terminé ('done').
 *
 * @param id - ID du projet
 * @param status - Nouveau statut : 'draft', 'processing' ou 'done'
 */
export function updateProjectStatus(id: string, status: 'draft' | 'processing' | 'done'): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(status, now, id)
}

/**
 * Sauvegarde un projet en mode "legacy" (compatibilité avec l'ancien système).
 *
 * L'ancien système n'avait pas de concept de projet : les données étaient
 * sauvegardées directement. Cette fonction crée un projet et y sauvegarde les données.
 *
 * Si la limite de projets est atteinte, au lieu d'échouer, elle écrase le projet
 * le plus ancien (celui qui n'a pas été modifié depuis le plus longtemps).
 *
 * @param data - Les données du projet à sauvegarder
 * @param userId - ID du propriétaire (optionnel)
 * @returns L'ID du projet créé ou mis à jour
 */
export function saveLegacyProject(data: ProjectData, userId?: string): string {
  const name = data.projectName || 'Projet Sans Nom'
  // On détermine le type en fonction de la présence de segments
  const type = data.segments && data.segments.length > 0 ? 'ai' : 'manual'

  try {
    // Tentative de création d'un nouveau projet
    const project = createProject(name, type as 'manual' | 'ai', userId)
    saveProject(project.id, data)
    return project.id
  } catch {
    // Si la limite est atteinte, on écrase le projet le plus ancien
    const db = getDb()
    const condition = userId
      ? { sql: 'deleted_at IS NULL AND user_id = ?', params: [userId] }
      : { sql: 'deleted_at IS NULL AND user_id IS NULL', params: [] }

    // Récupère le projet le plus ancien (celui modifié il y a le plus longtemps)
    const oldest = db.prepare(
      `SELECT id FROM projects WHERE ${condition.sql} ORDER BY updated_at ASC LIMIT 1`
    ).get(...condition.params) as any

    if (oldest) {
      // On écrase ce projet avec les nouvelles données
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE projects SET name = ?, type = ?, data = ?, updated_at = ? WHERE id = ?`
      ).run(name, type, JSON.stringify(data), now, oldest.id)
      return oldest.id
    }
    throw new Error('Impossible de sauvegarder le projet')
  }
}

/**
 * Charge les données d'un projet par son ID.
 * Raccourci pratique qui retourne directement les données (ProjectData)
 * au lieu du record complet (ProjectRecord).
 *
 * @param id - ID du projet
 * @returns Les données du projet, ou null si non trouvé
 */
export function loadProject(id: string): ProjectData | null {
  const record = getProject(id)
  return record ? record.data : null
}

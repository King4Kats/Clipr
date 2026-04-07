/**
 * TASK-QUEUE.TS : File d'attente FIFO pour les tâches IA
 *
 * Ce fichier gère une file d'attente de tâches (transcription, analyse, etc.)
 * qui s'exécutent une par une. Pourquoi une seule à la fois ? Parce que la
 * mémoire GPU (VRAM) est partagée entre Whisper (transcription) et Ollama (IA),
 * donc on ne peut pas lancer plusieurs tâches lourdes en parallèle.
 *
 * Principe FIFO : "First In, First Out" — la première tâche ajoutée est la
 * première traitée, comme une file d'attente au supermarché.
 *
 * Fonctionnement :
 * 1. Un utilisateur soumet une tâche → elle est ajoutée à la queue (enqueueTask)
 * 2. Si aucune tâche ne tourne, on lance la suivante (processNext)
 * 3. Quand une tâche se termine, on passe à la suivante automatiquement
 * 4. Les utilisateurs sont notifiés en temps réel via WebSocket (broadcastFn)
 */

// On importe la fonction pour accéder à la base de données SQLite
import { getDb } from './database.js'
// randomUUID génère un identifiant unique (ex: "550e8400-e29b-41d4-a716-446655440000")
import { randomUUID } from 'crypto'
// Le logger permet d'écrire des messages dans la console/les logs du serveur
import { logger } from '../logger.js'

/**
 * Les différents types de tâches que la queue peut gérer.
 * - 'analysis' : analyse IA d'un contenu
 * - 'transcription' : conversion audio → texte avec Whisper
 * - 'linguistic' : analyse linguistique du texte
 */
export type TaskType = 'analysis' | 'transcription' | 'linguistic'

/**
 * Les statuts possibles d'une tâche dans son cycle de vie :
 * - 'pending'   : en attente dans la queue (pas encore démarrée)
 * - 'running'   : en cours d'exécution
 * - 'completed' : terminée avec succès
 * - 'failed'    : échouée (erreur)
 * - 'cancelled' : annulée par l'utilisateur
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * Interface décrivant une tâche dans la file d'attente.
 * Chaque tâche est stockée en base de données avec toutes ces informations.
 */
export interface QueueTask {
  id: string                    // Identifiant unique de la tâche (UUID)
  user_id: string               // ID de l'utilisateur qui a soumis la tâche
  type: TaskType                // Type de tâche (transcription, analyse, etc.)
  status: TaskStatus            // Statut actuel de la tâche
  project_id: string | null     // ID du projet associé (optionnel)
  config: any                   // Configuration spécifique à la tâche (chemin fichier, langue, etc.)
  result: any | null            // Résultat de la tâche une fois terminée
  progress: number              // Progression en pourcentage (0 à 100)
  progress_message: string | null // Message décrivant l'étape en cours
  position: number | null       // Position dans la file d'attente
  created_at: string            // Date de création (format ISO)
  started_at: string | null     // Date de début d'exécution
  completed_at: string | null   // Date de fin (succès ou échec)
}

/**
 * Type pour la fonction de diffusion (broadcast) qui envoie des messages
 * en temps réel aux clients connectés via WebSocket.
 * Paramètres : userId (destinataire), projectId, type d'événement, données
 */
type BroadcastFn = (userId: string, projectId: string | null, type: string, data: any) => void

/**
 * Type pour les fonctions "runners" qui exécutent réellement les tâches.
 * Chaque type de tâche a son propre runner (ex: le runner de transcription
 * appelle Whisper, le runner d'analyse appelle Ollama, etc.)
 */
type PipelineRunner = (task: QueueTask, broadcastFn: BroadcastFn) => Promise<any>

// Variable globale : ID de la tâche actuellement en cours d'exécution (null si aucune)
let currentRunningTaskId: string | null = null

// Dictionnaire qui associe chaque type de tâche à sa fonction d'exécution
let pipelineRunners: Record<TaskType, PipelineRunner> = {} as any

// Référence vers la fonction de broadcast WebSocket (initialisée au démarrage)
let broadcastFn: BroadcastFn | null = null

/**
 * Initialise la file d'attente au démarrage du serveur.
 * On lui fournit les "runners" (fonctions d'exécution pour chaque type de tâche)
 * et la fonction de broadcast pour notifier les clients.
 * Appelle aussi recoverOnStartup() pour gérer les tâches orphelines après un crash.
 */
export function initQueue(
  runners: Record<TaskType, PipelineRunner>,
  broadcast: BroadcastFn
) {
  pipelineRunners = runners
  broadcastFn = broadcast
  // Récupération après un redémarrage : les tâches "running" sont marquées comme échouées
  recoverOnStartup()
}

/**
 * Ajoute une nouvelle tâche dans la file d'attente.
 * La tâche est créée avec le statut 'pending' et une position dans la queue.
 * Après l'insertion, on tente de lancer la prochaine tâche (si aucune ne tourne).
 *
 * @param userId - L'utilisateur qui soumet la tâche
 * @param type - Le type de tâche (transcription, analyse, etc.)
 * @param config - La configuration de la tâche (chemin du fichier, langue, modèle, etc.)
 * @param projectId - L'ID du projet associé (optionnel)
 * @returns La tâche créée avec toutes ses informations
 */
export function enqueueTask(
  userId: string,
  type: TaskType,
  config: any,
  projectId?: string
): QueueTask {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()

  // On récupère la position maximale actuelle dans la queue pour placer cette
  // tâche à la fin. Si la queue est vide, on commence à la position 1.
  const maxPos = db.prepare(
    `SELECT MAX(position) as maxPos FROM task_queue WHERE status IN ('pending', 'running')`
  ).get() as any
  const position = (maxPos?.maxPos ?? 0) + 1

  // Insertion de la tâche en base de données
  db.prepare(
    `INSERT INTO task_queue (id, user_id, type, status, project_id, config, progress, position, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, 0, ?, ?)`
  ).run(id, userId, type, projectId || null, JSON.stringify(config), position, now)

  logger.info(`[Queue] Task ${id} enqueued: type=${type} user=${userId} position=${position}`)

  // On relit la tâche depuis la BDD pour avoir l'objet complet bien formaté
  const task = getTaskById(id)!

  // On notifie l'utilisateur que sa tâche a été ajoutée à la queue
  if (broadcastFn) {
    broadcastFn(userId, null, 'queue:update', { task, queue: getQueueState(userId) })
  }

  // On essaie de lancer la prochaine tâche (si rien ne tourne actuellement)
  processNext()

  return task
}

/**
 * Fonction interne : lance la prochaine tâche en attente dans la file.
 * Cette fonction est appelée :
 * - Après l'ajout d'une nouvelle tâche (enqueueTask)
 * - Après la fin d'une tâche (completeTask)
 * - Au démarrage du serveur (recoverOnStartup)
 *
 * Si une tâche est déjà en cours, on ne fait rien (une seule à la fois).
 */
function processNext() {
  // Si une tâche tourne déjà, on attend qu'elle se termine
  if (currentRunningTaskId) return

  const db = getDb()

  // On récupère la tâche en attente avec la position la plus basse (la plus ancienne)
  const next = db.prepare(
    `SELECT * FROM task_queue WHERE status = 'pending' ORDER BY position ASC LIMIT 1`
  ).get() as any

  // Si aucune tâche en attente, on s'arrête
  if (!next) return

  // On marque cette tâche comme "en cours d'exécution"
  currentRunningTaskId = next.id
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE task_queue SET status = 'running', started_at = ? WHERE id = ?`
  ).run(now, next.id)

  const task = getTaskById(next.id)!
  logger.info(`[Queue] Starting task ${task.id}: type=${task.type}`)

  // On notifie l'utilisateur que sa tâche a démarré, et on met à jour
  // les positions de tous les utilisateurs qui ont des tâches en attente
  if (broadcastFn) {
    broadcastFn(task.user_id, task.project_id, 'queue:task-started', { taskId: task.id, type: task.type })
    broadcastQueueUpdates()
  }

  // On récupère le "runner" correspondant au type de tâche
  // (ex: pour 'transcription', on utilise le pipeline de transcription Whisper)
  const runner = pipelineRunners[task.type]
  if (!runner) {
    // Si aucun runner n'est défini pour ce type, la tâche échoue
    completeTask(task.id, 'failed', null, `Unknown task type: ${task.type}`)
    return
  }

  // Exécution asynchrone de la tâche en arrière-plan.
  // .then() gère le succès, le second callback gère l'erreur.
  runner(task, broadcastFn!).then(
    (result) => completeTask(task.id, 'completed', result),
    (err) => completeTask(task.id, 'failed', null, err?.message || 'Unknown error')
  )
}

/**
 * Fonction interne : marque une tâche comme terminée (succès ou échec).
 * Met à jour la BDD, notifie l'utilisateur, puis lance la tâche suivante.
 *
 * @param taskId - ID de la tâche terminée
 * @param status - 'completed' (succès) ou 'failed' (échec)
 * @param result - Résultat de la tâche (en cas de succès)
 * @param errorMessage - Message d'erreur (en cas d'échec)
 */
function completeTask(taskId: string, status: 'completed' | 'failed', result: any, errorMessage?: string) {
  const db = getDb()
  const now = new Date().toISOString()

  // On prépare le résultat à stocker en JSON dans la BDD
  // En cas d'échec, on stocke le message d'erreur ; en cas de succès, le résultat
  const resultJson = status === 'failed'
    ? JSON.stringify({ error: errorMessage })
    : result ? JSON.stringify(result) : null

  // Mise à jour de la tâche en base : statut, résultat, date de fin, progression
  db.prepare(
    `UPDATE task_queue SET status = ?, result = ?, completed_at = ?, progress = ?, progress_message = ? WHERE id = ?`
  ).run(status, resultJson, now, status === 'completed' ? 100 : 0, errorMessage || null, taskId)

  // Notification en temps réel à l'utilisateur (succès ou échec)
  const task = getTaskById(taskId)
  if (task && broadcastFn) {
    const eventType = status === 'completed' ? 'queue:task-completed' : 'queue:task-failed'
    broadcastFn(task.user_id, task.project_id, eventType, {
      taskId: task.id,
      type: task.type,
      result: task.result,
      error: errorMessage
    })
  }

  logger.info(`[Queue] Task ${taskId} ${status}${errorMessage ? ': ' + errorMessage : ''}`)

  // On libère le "verrou" : plus aucune tâche ne tourne
  currentRunningTaskId = null
  // On lance automatiquement la tâche suivante dans la queue
  processNext()
}

/**
 * Met à jour la progression d'une tâche en cours.
 * Appelée par les pipelines (Whisper, Ollama, etc.) pour signaler l'avancement.
 *
 * Optimisation : on n'écrit en BDD que si la progression a changé d'au moins 5%,
 * pour éviter de surcharger la base avec des écritures trop fréquentes.
 *
 * @param taskId - ID de la tâche
 * @param progress - Progression en pourcentage (0-100)
 * @param message - Message décrivant l'étape en cours
 */
export function updateTaskProgress(taskId: string, progress: number, message: string) {
  const db = getDb()
  // On ne met à jour que si la progression a changé d'au moins 5 points
  const current = db.prepare(`SELECT progress FROM task_queue WHERE id = ?`).get(taskId) as any
  if (current && Math.abs(current.progress - progress) >= 5) {
    db.prepare(
      `UPDATE task_queue SET progress = ?, progress_message = ? WHERE id = ?`
    ).run(Math.round(progress), message, taskId)
  }
}

/**
 * Annule une tâche. Deux cas possibles :
 * 1. Tâche en attente ('pending') → on la marque comme annulée simplement
 * 2. Tâche en cours ('running') → on tue le processus Whisper et on la marque échouée
 *
 * Seul l'utilisateur propriétaire de la tâche peut l'annuler.
 *
 * @param taskId - ID de la tâche à annuler
 * @param userId - ID de l'utilisateur qui demande l'annulation
 * @returns Un objet { success, error? } indiquant si l'annulation a réussi
 */
export function cancelTask(taskId: string, userId: string): { success: boolean; error?: string } {
  const db = getDb()
  const task = getTaskById(taskId)

  // Vérifications : la tâche existe-t-elle ? L'utilisateur est-il le propriétaire ?
  if (!task) return { success: false, error: 'Tâche introuvable' }
  if (task.user_id !== userId) return { success: false, error: 'Non autorisé' }

  // Cas 1 : tâche en attente → on la marque simplement comme annulée
  if (task.status === 'pending') {
    db.prepare(`UPDATE task_queue SET status = 'cancelled', completed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), taskId)
    logger.info(`[Queue] Task ${taskId} cancelled (was pending)`)

    if (broadcastFn) {
      broadcastFn(userId, null, 'queue:update', { task: getTaskById(taskId), queue: getQueueState(userId) })
    }
    return { success: true }
  }

  // Cas 2 : tâche en cours → on tente de tuer le processus Whisper associé
  if (task.status === 'running') {
    try {
      // Import dynamique du service Whisper pour appeler sa fonction d'annulation
      const whisperService = require('./whisper.js')
      whisperService.cancelTranscription()
    } catch { /* On ignore l'erreur si Whisper n'est pas en cours */ }

    // On marque la tâche comme échouée avec un message explicite
    completeTask(taskId, 'failed', null, 'Annulé par l\'utilisateur')
    return { success: true }
  }

  // Si la tâche est déjà terminée/échouée/annulée, on ne peut plus l'annuler
  return { success: false, error: 'La tâche ne peut pas être annulée (statut: ' + task.status + ')' }
}

/**
 * Récupère une tâche par son identifiant unique.
 * Utilise parseTaskRow() pour convertir la ligne brute de la BDD en objet QueueTask.
 *
 * @param taskId - L'identifiant unique de la tâche
 * @returns La tâche trouvée, ou null si elle n'existe pas
 */
export function getTaskById(taskId: string): QueueTask | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM task_queue WHERE id = ?`).get(taskId) as any
  if (!row) return null
  return parseTaskRow(row)
}

/**
 * Récupère l'état global de la file d'attente pour un utilisateur donné.
 * Retourne :
 * - currentTask : la tâche actuellement en cours (tous utilisateurs confondus)
 * - userTasks : les tâches de l'utilisateur (en attente ou en cours)
 * - totalPending : le nombre total de tâches en attente dans la queue
 *
 * Cette information est envoyée au client pour afficher l'état de la queue dans l'UI.
 */
export function getQueueState(userId?: string): {
  currentTask: QueueTask | null
  userTasks: QueueTask[]
  totalPending: number
} {
  const db = getDb()

  // Récupère la tâche en cours d'exécution (il n'y en a qu'une max)
  // On joint avec la table users pour avoir le nom de l'utilisateur
  const runningRow = db.prepare(
    `SELECT q.*, u.username FROM task_queue q JOIN users u ON q.user_id = u.id WHERE q.status = 'running' LIMIT 1`
  ).get() as any

  const currentTask = runningRow ? { ...parseTaskRow(runningRow), username: runningRow.username } : null

  // Récupère les tâches de l'utilisateur spécifié (en attente + en cours)
  let userTasks: QueueTask[] = []
  if (userId) {
    const rows = db.prepare(
      `SELECT * FROM task_queue WHERE user_id = ? AND status IN ('pending', 'running') ORDER BY position ASC`
    ).all(userId) as any[]
    userTasks = rows.map(parseTaskRow)

    // Calcul de la position réelle de chaque tâche parmi TOUTES les tâches en attente
    // (pas seulement celles de l'utilisateur). Cela permet d'afficher "Vous êtes 3ème dans la queue".
    const allPending = db.prepare(
      `SELECT id FROM task_queue WHERE status = 'pending' ORDER BY position ASC`
    ).all() as any[]
    userTasks.forEach(t => {
      if (t.status === 'pending') {
        const idx = allPending.findIndex((p: any) => p.id === t.id)
        t.position = idx + 1
      } else {
        // Les tâches en cours ont une position 0 (elles ne sont plus "en attente")
        t.position = 0
      }
    })
  }

  // Compte le nombre total de tâches en attente dans la queue
  const totalPending = (db.prepare(
    `SELECT COUNT(*) as cnt FROM task_queue WHERE status = 'pending'`
  ).get() as any).cnt

  return { currentTask, userTasks, totalPending }
}

/**
 * Fonction de récupération appelée au démarrage du serveur.
 * Si le serveur a crashé ou redémarré pendant qu'une tâche tournait,
 * cette tâche est restée avec le statut 'running' en base sans jamais se terminer.
 * On les marque donc comme 'failed' pour éviter qu'elles bloquent la queue.
 * Ensuite, on relance le traitement des tâches en attente.
 */
function recoverOnStartup() {
  const db = getDb()
  const now = new Date().toISOString()

  // On marque toutes les tâches "running" orphelines comme échouées
  const orphaned = db.prepare(
    `UPDATE task_queue SET status = 'failed', result = ?, completed_at = ? WHERE status = 'running'`
  ).run(JSON.stringify({ error: 'Le serveur a redémarré pendant l\'exécution' }), now)

  if (orphaned.changes > 0) {
    logger.info(`[Queue] Recovery: marked ${orphaned.changes} orphaned task(s) as failed`)
  }

  // On réinitialise le verrou
  currentRunningTaskId = null

  // On tente de traiter les tâches en attente qui existaient avant le redémarrage
  processNext()
}

/**
 * Envoie une mise à jour de la queue à tous les utilisateurs qui ont des tâches
 * en attente ou en cours. Cela permet de mettre à jour les positions dans l'UI
 * quand une tâche démarre ou se termine (les positions des autres changent).
 */
function broadcastQueueUpdates() {
  if (!broadcastFn) return
  const db = getDb()

  // On récupère la liste des utilisateurs ayant des tâches actives
  const pendingUsers = db.prepare(
    `SELECT DISTINCT user_id FROM task_queue WHERE status IN ('pending', 'running')`
  ).all() as any[]

  // On envoie à chacun l'état actualisé de la queue
  for (const { user_id } of pendingUsers) {
    broadcastFn(user_id, null, 'queue:update', { queue: getQueueState(user_id) })
  }
}

/**
 * Récupère l'historique récent des tâches d'un utilisateur (toutes les tâches,
 * pas seulement les actives). Utile pour afficher l'historique dans l'interface.
 *
 * @param userId - ID de l'utilisateur
 * @param limit - Nombre maximum de tâches à retourner (par défaut 10)
 * @returns Liste des tâches triées par date de création décroissante
 */
export function getRecentTasks(userId: string, limit: number = 10): QueueTask[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM task_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit) as any[]
  return rows.map(parseTaskRow)
}

/**
 * Convertit une ligne brute de la base de données en objet QueueTask propre.
 * Les champs 'config' et 'result' sont stockés en JSON dans la BDD,
 * donc on les parse ici pour obtenir des objets JavaScript utilisables.
 *
 * @param row - La ligne brute retournée par SQLite
 * @returns Un objet QueueTask bien typé
 */
function parseTaskRow(row: any): QueueTask {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    status: row.status,
    project_id: row.project_id,
    config: row.config ? JSON.parse(row.config) : {},
    result: row.result ? JSON.parse(row.result) : null,
    progress: row.progress || 0,
    progress_message: row.progress_message,
    position: row.position,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at
  }
}

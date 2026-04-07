/**
 * QUEUESTATUS.TSX : Indicateur de file d'attente IA dans le header
 *
 * Ce composant affiche un petit badge dans la barre de navigation (header)
 * qui indique l'état de la file d'attente des tâches IA sur le serveur.
 *
 * Fonctionnement :
 * - Le serveur gère une file d'attente (queue) pour les tâches IA
 *   (transcription Whisper + analyse LLM) car elles sont lourdes en ressources.
 * - Un seul utilisateur peut utiliser l'IA à la fois.
 * - Les autres tâches sont mises en attente dans la queue.
 *
 * Le badge affiche :
 * - "1 tâche IA en cours" si l'IA travaille
 * - "X en attente" si des tâches sont en file d'attente
 * - Rien si la queue est vide
 *
 * En cliquant dessus, un panneau déroulant s'ouvre avec le détail des tâches
 * et un bouton pour annuler ses propres tâches en attente.
 *
 * La mise à jour se fait via :
 * - Un polling HTTP toutes les 15 secondes (filet de sécurité)
 * - Des événements WebSocket en temps réel (plus réactif)
 */

// useState : pour l'état de la queue et l'état ouvert/fermé du panneau
// useEffect : pour le polling et les listeners WebSocket au montage
import { useState, useEffect } from "react"

// Framer Motion : animations d'entrée/sortie du panneau déroulant
// AnimatePresence : gère les animations quand un élément apparaît/disparaît du DOM
import { AnimatePresence, motion } from "framer-motion"

// Icônes utilisées dans le composant :
// Loader2 : spinner animé (tâche en cours)
// Clock : horloge (en attente)
// X : croix (bouton annuler)
// Brain : cerveau (analyse IA)
// Mic : microphone (transcription)
// ChevronDown : flèche vers le bas (ouvrir/fermer le panneau)
import { Loader2, Clock, X, Brain, Mic, ChevronDown } from "lucide-react"

// Module API : contient les fonctions pour communiquer avec le backend
import api from "@/api"

// Types TypeScript : structure de données pour la queue et les tâches
// QueueState : état complet de la queue (tâche en cours, tâches de l'utilisateur, total)
// QueueTask : une tâche individuelle (id, type, statut, position, message de progression)
import type { QueueState, QueueTask } from "@/types"

/**
 * Composant QueueStatus : badge cliquable + panneau déroulant de la file d'attente IA.
 * S'affiche dans le header de l'application.
 */
const QueueStatus = () => {
  // queue : état complet de la file d'attente, récupéré depuis le serveur
  // null au départ car on n'a pas encore fait le premier appel API
  const [queue, setQueue] = useState<QueueState | null>(null)

  // expanded : contrôle si le panneau déroulant est ouvert ou fermé
  const [expanded, setExpanded] = useState(false)

  /**
   * Effet exécuté au montage du composant.
   * Met en place deux mécanismes de mise à jour :
   *
   * 1. Polling HTTP : appel API toutes les 15 secondes pour récupérer l'état
   *    de la queue. C'est un filet de sécurité au cas où un événement WebSocket
   *    serait manqué.
   *
   * 2. Listeners WebSocket : écoute les événements en temps réel du serveur.
   *    Plus réactif que le polling, les mises à jour arrivent instantanément.
   *    On écoute 4 types d'événements :
   *    - onQueueUpdate : mise à jour générale de la queue
   *    - onQueueTaskStarted : une tâche vient de démarrer
   *    - onQueueTaskCompleted : une tâche est terminée
   *    - onQueueTaskFailed : une tâche a échoué
   */
  useEffect(() => {
    // Fonction de récupération de l'état de la queue via HTTP
    const fetchQueue = () => {
      api.getQueueState().then(setQueue).catch(() => {})
    }

    // Premier appel immédiat au montage
    fetchQueue()

    // Polling : on rappelle fetchQueue toutes les 15 secondes
    const interval = setInterval(fetchQueue, 15000)

    // --- Listeners WebSocket ---
    // Chaque listener retourne une fonction de désinscription (unsub)

    // Mise à jour générale : on met directement l'objet queue dans l'état
    const unsubUpdate = api.onQueueUpdate((data: any) => {
      if (data.queue) setQueue(data.queue)
    })

    // Quand une tâche démarre : on re-fetch l'état complet
    const unsubStarted = api.onQueueTaskStarted(() => fetchQueue())

    // Quand une tâche est terminée : on re-fetch l'état complet
    const unsubCompleted = api.onQueueTaskCompleted(() => fetchQueue())

    // Quand une tâche échoue : on re-fetch l'état complet
    const unsubFailed = api.onQueueTaskFailed(() => fetchQueue())

    // Nettoyage au démontage : on arrête le polling et tous les listeners
    return () => {
      clearInterval(interval)
      unsubUpdate()
      unsubStarted()
      unsubCompleted()
      unsubFailed()
    }
  }, [])

  // Si la queue n'a pas encore été chargée, on ne rend rien
  if (!queue) return null

  // --- Variables dérivées ---

  // hasRunning : vrai si une tâche est actuellement en cours de traitement
  const hasRunning = !!queue.currentTask

  // pendingCount : nombre total de tâches en attente dans la queue (tous utilisateurs)
  const pendingCount = queue.totalPending

  // userTaskCount : nombre de tâches appartenant à l'utilisateur connecté
  const userTaskCount = queue.userTasks.length

  // Si rien à afficher (pas de tâche en cours, pas de file d'attente), on masque le composant
  if (!hasRunning && pendingCount === 0 && userTaskCount === 0) return null

  /**
   * Annule une tâche en attente.
   * Envoie une requête d'annulation au serveur, puis re-fetch l'état de la queue.
   *
   * @param e - L'événement de clic (on fait stopPropagation pour ne pas fermer le panneau)
   * @param taskId - L'identifiant unique de la tâche à annuler
   */
  const handleCancel = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation() // Empêche le clic de se propager au bouton parent (toggle du panneau)
    await api.cancelTask(taskId)
    // On re-fetch immédiatement pour mettre à jour l'affichage
    api.getQueueState().then(setQueue).catch(() => {})
  }

  /**
   * Retourne l'icône appropriée selon le type de tâche.
   * - "transcription" -> icône microphone
   * - Autre (analyse IA) -> icône cerveau
   */
  const getTaskIcon = (type: string) => {
    return type === 'transcription' ? <Mic className="w-3 h-3" /> : <Brain className="w-3 h-3" />
  }

  /**
   * Retourne le libellé affiché pour une tâche.
   * - "transcription" -> "Transcription"
   * - Autre -> "Analyse IA"
   */
  const getTaskLabel = (task: QueueTask) => {
    if (task.type === 'transcription') return 'Transcription'
    return 'Analyse IA'
  }

  // --- Rendu JSX ---
  return (
    // Conteneur relatif pour positionner le panneau déroulant en-dessous du badge
    <div className="relative">
      {/* ===== BADGE CLIQUABLE : résumé de l'état de la queue ===== */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-colors ${
          hasRunning
            ? 'bg-primary/10 text-primary border border-primary/20'      // Style bleu si tâche en cours
            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20' // Style orange si en attente
        }`}
      >
        {/* Icône : spinner si en cours, horloge si en attente */}
        {hasRunning ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Clock className="w-3 h-3" />
        )}

        {/* Texte du badge : adapte le message selon l'état */}
        {hasRunning && pendingCount > 0 ? `1 en cours · ${pendingCount} en attente` :
         hasRunning ? '1 tâche IA en cours' :
         `${pendingCount} en attente`}

        {/* Flèche qui tourne de 180° quand le panneau est ouvert */}
        <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* ===== PANNEAU DÉROULANT : détail des tâches ===== */}
      {/* AnimatePresence gère l'animation d'entrée/sortie du panneau */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, y: -5, scale: 0.95 }}   // Apparition : fondu + glissement vers le bas
            animate={{ opacity: 1, y: 0, scale: 1 }}        // État final : visible
            exit={{ opacity: 0, y: -5, scale: 0.95 }}       // Disparition : même animation en sens inverse
            className="absolute right-0 top-full mt-2 w-72 bg-card border border-border rounded-xl shadow-xl z-50 overflow-hidden"
          >
            {/* En-tête du panneau déroulant */}
            <div className="p-3 border-b border-border">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">File d'attente IA</h4>
            </div>

            {/* Liste scrollable des tâches (maximum 60px de hauteur avant scroll) */}
            <div className="p-2 space-y-1 max-h-60 overflow-y-auto">

              {/* --- Tâche en cours (si elle existe) --- */}
              {/* Affichée avec un fond bleu clair pour la distinguer des tâches en attente */}
              {queue.currentTask && (
                <div className="flex items-center gap-2.5 p-2 rounded-lg bg-primary/5 border border-primary/10">
                  {/* Icône de la tâche (micro ou cerveau) */}
                  <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center text-primary">
                    {getTaskIcon(queue.currentTask.type)}
                  </div>
                  <div className="min-w-0 flex-1">
                    {/* Nom de la tâche */}
                    <p className="text-[11px] font-semibold text-foreground">{getTaskLabel(queue.currentTask)}</p>
                    {/* Statut "En cours" avec spinner + message de progression optionnel */}
                    <p className="text-[9px] text-primary font-medium flex items-center gap-1">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      En cours{queue.currentTask.progress_message ? ` — ${queue.currentTask.progress_message}` : ''}
                    </p>
                  </div>
                </div>
              )}

              {/* --- Tâches en attente de l'utilisateur connecté --- */}
              {/* On filtre pour ne montrer que les tâches avec le statut "pending" */}
              {queue.userTasks
                .filter(t => t.status === 'pending')
                .map((task) => (
                  <div key={task.id} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-secondary/50 transition-colors">
                    {/* Icône de la tâche */}
                    <div className="w-6 h-6 rounded-md bg-secondary flex items-center justify-center text-muted-foreground">
                      {getTaskIcon(task.type)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-foreground">{getTaskLabel(task)}</p>
                      {/* Position dans la file d'attente */}
                      <p className="text-[9px] text-amber-400 font-medium">
                        <Clock className="w-2.5 h-2.5 inline mr-0.5" />
                        Position {task.position}
                      </p>
                    </div>
                    {/* Bouton d'annulation de la tâche (croix rouge au survol) */}
                    <button
                      onClick={(e) => handleCancel(e, task.id)}
                      className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                      title="Annuler"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}

              {/* Message affiché quand la file d'attente est vide */}
              {!queue.currentTask && queue.userTasks.length === 0 && (
                <p className="text-[11px] text-muted-foreground text-center py-3">
                  File d'attente vide
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default QueueStatus

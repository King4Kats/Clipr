/**
 * QUEUESTATUS.TSX : Indicateur de file d'attente IA dans le header
 *
 * Petit badge cliquable montrant l'état de la queue (tâches en cours / en attente).
 * Se développe pour montrer le détail des tâches avec bouton annuler.
 */

import { useState, useEffect } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Loader2, Clock, X, Brain, Mic, ChevronDown } from "lucide-react"
import api from "@/api"
import type { QueueState, QueueTask } from "@/types"

const QueueStatus = () => {
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [expanded, setExpanded] = useState(false)

  // Poll queue state + listen to WS updates
  useEffect(() => {
    const fetchQueue = () => {
      api.getQueueState().then(setQueue).catch(() => {})
    }
    fetchQueue()
    const interval = setInterval(fetchQueue, 15000)

    const unsubUpdate = api.onQueueUpdate((data: any) => {
      if (data.queue) setQueue(data.queue)
    })
    const unsubStarted = api.onQueueTaskStarted(() => fetchQueue())
    const unsubCompleted = api.onQueueTaskCompleted(() => fetchQueue())
    const unsubFailed = api.onQueueTaskFailed(() => fetchQueue())

    return () => {
      clearInterval(interval)
      unsubUpdate()
      unsubStarted()
      unsubCompleted()
      unsubFailed()
    }
  }, [])

  if (!queue) return null

  const hasRunning = !!queue.currentTask
  const pendingCount = queue.totalPending
  const userTaskCount = queue.userTasks.length

  // Nothing to show
  if (!hasRunning && pendingCount === 0 && userTaskCount === 0) return null

  const handleCancel = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    await api.cancelTask(taskId)
    api.getQueueState().then(setQueue).catch(() => {})
  }

  const getTaskIcon = (type: string) => {
    return type === 'transcription' ? <Mic className="w-3 h-3" /> : <Brain className="w-3 h-3" />
  }

  const getTaskLabel = (task: QueueTask) => {
    if (task.type === 'transcription') return 'Transcription'
    return 'Analyse IA'
  }

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-colors ${
          hasRunning
            ? 'bg-primary/10 text-primary border border-primary/20'
            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
        }`}
      >
        {hasRunning ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Clock className="w-3 h-3" />
        )}
        {hasRunning && pendingCount > 0 ? `1 en cours · ${pendingCount} en attente` :
         hasRunning ? '1 tâche IA en cours' :
         `${pendingCount} en attente`}
        <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, y: -5, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -5, scale: 0.95 }}
            className="absolute right-0 top-full mt-2 w-72 bg-card border border-border rounded-xl shadow-xl z-50 overflow-hidden"
          >
            <div className="p-3 border-b border-border">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">File d'attente IA</h4>
            </div>

            <div className="p-2 space-y-1 max-h-60 overflow-y-auto">
              {/* Current running task */}
              {queue.currentTask && (
                <div className="flex items-center gap-2.5 p-2 rounded-lg bg-primary/5 border border-primary/10">
                  <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center text-primary">
                    {getTaskIcon(queue.currentTask.type)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-foreground">{getTaskLabel(queue.currentTask)}</p>
                    <p className="text-[9px] text-primary font-medium flex items-center gap-1">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      En cours{queue.currentTask.progress_message ? ` — ${queue.currentTask.progress_message}` : ''}
                    </p>
                  </div>
                </div>
              )}

              {/* User's pending tasks */}
              {queue.userTasks
                .filter(t => t.status === 'pending')
                .map((task) => (
                  <div key={task.id} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-secondary/50 transition-colors">
                    <div className="w-6 h-6 rounded-md bg-secondary flex items-center justify-center text-muted-foreground">
                      {getTaskIcon(task.type)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-foreground">{getTaskLabel(task)}</p>
                      <p className="text-[9px] text-amber-400 font-medium">
                        <Clock className="w-2.5 h-2.5 inline mr-0.5" />
                        Position {task.position}
                      </p>
                    </div>
                    <button
                      onClick={(e) => handleCancel(e, task.id)}
                      className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                      title="Annuler"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}

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

/**
 * PROJECTPAGE.TSX : Page d'un projet de segmentation video
 *
 * Gere tout le cycle de vie d'un projet video :
 * - Chargement du projet depuis l'URL (deep link / rafraichissement)
 * - Choix du mode de travail (IA ou Manuel)
 * - Vue pre-analyse (apercu video + panneau config IA)
 * - Progression du traitement (barre de progression WebSocket)
 * - Editeur NLE (timeline, segments, preview video)
 *
 * Route : /project/:projectId
 */

import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useStore } from '@/store/useStore'
import api from '@/api'

import UploadZone from '@/components/new/UploadZone'
import AIAnalysisPanel from '@/components/new/AIAnalysisPanel'
import ProgressPanel from '@/components/new/ProgressPanel'
import VideoPreview from '@/components/new/VideoPreview'
import EditorLayout from '@/components/new/EditorLayout'

import { motion } from 'framer-motion'
import { Brain, Scissors, Loader2 } from 'lucide-react'

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const {
    videoFiles,
    processingStep,
    segments,
    activeProjectId,
    loadFromHistory,
  } = useStore()

  const [projectMode, setProjectMode] = useState<'choose' | 'ai' | 'manual' | null>(null)
  const [loading, setLoading] = useState(false)

  // Load project from URL if not already in store
  useEffect(() => {
    if (!projectId) return

    if (activeProjectId === projectId) {
      // Project already loaded — determine mode from state
      if (segments.length > 0) return // editor mode
      if (processingStep !== 'idle' && processingStep !== 'ready' && processingStep !== 'done') return // processing
      return
    }

    // Need to fetch project
    setLoading(true)
    api.loadProjectById(projectId)
      .then((project: any) => {
        if (project) {
          loadFromHistory(project)
        } else {
          navigate('/', { replace: true })
        }
      })
      .catch(() => {
        navigate('/', { replace: true })
      })
      .finally(() => setLoading(false))
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      api.unsubscribeFromProject()
    }
  }, [])

  if (loading) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-10 h-10 text-primary animate-spin" />
        </div>
      </main>
    )
  }

  // Upload screen (no videos yet)
  if (videoFiles.length === 0 && !activeProjectId) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="max-w-4xl mx-auto w-full pt-8">
          <UploadZone />
        </div>
      </main>
    )
  }

  // Processing in progress
  if (
    processingStep !== 'idle' &&
    processingStep !== 'ready' &&
    processingStep !== 'done' &&
    processingStep !== 'exporting'
  ) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-8">
        <ProgressPanel />
      </main>
    )
  }

  // Editor (segments exist)
  if (segments.length > 0) {
    return <EditorLayout />
  }

  // Mode choice: AI or Manual
  if (projectMode === null || projectMode === 'choose') {
    return (
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="max-w-3xl mx-auto w-full pt-12">
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 text-center">
            <h2 className="text-2xl font-bold text-foreground">Comment souhaitez-vous travailler ?</h2>
            <p className="text-sm text-muted-foreground mt-2">
              {videoFiles.length} video{videoFiles.length > 1 ? 's' : ''} importee{videoFiles.length > 1 ? 's' : ''} — {(() => { const t = Math.round(useStore.getState().getTotalDuration()); const h = Math.floor(t/3600); const m = Math.floor((t%3600)/60); const s = t%60; return h > 0 ? `${h}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s` : m > 0 ? `${m}m${String(s).padStart(2,'0')}s` : `${s}s`; })()}
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              onClick={() => setProjectMode('ai')}
              className="group p-8 bg-card border-2 border-border hover:border-primary/50 rounded-2xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-xl text-center"
            >
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-5 group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                <Brain className="w-8 h-8 text-primary group-hover:text-primary-foreground" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">Analyse IA</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                L'IA transcrit la voix et decoupe automatiquement la video en segments thematiques. Ideal pour les interviews longues.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              onClick={() => setProjectMode('manual')}
              className="group p-8 bg-card border-2 border-border hover:border-primary/50 rounded-2xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-xl text-center"
            >
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-5 group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                <Scissors className="w-8 h-8 text-primary group-hover:text-primary-foreground" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">Decoupe manuelle</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Creez et ajustez vos segments manuellement sur la timeline. Controle total sur le decoupage.
              </p>
            </motion.div>
          </div>
        </div>
      </main>
    )
  }

  // AI mode: pre-analysis
  if (projectMode === 'ai') {
    return (
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 mt-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
          <div className="lg:col-span-3 space-y-6">
            <VideoPreview />
          </div>

          <div className="space-y-6">
            <AIAnalysisPanel />

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="bg-card rounded-xl border border-border p-5 shadow-sm"
            >
              <h2 className="text-sm font-semibold text-foreground mb-4">Statistiques</h2>
              <div className="space-y-3 font-mono">
                {[
                  { label: 'Video(s)', value: videoFiles.length },
                  { label: 'Sequences', value: segments.length },
                  { label: 'Duree totale', value: useStore.getState().getTotalDuration().toFixed(0) + 's' },
                ].map((stat) => (
                  <div key={stat.label} className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground uppercase">{stat.label}</span>
                    <span className="font-bold text-primary">{stat.value}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            <button
              onClick={() => setProjectMode('choose')}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              &larr; Changer de mode
            </button>
          </div>
        </div>
      </main>
    )
  }

  // Manual mode: editor directly
  return <EditorLayout />
}

/**
 * HOMEPAGE.TSX : Page d'accueil de l'application
 *
 * Affiche :
 * - Le logo Clipr
 * - La grille des projets recents de l'utilisateur (max 6)
 * - Les projets partages avec l'utilisateur
 * - La grille des outils disponibles (Transcription, Segmentation, Linguistique)
 * - Le bouton "Nouveau Projet" avec choix du type
 *
 * Route : /
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store/useStore'
import api from '@/api'
import { motion } from 'framer-motion'
import {
  Film, Loader2, RotateCcw, Plus, Trash2, Pencil, Cpu, X, Check,
  Share2, Users, Mic, BookOpen, Scissors
} from 'lucide-react'
import logo from '@/assets/Clipr.svg'

export default function HomePage() {
  const navigate = useNavigate()
  const {
    history,
    loadHistory,
    deleteProject,
    renameProject,
    reset,
    activeProjectId,
  } = useStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [sharedProjects, setSharedProjects] = useState<any[]>([])
  const [showNewProjectChoice, setShowNewProjectChoice] = useState(false)

  // Reset store if navigating back from a project
  useEffect(() => {
    if (activeProjectId) {
      reset()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load history + shared projects
  useEffect(() => {
    loadHistory()
    api.getSharedProjects().then(setSharedProjects).catch(() => {})

    const interval = setInterval(async () => {
      if (!useStore.getState().activeProjectId) {
        loadHistory()
        api.getSharedProjects().then(setSharedProjects).catch(() => {})
      }
    }, 10000)
    return () => clearInterval(interval)
  }, [loadHistory])

  const handleStartRename = (e: React.MouseEvent, id: string, currentName: string) => {
    e.stopPropagation()
    setEditingId(id)
    setEditingName(currentName)
  }

  const handleConfirmRename = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (editingId && editingName.trim()) {
      await renameProject(editingId, editingName.trim())
    }
    setEditingId(null)
    setEditingName('')
  }

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(null)
    setEditingName('')
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await deleteProject(id)
  }

  const handleProjectClick = (project: any) => {
    if (editingId === project.id) return
    if (project.data?.toolType === 'transcription') {
      navigate('/transcription/' + project.id)
    } else if (project.data?.toolType === 'linguistic') {
      navigate('/linguistic/' + project.id)
    } else {
      navigate('/project/' + project.id)
    }
  }

  const handleSharedProjectClick = (project: any) => {
    if (project.data?.toolType === 'transcription') {
      navigate('/transcription/' + project.id)
    } else if (project.data?.toolType === 'linguistic') {
      navigate('/linguistic/' + project.id)
    } else {
      navigate('/project/' + project.id)
    }
  }

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      <div className="max-w-5xl mx-auto w-full pt-12">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12 text-center flex flex-col items-center"
        >
          <img src={logo} alt="Clipr" className="w-40 h-40" />
        </motion.div>

        {/* Section projets */}
        <div className="mb-12">
          <div className="flex items-center justify-between mb-4 px-1">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-primary" />
              Mes Projets
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                {history.length}/12
              </span>
              {history.length < 12 && (
                <button
                  onClick={() => setShowNewProjectChoice(true)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nouveau
                </button>
              )}
            </div>
          </div>

          {/* Grille de cartes projet (max 6) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {history.slice(0, 12).map((project: any, i: number) => (
              <motion.div
                key={project.id || i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                onClick={() => handleProjectClick(project)}
                className={`group relative p-4 bg-card hover:bg-secondary/50 border rounded-xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg ${
                  project.status === 'processing' ? 'border-amber-500/60 border-2' : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors shrink-0">
                    {project.data?.toolType === 'transcription' ? <Mic className="w-5 h-5" /> : project.data?.toolType === 'linguistic' ? <BookOpen className="w-5 h-5" /> : project.type === 'ai' ? <Cpu className="w-5 h-5" /> : <Film className="w-5 h-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    {editingId === project.id ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleConfirmRename(e as any)
                            if (e.key === 'Escape') handleCancelRename(e as any)
                          }}
                          className="text-sm font-bold text-foreground bg-secondary/50 border border-primary/30 rounded px-1.5 py-0.5 w-full outline-none focus:ring-1 focus:ring-primary"
                          autoFocus
                        />
                        <button onClick={handleConfirmRename} className="p-0.5 text-green-500 hover:text-green-400"><Check className="w-3.5 h-3.5" /></button>
                        <button onClick={handleCancelRename} className="p-0.5 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                      </div>
                    ) : (
                      <h3 className="text-sm font-bold text-foreground truncate">
                        {project.name || project.data?.projectName || 'Projet Sans Nom'}
                      </h3>
                    )}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                        project.data?.toolType === 'transcription'
                          ? 'bg-primary/10 text-primary'
                          : project.data?.toolType === 'linguistic'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : project.type === 'ai'
                          ? 'bg-violet-500/10 text-violet-400'
                          : 'bg-blue-500/10 text-blue-400'
                      }`}>
                        {project.data?.toolType === 'transcription' ? 'Audio' : project.data?.toolType === 'linguistic' ? 'Linguistique' : project.type === 'ai' ? 'IA' : 'Manuel'}
                      </span>
                      <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                        project.status === 'done'
                          ? 'bg-green-500/10 text-green-400'
                          : project.status === 'processing'
                          ? 'bg-amber-500/10 text-amber-400'
                          : 'bg-zinc-500/10 text-zinc-400'
                      }`}>
                        {project.status === 'done' ? 'Termine' : project.status === 'processing' ? 'En cours' : 'Brouillon'}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground font-mono mt-1">
                      {new Date(project.updated_at || project.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })} •{' '}
                      {project.data?.toolType === 'transcription'
                        ? `${project.data?.transcriptionItems?.length || 0} fichier${(project.data?.transcriptionItems?.length || 0) > 1 ? 's' : ''}`
                        : `${project.data?.segments?.length || 0} segments`}
                    </p>
                  </div>
                </div>

                {/* Indicateur de traitement en cours */}
                {project.status === 'processing' && (
                  <div className="mt-3 pt-2.5 border-t border-amber-500/20">
                    <div className="flex items-center gap-2 text-amber-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span className="text-[10px] font-semibold">Analyse IA en cours...</span>
                    </div>
                    <div className="mt-1.5 h-1 bg-amber-500/10 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-500/50 rounded-full animate-pulse" style={{ width: '60%' }} />
                    </div>
                  </div>
                )}

                {/* Actions : share, rename & delete */}
                {editingId !== project.id && (
                  <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        // Dispatch share event to AppLayout
                        window.dispatchEvent(new CustomEvent('clipr:share', { detail: { projectId: project.id, projectName: project.name || project.data?.projectName || '' } }))
                      }}
                      className="p-1.5 rounded-md bg-secondary/80 hover:bg-primary/20 text-muted-foreground hover:text-primary transition-colors"
                      title="Partager"
                    >
                      <Share2 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => handleStartRename(e, project.id, project.name || project.data?.projectName || '')}
                      className="p-1.5 rounded-md bg-secondary/80 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                      title="Renommer"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, project.id)}
                      className="p-1.5 rounded-md bg-secondary/80 hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                      title="Supprimer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </motion.div>
            ))}

            {/* Carte "Nouveau Projet" si place disponible */}
            {history.length < 12 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: history.length * 0.05 }}
                className="border-2 border-dashed border-border rounded-xl transition-all min-h-[100px] overflow-hidden"
              >
                {showNewProjectChoice ? (
                  <div className="p-3 space-y-2 h-full">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Nouveau projet</span>
                      <button onClick={() => setShowNewProjectChoice(false)} className="p-0.5 text-muted-foreground hover:text-foreground">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <button
                      onClick={() => { setShowNewProjectChoice(false); navigate('/transcription') }}
                      className="w-full flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-primary/10 transition-colors text-left"
                    >
                      <Mic className="w-4 h-4 text-primary shrink-0" />
                      <span className="text-xs font-medium text-foreground">Transcription audio/video</span>
                    </button>
                    <button
                      onClick={() => { setShowNewProjectChoice(false); navigate('/segmentation/new') }}
                      className="w-full flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-violet-500/10 transition-colors text-left"
                    >
                      <Scissors className="w-4 h-4 text-violet-400 shrink-0" />
                      <span className="text-xs font-medium text-foreground">Segmentation video</span>
                    </button>
                    <button
                      onClick={() => { setShowNewProjectChoice(false); navigate('/linguistic') }}
                      className="w-full flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-emerald-500/10 transition-colors text-left"
                    >
                      <BookOpen className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="text-xs font-medium text-foreground">Transcription linguistique</span>
                    </button>
                  </div>
                ) : (
                  <div
                    onClick={() => setShowNewProjectChoice(true)}
                    className="p-4 cursor-pointer hover:border-primary/50 hover:bg-primary/5 flex items-center justify-center gap-3 h-full transition-all"
                  >
                    <Plus className="w-5 h-5 text-muted-foreground" />
                    <span className="text-sm font-medium text-muted-foreground">Nouveau Projet</span>
                  </div>
                )}
              </motion.div>
            )}
          </div>
        </div>

        {/* Projets partages avec moi */}
        {sharedProjects.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center gap-2 mb-4 px-1">
              <Users className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Partages avec moi</h2>
              <span className="text-[10px] text-muted-foreground font-bold">{sharedProjects.length}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {sharedProjects.map((project: any, i: number) => (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.05 }}
                  onClick={() => handleSharedProjectClick(project)}
                  className="group p-3 bg-card/50 hover:bg-secondary/50 border border-dashed border-border rounded-xl cursor-pointer transition-all hover:scale-[1.01]"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center text-muted-foreground">
                      <Share2 className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xs font-semibold text-foreground truncate">{project.name}</h3>
                      <p className="text-[9px] text-muted-foreground">
                        Par {project.owner_username} ·{' '}
                        <span className={project.share_role === 'editor' ? 'text-blue-400' : 'text-zinc-400'}>
                          {project.share_role === 'editor' ? 'Editeur' : 'Lecteur'}
                        </span>
                      </p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Section Outils */}
        <div className="mb-12">
          <div className="flex items-center gap-2 mb-4 px-1">
            <Mic className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Outils</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => navigate('/transcription')}
              className="group p-5 bg-card border-2 border-border hover:border-primary/50 rounded-xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                  <Mic className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground">Transcrire un media</h3>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Convertir un ou plusieurs fichiers audio/video en texte avec Whisper
                  </p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.05 }}
              onClick={() => navigate('/segmentation/new')}
              className="group p-5 bg-card border-2 border-border hover:border-primary/50 rounded-xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center text-violet-400 group-hover:bg-violet-500 group-hover:text-white transition-colors">
                  <Scissors className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground">Segmentation d'interview video</h3>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Analyse IA pour decouper automatiquement une interview en segments
                  </p>
                </div>
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.1 }}
              onClick={() => navigate('/linguistic')}
              className="group p-5 bg-card border-2 border-border hover:border-emerald-500/50 rounded-xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 group-hover:bg-emerald-500 group-hover:text-white transition-colors">
                  <BookOpen className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground">Transcription linguistique</h3>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Segmentation francais / langue vernaculaire + transcription IPA
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </main>
  )
}

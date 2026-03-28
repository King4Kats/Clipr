/**
 * APP.TSX : Composant racine de l'application
 *
 * Gère la navigation entre les différentes vues de l'application :
 * - Écran d'accueil avec upload et projets récents (jusqu'à 6)
 * - Écran de progression pendant le traitement IA
 * - Éditeur NLE (Non-Linear Editor) avec les segments générés
 * - Vue pré-analyse avec prévisualisation vidéo et panneau IA
 */

import { useEffect, useState } from "react";
import { useStore } from "@/store/useStore";
import { useAuthStore } from "@/store/useAuthStore";
import api from "@/api";

import Header from "@/components/new/Header";
import UploadZone from "@/components/new/UploadZone";
import AIAnalysisPanel from "@/components/new/AIAnalysisPanel";
import ProgressPanel from "@/components/new/ProgressPanel";
import VideoPreview from "@/components/new/VideoPreview";
import EditorLayout from "@/components/new/EditorLayout";
import SetupWizard from "@/components/SetupWizard";
import AuthScreen from "@/components/AuthScreen";
import AdminDashboard from "@/components/AdminDashboard";

import ShareDialog from "@/components/ShareDialog";

import { motion, AnimatePresence } from "framer-motion";
import { Film, Loader2, RotateCcw, Plus, Trash2, Pencil, Cpu, X, Check, Share2, Users, Brain, Scissors } from "lucide-react";
import logo from "@/assets/Clipr.svg";

function App() {
  const { isAuthenticated, isLoading: authLoading, checkAuth, user } = useAuthStore();

  const {
    videoFiles,
    processingStep,
    segments,
    addTranscriptSegment,
    setProcessing,
    setSegments,
    setTranscript,
    setAudioPaths,
    history,
    loadHistory,
    loadFromHistory,
    createProject,
    deleteProject,
    renameProject,
  } = useStore();

  const [showSetup, setShowSetup] = useState(false);
  const [setupChecked, setSetupChecked] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [sharingProjectId, setSharingProjectId] = useState<string | null>(null);
  const [sharingProjectName, setSharingProjectName] = useState("");
  const [sharedProjects, setSharedProjects] = useState<any[]>([]);
  const [projectMode, setProjectMode] = useState<'choose' | 'ai' | 'manual' | null>(null);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const checkFirstRun = async () => {
      const setupComplete = localStorage.getItem("decoupeur-video-setup-complete");
      if (!setupComplete) setShowSetup(true);
      setSetupChecked(true);
      await loadHistory();
      try { setSharedProjects(await api.getSharedProjects()) } catch {}
    };
    checkFirstRun();

    // Poll history every 10s to update processing status on home page
    const interval = setInterval(async () => {
      if (!useStore.getState().activeProjectId) {
        loadHistory();
        try { setSharedProjects(await api.getSharedProjects()) } catch {}
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [loadHistory, isAuthenticated]);

  const handleSetupComplete = () => {
    localStorage.setItem("decoupeur-video-setup-complete", "true");
    setShowSetup(false);
  };

  // Écoute les événements WebSocket du serveur (project-scoped)
  useEffect(() => {
    if (!(window as any).electron) return;

    // Progress updates (extraction, transcription, analysis)
    const unsubProgress = (window as any).electron.onProgress((data: any) => {
      const step = data.step || processingStep;
      setProcessing(step, data.progress, data.message);
    });

    // Transcript segments streamed in real-time
    const unsubSegment = (window as any).electron.onTranscriptSegment((segment: any) => {
      addTranscriptSegment(segment as any);
    });

    // Analysis completed server-side — load results
    const unsubComplete = (window as any).electron.onAnalysisComplete((data: any) => {
      if (data.segments) setSegments(data.segments);
      if (data.transcript) setTranscript(data.transcript);
      if (data.audioPaths) setAudioPaths(data.audioPaths);
      setProcessing('done', 100, 'Analyse terminée !');
      loadHistory();
    });

    // Analysis failed server-side
    const unsubError = (window as any).electron.onAnalysisError((data: any) => {
      setProcessing('error', 0, data.message || 'Erreur d\'analyse');
      loadHistory();
    });

    return () => {
      unsubProgress();
      unsubSegment();
      unsubComplete();
      unsubError();
    };
  }, [processingStep, setProcessing, addTranscriptSegment, setSegments, setTranscript, setAudioPaths, loadHistory]);

  const handleStartRename = (e: React.MouseEvent, id: string, currentName: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingName(currentName);
  };

  const handleConfirmRename = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editingId && editingName.trim()) {
      await renameProject(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName("");
  };

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
    setEditingName("");
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteProject(id);
  };

  const handleNewProject = async () => {
    setProjectMode(null);
    await createProject('Nouveau Projet', 'manual');
  };

  const renderContent = () => {
    // ── Écran d'accueil : aucune vidéo importée et pas de projet actif ──
    if (videoFiles.length === 0 && !useStore.getState().activeProjectId) {
      return (
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
                  {history.length}/6
                </span>
                {history.length < 6 && (
                  <button
                    onClick={handleNewProject}
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
              {history.slice(0, 6).map((project: any, i: number) => (
                <motion.div
                  key={project.id || i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  onClick={() => editingId !== project.id && loadFromHistory(project)}
                  className={`group relative p-4 bg-card hover:bg-secondary/50 border rounded-xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg ${
                    project.status === 'processing' ? 'border-amber-500/50 animate-pulse' : 'border-border'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors shrink-0">
                      {project.type === 'ai' ? <Cpu className="w-5 h-5" /> : <Film className="w-5 h-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      {editingId === project.id ? (
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <input
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleConfirmRename(e as any);
                              if (e.key === 'Escape') handleCancelRename(e as any);
                            }}
                            className="text-sm font-bold text-foreground bg-secondary/50 border border-primary/30 rounded px-1.5 py-0.5 w-full outline-none focus:ring-1 focus:ring-primary"
                            autoFocus
                          />
                          <button onClick={handleConfirmRename} className="p-0.5 text-green-500 hover:text-green-400"><Check className="w-3.5 h-3.5" /></button>
                          <button onClick={handleCancelRename} className="p-0.5 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ) : (
                        <h3 className="text-sm font-bold text-foreground truncate">
                          {project.name || project.data?.projectName || "Projet Sans Nom"}
                        </h3>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                          project.type === 'ai'
                            ? 'bg-violet-500/10 text-violet-400'
                            : 'bg-blue-500/10 text-blue-400'
                        }`}>
                          {project.type === 'ai' ? 'IA' : 'Manuel'}
                        </span>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                          project.status === 'done'
                            ? 'bg-green-500/10 text-green-400'
                            : project.status === 'processing'
                            ? 'bg-amber-500/10 text-amber-400'
                            : 'bg-zinc-500/10 text-zinc-400'
                        }`}>
                          {project.status === 'done' ? 'Terminé' : project.status === 'processing' ? 'En cours' : 'Brouillon'}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground font-mono mt-1">
                        {new Date(project.updated_at || project.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })} • {project.data?.segments?.length || 0} segments
                      </p>
                    </div>
                  </div>

                  {/* Actions : share, rename & delete */}
                  {editingId !== project.id && (
                    <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSharingProjectId(project.id); setSharingProjectName(project.name || project.data?.projectName || '') }}
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
              {history.length < 6 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: history.length * 0.05 }}
                  onClick={handleNewProject}
                  className="p-4 border-2 border-dashed border-border hover:border-primary/50 rounded-xl cursor-pointer transition-all hover:bg-primary/5 flex items-center justify-center gap-3 min-h-[100px]"
                >
                  <Plus className="w-5 h-5 text-muted-foreground" />
                  <span className="text-sm font-medium text-muted-foreground">Nouveau Projet</span>
                </motion.div>
              )}
            </div>
          </div>

          {/* Projets partagés avec moi */}
          {sharedProjects.length > 0 && (
            <div className="mb-12">
              <div className="flex items-center gap-2 mb-4 px-1">
                <Users className="w-4 h-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Partagés avec moi</h2>
                <span className="text-[10px] text-muted-foreground font-bold">{sharedProjects.length}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {sharedProjects.map((project: any, i: number) => (
                  <motion.div
                    key={project.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.05 }}
                    onClick={() => loadFromHistory(project)}
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
                            {project.share_role === 'editor' ? 'Éditeur' : 'Lecteur'}
                          </span>
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {/* Zone de glisser-déposer pour importer une vidéo (crée un projet auto) */}
          <UploadZone />
        </div>
      );
    }

    // ── Écran de progression ──
    if (
      processingStep !== "idle" &&
      processingStep !== "ready" &&
      processingStep !== "done" &&
      processingStep !== "exporting"
    ) {
      return <ProgressPanel />;
    }

    // ── Éditeur NLE ──
    if (segments.length > 0) {
      return <EditorLayout />;
    }

    // ── Choix du mode : IA ou Manuel ──
    if (projectMode === null || projectMode === 'choose') {
      return (
        <div className="max-w-3xl mx-auto w-full pt-12">
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 text-center">
            <h2 className="text-2xl font-bold text-foreground">Comment souhaitez-vous travailler ?</h2>
            <p className="text-sm text-muted-foreground mt-2">
              {videoFiles.length} vidéo{videoFiles.length > 1 ? 's' : ''} importée{videoFiles.length > 1 ? 's' : ''} — {Math.round(useStore.getState().getTotalDuration())}s
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {/* Mode IA */}
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
                L'IA transcrit la voix et découpe automatiquement la vidéo en segments thématiques. Idéal pour les interviews longues.
              </p>
            </motion.div>

            {/* Mode Manuel */}
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
              <h3 className="text-lg font-bold text-foreground mb-2">Découpe manuelle</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Créez et ajustez vos segments manuellement sur la timeline. Contrôle total sur le découpage.
              </p>
            </motion.div>
          </div>
        </div>
      );
    }

    // ── Mode IA : vue pré-analyse ──
    if (projectMode === 'ai') {
      return (
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
                  { label: "Vidéo(s)", value: videoFiles.length },
                  { label: "Séquences", value: segments.length },
                  { label: "Durée totale", value: useStore.getState().getTotalDuration().toFixed(0) + "s" },
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
              ← Changer de mode
            </button>
          </div>
        </div>
      );
    }

    // ── Mode Manuel : éditeur direct (avec segments vides) ──
    return <EditorLayout />;
  };

  // Auth loading
  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  // Not authenticated — show login/register
  if (!isAuthenticated) {
    return <AuthScreen />;
  }

  if (!setupChecked) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background font-sans selection:bg-primary/20">
      <AnimatePresence>
        {showSetup && <SetupWizard onComplete={handleSetupComplete} />}
      </AnimatePresence>

      <Header onOpenSetup={() => setShowSetup(true)} onOpenAdmin={() => setShowAdmin(true)} />

      {showAdmin && user?.role === 'admin' ? (
        <AdminDashboard onBack={() => setShowAdmin(false)} />
      ) : (
        <main className={segments.length > 0 ? "" : "max-w-7xl mx-auto px-6 py-8"}>
          {renderContent()}
        </main>
      )}

      {/* Share dialog */}
      <AnimatePresence>
        {sharingProjectId && (
          <ShareDialog
            projectId={sharingProjectId}
            projectName={sharingProjectName}
            onClose={() => setSharingProjectId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;

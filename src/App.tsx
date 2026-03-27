/**
 * APP.TSX : Composant racine de l'application
 *
 * Gere la navigation entre les differentes vues de l'application :
 * - Ecran d'accueil avec upload et projets recents
 * - Choix du mode de travail (manuel ou IA)
 * - Ecran de progression pendant le traitement IA
 * - Editeur NLE (Non-Linear Editor) avec les segments generes
 * - Vue pre-analyse avec previsualisation video et panneau IA
 *
 * Ecoute egalement les evenements IPC (progression, segments Whisper)
 * en provenance du processus principal Electron.
 */

// Imports React et hooks
import { useEffect, useState } from "react";
import { useStore } from "@/store/useStore";

// Composants de l'interface
import Header from "@/components/new/Header";
import UploadZone from "@/components/new/UploadZone";
import AIAnalysisPanel from "@/components/new/AIAnalysisPanel";
import ProgressPanel from "@/components/new/ProgressPanel";
import VideoPreview from "@/components/new/VideoPreview";
import EditorLayout from "@/components/new/EditorLayout";
import SetupWizard from "@/components/SetupWizard";

// Bibliotheques d'animation et d'icones
import { motion, AnimatePresence } from "framer-motion";
import { Film, Loader2, RotateCcw, ChevronRight, Scissors, Brain } from "lucide-react";

function App() {
  // --- Recuperation de l'etat global depuis le store Zustand ---
  const {
    videoFiles,
    processingStep,
    segments,
    workMode,
    setWorkMode,
    addTranscriptSegment,
    setProcessing,
    history,
    loadHistory,
    loadFromHistory,
  } = useStore();

  // --- Etat local : gestion de l'assistant de configuration (premier lancement) ---
  const [showSetup, setShowSetup] = useState(false);
  const [setupChecked, setSetupChecked] = useState(false);

  // --- Effet : verification du premier lancement et chargement de l'historique ---
  useEffect(() => {
    const checkFirstRun = async () => {
      const setupComplete = localStorage.getItem("decoupeur-video-setup-complete");
      if (!setupComplete) setShowSetup(true);
      setSetupChecked(true);

      // Charger l'historique au demarrage
      await loadHistory();
    };
    checkFirstRun();
  }, [loadHistory]);

  // Callback de fin de configuration : marque le setup comme termine
  const handleSetupComplete = () => {
    localStorage.setItem("decoupeur-video-setup-complete", "true");
    setShowSetup(false);
  };

  // --- Effet : ecoute des evenements IPC du processus principal Electron ---
  // Recoit les mises a jour de progression et les segments de transcription en temps reel
  useEffect(() => {
    const unsubProgress = window.electron.onProgress(({ progress, message }) => {
      setProcessing(processingStep, progress, message);
    });

    const unsubSegment = window.electron.onTranscriptSegment((segment) => {
      addTranscriptSegment(segment as any);
    });

    return () => {
      unsubProgress();
      unsubSegment();
    };
  }, [processingStep, setProcessing, addTranscriptSegment]);

  // --- Fonction de rendu conditionnel du contenu principal ---
  const renderContent = () => {
    // -- Ecran d'accueil : aucune video importee --
    if (videoFiles.length === 0) {
      return (
        <div className="max-w-4xl mx-auto w-full pt-12">
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-12 text-center"
          >
            <h1 className="text-4xl font-black text-foreground tracking-tight">Clipr</h1>
          </motion.div>

          {/* Section projets recents */}
          <AnimatePresence>
            {history && history.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-12"
              >
                <div className="flex items-center justify-between mb-4 px-1">
                  <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <RotateCcw className="w-4 h-4 text-primary" />
                    Projets recents
                  </h2>
                  <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                    {history.length} sauvegardes
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {history.slice(0, 4).map((project, i) => (
                    <motion.div
                      key={project.path || i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.1 }}
                      onClick={() => loadFromHistory(project)}
                      className="group p-4 bg-card hover:bg-secondary/50 border border-border rounded-xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                          <Film className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-sm font-bold text-foreground truncate">{project.projectName || "Projet Sans Nom"}</h3>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {new Date(project.date).toLocaleDateString()} • {project.segments?.length || 0} segments
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-all -translate-x-2 group-hover:translate-x-0" />
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Zone de glisser-deposer pour importer une video */}
          <UploadZone />
        </div>
      );
    }

    // -- Ecran de progression : traitement en cours (sauf export qui ne bloque pas) --
    if (
      processingStep !== "idle" &&
      processingStep !== "ready" &&
      processingStep !== "done" &&
      processingStep !== "exporting"
    ) {
      return <ProgressPanel />;
    }

    // -- Editeur NLE : mode manuel OU segments generes --
    if (workMode === 'manual' || segments.length > 0) {
      return <EditorLayout />;
    }

    // -- Ecran de choix : mode manuel ou IA --
    if (workMode === 'choose') {
      return (
        <div className="max-w-3xl mx-auto w-full pt-16">
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-12"
          >
            <h2 className="text-2xl font-bold text-foreground mb-2">Comment voulez-vous travailler ?</h2>
            <p className="text-sm text-muted-foreground">
              {videoFiles.length === 1 ? videoFiles[0].name : `${videoFiles.length} videos`}
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {/* Option : Decoupage manuel */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              onClick={() => setWorkMode('manual')}
              className="group p-8 bg-card hover:bg-secondary/30 border-2 border-border hover:border-primary rounded-2xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-xl"
            >
              <div className="flex flex-col items-center text-center gap-5">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center group-hover:bg-primary group-hover:scale-110 transition-all">
                  <Scissors className="w-8 h-8 text-primary group-hover:text-primary-foreground transition-colors" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground mb-2">Decouper manuellement</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Accedez directement a l'editeur pour creer vos segments a la main sur la timeline.
                  </p>
                </div>
              </div>
            </motion.div>

            {/* Option : Analyse IA */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              onClick={() => setWorkMode('ai')}
              className="group p-8 bg-card hover:bg-secondary/30 border-2 border-border hover:border-primary rounded-2xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-xl"
            >
              <div className="flex flex-col items-center text-center gap-5">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center group-hover:bg-primary group-hover:scale-110 transition-all">
                  <Brain className="w-8 h-8 text-primary group-hover:text-primary-foreground transition-colors" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground mb-2">Analyser avec l'IA</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    L'IA transcrit la voix et decoupe automatiquement en chapitres thematiques.
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      );
    }

    // -- Vue pre-analyse : previsualisation video + panneau de configuration IA --
    return (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 mt-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
        {/* Colonne principale : lecteur video */}
        <div className="lg:col-span-3 space-y-6">
          <VideoPreview />
        </div>

        {/* Colonne laterale : panneau IA et statistiques */}
        <div className="space-y-6">
          <AIAnalysisPanel />

          {/* Carte de statistiques rapides */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="bg-card rounded-xl border border-border p-5 shadow-sm"
          >
            <h2 className="text-sm font-semibold text-foreground mb-4">Statistiques</h2>
            <div className="space-y-3 font-mono">
              {[
                { label: "Video(s)", value: videoFiles.length },
                { label: "Sequences", value: segments.length },
                { label: "Duree totale", value: useStore.getState().getTotalDuration().toFixed(0) + "s" },
              ].map((stat) => (
                <div key={stat.label} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground uppercase">{stat.label}</span>
                  <span className="font-bold text-primary">{stat.value}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    );
  };

  // --- Ecran de chargement : verification de la configuration en cours ---
  if (!setupChecked) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  // --- Rendu principal de l'application ---
  return (
    <div className="min-h-screen bg-background font-sans selection:bg-primary/20">
      {/* Assistant de configuration (premier lancement ou acces manuel) */}
      <AnimatePresence>
        {showSetup && <SetupWizard onComplete={handleSetupComplete} />}
      </AnimatePresence>

      {/* En-tete de l'application avec navigation et parametres */}
      <Header onOpenSetup={() => setShowSetup(true)} />

      {/* Contenu principal : adapte le padding selon le mode editeur ou non */}
      <main className={(workMode === 'manual' || segments.length > 0) ? "" : "max-w-7xl mx-auto px-6 py-8"}>
        {renderContent()}
      </main>
    </div>
  );
}

export default App;

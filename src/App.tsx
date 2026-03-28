/**
 * APP.TSX : Composant racine de l'application
 *
 * Gère la navigation entre les différentes vues de l'application :
 * - Écran d'accueil avec upload et projets récents
 * - Écran de progression pendant le traitement IA
 * - Éditeur NLE (Non-Linear Editor) avec les segments générés
 * - Vue pré-analyse avec prévisualisation vidéo et panneau IA
 *
 * Écoute également les événements IPC (progression, segments Whisper)
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

// Bibliothèques d'animation et d'icônes
import { motion, AnimatePresence } from "framer-motion";
import { Film, Loader2, RotateCcw, ChevronRight } from "lucide-react";

function App() {
  // ─── Récupération de l'état global depuis le store Zustand ───
  const {
    videoFiles,
    processingStep,
    segments,
    addTranscriptSegment,
    setProcessing,
    history,
    loadHistory,
    loadFromHistory,
  } = useStore();

  // ─── État local : gestion de l'assistant de configuration (premier lancement) ───
  const [showSetup, setShowSetup] = useState(false);
  const [setupChecked, setSetupChecked] = useState(false);

  // ─── Effet : vérification du premier lancement et chargement de l'historique ───
  useEffect(() => {
    const checkFirstRun = async () => {
      const setupComplete = localStorage.getItem("decoupeur-video-setup-complete");
      if (!setupComplete) setShowSetup(true);
      setSetupChecked(true);

      // Charger l'historique au démarrage
      await loadHistory();
    };
    checkFirstRun();
  }, [loadHistory]);

  // Callback de fin de configuration : marque le setup comme terminé
  const handleSetupComplete = () => {
    localStorage.setItem("decoupeur-video-setup-complete", "true");
    setShowSetup(false);
  };

  // ─── Effet : ecoute des evenements WebSocket du serveur ───
  useEffect(() => {
    if (!(window as any).electron) return;
    const unsubProgress = (window as any).electron.onProgress(({ progress, message }: any) => {
      setProcessing(processingStep, progress, message);
    });

    const unsubSegment = (window as any).electron.onTranscriptSegment((segment: any) => {
      addTranscriptSegment(segment as any);
    });

    return () => {
      unsubProgress();
      unsubSegment();
    };
  }, [processingStep, setProcessing, addTranscriptSegment]);

  // ─── Fonction de rendu conditionnel du contenu principal ───
  const renderContent = () => {
    // ── Écran d'accueil : aucune vidéo importée ──
    // Affiche le titre, les projets récents et la zone d'upload
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

          {/* Section projets récents : liste des sauvegardes précédentes */}
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
                    Projets récents
                  </h2>
                  <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                    {history.length} sauvegardes
                  </span>
                </div>

                {/* Grille de cartes projet (max 4 affichés) */}
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

          {/* Zone de glisser-déposer pour importer une vidéo */}
          <UploadZone />
        </div>
      );
    }

    // ── Écran de progression : traitement en cours (sauf export qui ne bloque pas) ──
    if (
      processingStep !== "idle" &&
      processingStep !== "ready" &&
      processingStep !== "done" &&
      processingStep !== "exporting"
    ) {
      return <ProgressPanel />;
    }

    // ── Éditeur NLE : segments générés, affichage du layout d'édition libre ──
    const hasSegments = segments.length > 0;

    if (hasSegments) {
      return <EditorLayout />;
    }

    // ── Vue pré-analyse : prévisualisation vidéo + panneau de configuration IA ──
    return (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 mt-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
        {/* Colonne principale : lecteur vidéo */}
        <div className="lg:col-span-3 space-y-6">
          <VideoPreview />
        </div>

        {/* Colonne latérale : panneau IA et statistiques */}
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
        </div>
      </div>
    );
  };

  // ─── Écran de chargement : vérification de la configuration en cours ───
  if (!setupChecked) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  // ─── Rendu principal de l'application ───
  return (
    <div className="min-h-screen bg-background font-sans selection:bg-primary/20">
      {/* Assistant de configuration (premier lancement ou accès manuel) */}
      <AnimatePresence>
        {showSetup && <SetupWizard onComplete={handleSetupComplete} />}
      </AnimatePresence>

      {/* En-tête de l'application avec navigation et paramètres */}
      <Header onOpenSetup={() => setShowSetup(true)} />

      {/* Contenu principal : adapte le padding selon le mode éditeur ou non */}
      <main className={segments.length > 0 ? "" : "max-w-7xl mx-auto px-6 py-8"}>
        {renderContent()}
      </main>
    </div>
  );
}

export default App;

/**
 * =============================================================================
 * Fichier : App.tsx
 * Rôle    : Composant racine de l'application React — le "routeur" principal.
 *
 *           Ce composant gère la navigation entre les différentes vues :
 *           - Écran de connexion/inscription (AuthScreen)
 *           - Wizard de configuration au premier lancement (SetupWizard)
 *           - Tableau de bord admin (AdminDashboard)
 *           - Écran d'accueil avec projets récents (max 6) et création de projet
 *           - Outil de transcription audio standalone (TranscriptionTool)
 *           - Outil de transcription linguistique patois (LinguisticTool)
 *           - Vue "pré-analyse" avec prévisualisation vidéo + panneau IA
 *           - Écran de progression pendant le traitement IA (ProgressPanel)
 *           - Éditeur NLE (Non-Linear Editor) avec les segments générés
 *
 *           Il gère aussi :
 *           - Les raccourcis clavier (Ctrl+Z / Ctrl+Shift+Z pour undo/redo)
 *           - L'écoute des événements WebSocket (progression, résultats IA)
 *           - Le polling de l'historique des projets toutes les 10 secondes
 *           - Le partage de projets entre utilisateurs (ShareDialog)
 * =============================================================================
 */

// ── Imports React et state management ──
import { useEffect, useState } from "react";
import { useStore } from "@/store/useStore";         // Store principal (projets, vidéos, segments)
import { useAuthStore } from "@/store/useAuthStore"; // Store authentification (login, user)
import api from "@/api";                              // Client API (HTTP + WebSocket)

// ── Imports des composants de l'application ──
import Header from "@/components/new/Header";                  // Barre de navigation en haut
import UploadZone from "@/components/new/UploadZone";          // Zone de dépôt drag & drop
import AIAnalysisPanel from "@/components/new/AIAnalysisPanel"; // Panneau de configuration IA
import ProgressPanel from "@/components/new/ProgressPanel";    // Overlay de progression
import VideoPreview from "@/components/new/VideoPreview";      // Lecteur vidéo
import EditorLayout from "@/components/new/EditorLayout";      // Éditeur NLE avec grille
import TranscriptionTool from "@/components/new/TranscriptionTool";  // Transcription audio
import LinguisticTool from "@/components/new/LinguisticTool";  // Transcription linguistique
import SetupWizard from "@/components/SetupWizard";            // Assistant de config initiale
import AuthScreen from "@/components/AuthScreen";              // Écran de connexion
import AdminDashboard from "@/components/AdminDashboard";      // Tableau de bord admin

import ShareDialog from "@/components/ShareDialog";            // Modale de partage de projet

// ── Imports bibliothèques externes ──
import { motion, AnimatePresence } from "framer-motion";       // Animations fluides
import { Film, Loader2, RotateCcw, Plus, Trash2, Pencil, Cpu, X, Check, Share2, Users, Brain, Scissors, Mic, BookOpen } from "lucide-react"; // Icônes
import logo from "@/assets/Clipr.svg";

/**
 * Composant principal App.
 * Détermine quelle vue afficher selon l'état de l'application :
 * authentification, projets, outils, éditeur, etc.
 */
function App() {
  // ── État d'authentification (depuis le store Zustand) ──
  const { isAuthenticated, isLoading: authLoading, checkAuth, user } = useAuthStore();

  // ── État principal de l'app (depuis le store Zustand "useStore") ──
  // On "destructure" le store pour récupérer uniquement les valeurs dont on a besoin.
  // Zustand est comme un gros objet global partagé entre tous les composants.
  const {
    videoFiles,            // Liste des fichiers vidéo importés par l'utilisateur
    processingStep,        // Étape actuelle du traitement IA ('idle', 'transcribing', 'analyzing', 'done', etc.)
    segments,              // Les segments thématiques découpés par l'IA (ou manuellement)
    addTranscriptSegment,  // Fonction pour ajouter un segment de transcription reçu en temps réel
    setProcessing,         // Fonction pour changer l'étape de traitement + progression
    setSegments,           // Fonction pour remplacer tous les segments d'un coup
    setTranscript,         // Fonction pour remplacer toute la transcription
    setAudioPaths,         // Fonction pour définir les chemins des fichiers audio extraits
    history,               // Historique des projets récents (max 6)
    loadHistory,           // Fonction pour recharger la liste des projets depuis le serveur
    loadFromHistory,       // Fonction pour ouvrir un projet depuis l'historique
    createProject,         // Fonction pour créer un nouveau projet vide
    deleteProject,         // Fonction pour supprimer un projet (soft delete)
    renameProject,         // Fonction pour renommer un projet
  } = useStore();

  // ── États locaux de l'interface ──
  const [showSetup, setShowSetup] = useState(false);            // Afficher le wizard de config ?
  const [setupChecked, setSetupChecked] = useState(false);      // A-t-on vérifié le premier lancement ?
  const [showAdmin, setShowAdmin] = useState(false);            // Afficher le dashboard admin ?
  const [editingId, setEditingId] = useState<string | null>(null);   // Projet en cours de renommage
  const [editingName, setEditingName] = useState("");                // Nouveau nom en cours de saisie
  const [sharingProjectId, setSharingProjectId] = useState<string | null>(null);  // Modale de partage
  const [sharingProjectName, setSharingProjectName] = useState("");
  const [sharedProjects, setSharedProjects] = useState<any[]>([]);   // Projets partagés avec moi
  const [projectMode, setProjectMode] = useState<'choose' | 'ai' | 'manual' | null>(null); // Mode du projet (IA ou manuel)
  const [showTranscriptionTool, setShowTranscriptionTool] = useState(false);  // Outil transcription
  const [activeTranscriptionProject, setActiveTranscriptionProject] = useState<any>(null);
  const [showVideoSegmentation, setShowVideoSegmentation] = useState(false);  // Outil segmentation vidéo
  const [showLinguisticTool, setShowLinguisticTool] = useState(false);  // Outil linguistique
  const [activeLinguisticProject, setActiveLinguisticProject] = useState<any>(null);
  const [showNewProjectChoice, setShowNewProjectChoice] = useState(false); // Menu "nouveau projet"

  // ══════════════════════════════════════════════════════════════════════════
  // ── useEffect = "effets de bord" qui se déclenchent automatiquement ──
  // C'est comme dire "quand X change, fais Y".
  // Le tableau à la fin (ex: [videoFiles.length]) = les "déclencheurs".
  // ══════════════════════════════════════════════════════════════════════════

  // Quand des vidéos sont importées depuis l'écran de segmentation,
  // on ferme cet écran et on passe au choix du mode (IA ou manuel)
  useEffect(() => {
    if (showVideoSegmentation && videoFiles.length > 0) {
      setShowVideoSegmentation(false);
      setProjectMode(null);
      setProcessing('idle', 0, '');
    }
  }, [videoFiles.length, showVideoSegmentation]);

  // Au tout premier chargement de l'app, on vérifie si le token JWT
  // stocké dans le localStorage est encore valide
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Raccourcis clavier : Ctrl+Z (annuler) / Ctrl+Shift+Z (retablir)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          useStore.getState().redo();
        } else {
          useStore.getState().undo();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Quand l'utilisateur est connecté :
  // 1. Vérifier si c'est le tout premier lancement (wizard de config)
  // 2. Charger l'historique des projets + les projets partagés
  // 3. Lancer un "polling" toutes les 10 secondes pour rafraîchir les statuts
  //    (utile quand une analyse IA tourne en arrière-plan)
  useEffect(() => {
    if (!isAuthenticated) return; // Pas connecté = on ne fait rien

    const checkFirstRun = async () => {
      // Si "decoupeur-video-setup-complete" n'existe pas dans le localStorage,
      // c'est la première fois → afficher le wizard de configuration
      const setupComplete = localStorage.getItem("decoupeur-video-setup-complete");
      if (!setupComplete) setShowSetup(true);
      setSetupChecked(true);
      await loadHistory();
      try { setSharedProjects(await api.getSharedProjects()) } catch {}
    };
    checkFirstRun();

    // Rafraîchir la liste des projets toutes les 10 secondes
    // (seulement si on est sur l'écran d'accueil, pas dans un projet ouvert)
    const interval = setInterval(async () => {
      if (!useStore.getState().activeProjectId) {
        loadHistory();
        try { setSharedProjects(await api.getSharedProjects()) } catch {}
      }
    }, 10000);
    // Nettoyer le timer quand le composant est démonté (bonne pratique React)
    return () => clearInterval(interval);
  }, [loadHistory, isAuthenticated]);

  const handleSetupComplete = () => {
    localStorage.setItem("decoupeur-video-setup-complete", "true");
    setShowSetup(false);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ── ÉCOUTE WEBSOCKET : recevoir les événements en temps réel ──
  // Le serveur envoie des messages WebSocket pendant le traitement IA :
  // - 'progress' : pourcentage de progression + message d'étape
  // - 'transcript:segment' : un bout de transcription (reçu au fur et à mesure)
  // - 'analysis:complete' : l'analyse est terminée, voici les résultats
  // - 'analysis:error' : l'analyse a échoué
  //
  // (window as any).electron = l'objet api.ts exposé sur window
  // Chaque onXxx() retourne une fonction "unsub" pour se désabonner
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!(window as any).electron) return;

    // Quand le serveur envoie un update de progression (extraction audio, transcription, analyse)
    const unsubProgress = (window as any).electron.onProgress((data: any) => {
      if (!useStore.getState().activeProjectId) return; // Ignorer si pas de projet actif
      const step = data.step || processingStep;
      setProcessing(step, data.progress, data.message);
    });

    // Quand un segment de transcription arrive en temps réel
    // (Whisper transcrit au fur et à mesure, on affiche chaque segment dès qu'il arrive)
    const unsubSegment = (window as any).electron.onTranscriptSegment((segment: any) => {
      if (!useStore.getState().activeProjectId) return;
      addTranscriptSegment(segment as any);
    });

    // Quand l'analyse IA est terminée côté serveur → charger les résultats
    const unsubComplete = (window as any).electron.onAnalysisComplete((data: any) => {
      if (!useStore.getState().activeProjectId) return;
      if (data.segments) setSegments(data.segments);     // Les segments thématiques découpés
      if (data.transcript) setTranscript(data.transcript); // La transcription complète
      if (data.audioPaths) setAudioPaths(data.audioPaths); // Les fichiers audio extraits
      setProcessing('done', 100, 'Analyse terminée !');
      loadHistory(); // Rafraîchir l'historique (le projet est maintenant "terminé")
    });

    // Quand l'analyse IA a échoué côté serveur
    const unsubError = (window as any).electron.onAnalysisError((data: any) => {
      if (!useStore.getState().activeProjectId) return;
      setProcessing('error', 0, data.message || 'Erreur d\'analyse');
      loadHistory();
    });

    // Nettoyage : se désabonner de tous les événements quand le composant se démonte
    return () => {
      unsubProgress();
      unsubSegment();
      unsubComplete();
      unsubError();
    };
  }, [processingStep, setProcessing, addTranscriptSegment, setSegments, setTranscript, setAudioPaths, loadHistory]);

  // ══════════════════════════════════════════════════════════════════════════
  // ── HANDLERS : Fonctions déclenchées par les actions de l'utilisateur ──
  // ══════════════════════════════════════════════════════════════════════════

  /** Démarre le mode "renommage" d'un projet (affiche un input au lieu du titre) */
  const handleStartRename = (e: React.MouseEvent, id: string, currentName: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingName(currentName);
  };

  /** Confirme le renommage (envoie au serveur) */
  const handleConfirmRename = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editingId && editingName.trim()) {
      await renameProject(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName("");
  };

  /** Annule le renommage et ferme l'input */
  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
    setEditingName("");
  };

  /** Supprime un projet (soft delete côté serveur) */
  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteProject(id);
  };

  const handleNewProject = () => {
    setShowNewProjectChoice(true);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ── renderContent() : Le "routeur" de vues ──
  // Cette fonction détermine quel écran afficher en fonction de l'état.
  // C'est une cascade de conditions "if" : la première qui matche gagne.
  //
  // L'ordre est important ! Par exemple, si l'outil transcription est ouvert,
  // on l'affiche même s'il y a des vidéos dans le store.
  //
  // Flux de navigation :
  //   1. Outil transcription ouvert ? → TranscriptionTool
  //   2. Outil linguistique ouvert ? → LinguisticTool
  //   3. Écran segmentation vidéo (upload) ? → UploadZone
  //   4. Pas de vidéo et pas de projet ? → Écran d'accueil (projets + outils)
  //   5. Traitement en cours ? → ProgressPanel (overlay de progression)
  //   6. Des segments existent ? → EditorLayout (l'éditeur NLE)
  //   7. Vidéos uploadées mais pas encore de mode choisi ? → Choix IA/Manuel
  //   8. Mode IA choisi ? → VideoPreview + AIAnalysisPanel
  //   9. Mode Manuel ? → EditorLayout directement
  // ══════════════════════════════════════════════════════════════════════════
  const renderContent = () => {
    // ── 1. Outil de transcription audio standalone ──
    if (showTranscriptionTool) {
      return <TranscriptionTool onBack={() => { setShowTranscriptionTool(false); setActiveTranscriptionProject(null); loadHistory(); }} initialProject={activeTranscriptionProject} />;
    }

    // ── 2. Outil de transcription linguistique (patois/vernaculaire) ──
    if (showLinguisticTool) {
      return <LinguisticTool onBack={() => { setShowLinguisticTool(false); setActiveLinguisticProject(null); loadHistory(); }} initialProject={activeLinguisticProject} />;
    }

    // ── 3. Écran de segmentation vidéo (zone d'upload) ──
    if (showVideoSegmentation && videoFiles.length === 0 && !useStore.getState().activeProjectId) {
      return (
        <div className="max-w-4xl mx-auto w-full pt-8">
          <div className="flex items-center gap-4 mb-8">
            <button onClick={() => setShowVideoSegmentation(false)} className="p-2 rounded-lg hover:bg-secondary transition-colors">
              <Film className="w-5 h-5 text-muted-foreground" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Scissors className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-foreground">Segmentation d'interview vidéo</h1>
                <p className="text-xs text-muted-foreground">Déposez une ou plusieurs vidéos pour lancer l'analyse IA</p>
              </div>
            </div>
          </div>
          <UploadZone />
        </div>
      );
    }


    // ── 4. Écran d'accueil : aucune vidéo importée et pas de projet actif ──
    // C'est la vue par défaut. On affiche :
    // - Le logo Clipr
    // - La grille des projets récents (max 6)
    // - Les projets partagés avec moi
    // - Les raccourcis vers les outils (transcription, segmentation, linguistique)
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
                  onClick={() => {
                    if (editingId === project.id) return;
                    if (project.data?.toolType === 'transcription') {
                      setActiveTranscriptionProject(project);
                      setShowTranscriptionTool(true);
                    } else if (project.data?.toolType === 'linguistic') {
                      setActiveLinguisticProject(project);
                      setShowLinguisticTool(true);
                    } else {
                      loadFromHistory(project);
                    }
                  }}
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
                          project.data?.toolType === 'transcription'
                            ? 'bg-primary/10 text-primary'
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
                          {project.status === 'done' ? 'Terminé' : project.status === 'processing' ? 'En cours' : 'Brouillon'}
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
                        onClick={() => { setShowNewProjectChoice(false); setShowTranscriptionTool(true) }}
                        className="w-full flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-primary/10 transition-colors text-left"
                      >
                        <Mic className="w-4 h-4 text-primary shrink-0" />
                        <span className="text-xs font-medium text-foreground">Transcription audio/video</span>
                      </button>
                      <button
                        onClick={() => { setShowNewProjectChoice(false); setShowVideoSegmentation(true) }}
                        className="w-full flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-violet-500/10 transition-colors text-left"
                      >
                        <Scissors className="w-4 h-4 text-violet-400 shrink-0" />
                        <span className="text-xs font-medium text-foreground">Segmentation vidéo</span>
                      </button>
                      <button
                        onClick={() => { setShowNewProjectChoice(false); setShowLinguisticTool(true) }}
                        className="w-full flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-emerald-500/10 transition-colors text-left"
                      >
                        <BookOpen className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span className="text-xs font-medium text-foreground">Transcription linguistique</span>
                      </button>
                    </div>
                  ) : (
                    <div
                      onClick={handleNewProject}
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
                onClick={() => setShowTranscriptionTool(true)}
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
                onClick={() => setShowVideoSegmentation(true)}
                className="group p-5 bg-card border-2 border-border hover:border-primary/50 rounded-xl cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center text-violet-400 group-hover:bg-violet-500 group-hover:text-white transition-colors">
                    <Scissors className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground">Segmentation d'interview vidéo</h3>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Analyse IA pour découper automatiquement une interview en segments
                    </p>
                  </div>
                </div>
              </motion.div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.1 }}
                onClick={() => setShowLinguisticTool(true)}
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
      );
    }

    // ── 5. Écran de progression (l'IA travaille en arrière-plan) ──
    // Affiché quand le traitement est en cours (ni idle, ni ready, ni done, ni export)
    if (
      processingStep !== "idle" &&
      processingStep !== "ready" &&
      processingStep !== "done" &&
      processingStep !== "exporting"
    ) {
      return <ProgressPanel />;
    }

    // ── 6. Éditeur NLE (Non-Linear Editor) — l'analyse IA est terminée ──
    // Quand on a des segments (découpés par l'IA ou créés manuellement),
    // on affiche l'éditeur complet avec timeline, segments, vidéo, etc.
    if (segments.length > 0) {
      return <EditorLayout />;
    }

    // ── 7. Choix du mode : IA automatique ou découpe manuelle ──
    // Affiché juste après l'upload de vidéos, avant de commencer le travail
    if (projectMode === null || projectMode === 'choose') {
      return (
        <div className="max-w-3xl mx-auto w-full pt-12">
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 text-center">
            <h2 className="text-2xl font-bold text-foreground">Comment souhaitez-vous travailler ?</h2>
            <p className="text-sm text-muted-foreground mt-2">
              {videoFiles.length} vidéo{videoFiles.length > 1 ? 's' : ''} importée{videoFiles.length > 1 ? 's' : ''} — {(() => { const t = Math.round(useStore.getState().getTotalDuration()); const h = Math.floor(t/3600); const m = Math.floor((t%3600)/60); const s = t%60; return h > 0 ? `${h}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s` : m > 0 ? `${m}m${String(s).padStart(2,'0')}s` : `${s}s`; })()}
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

    // ── 8. Mode IA : vue pré-analyse ──
    // L'utilisateur voit sa vidéo + le panneau de configuration de l'IA
    // (choix du modèle Whisper, modèle Ollama, langue, contexte, etc.)
    // Il peut ajuster les paramètres puis lancer l'analyse
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

    // ── 9. Mode Manuel : éditeur direct (sans segments pré-générés) ──
    // L'utilisateur crée ses segments à la main sur la timeline
    return <EditorLayout />;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ── RENDU PRINCIPAL DU COMPOSANT ──
  // Les conditions ci-dessous forment un "garde" : on vérifie les
  // prérequis avant d'afficher l'interface principale.
  // ══════════════════════════════════════════════════════════════════════════

  // Pendant qu'on vérifie le token JWT → afficher un spinner
  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  // Pas connecté → afficher l'écran de login/inscription
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

  // ── L'interface principale (connecté + vérifié) ──
  return (
    <div className="min-h-screen bg-background font-sans selection:bg-primary/20">
      {/* Modale du wizard de configuration (au premier lancement) */}
      <AnimatePresence>
        {showSetup && <SetupWizard onComplete={handleSetupComplete} />}
      </AnimatePresence>

      {/* Barre de navigation en haut avec logo, bouton home, admin, etc. */}
      <Header onOpenSetup={() => setShowSetup(true)} onOpenAdmin={() => setShowAdmin(true)} onHome={() => {
        setShowTranscriptionTool(false);
        setActiveTranscriptionProject(null);
        setShowVideoSegmentation(false);
        setShowLinguisticTool(false);
        setActiveLinguisticProject(null);
        setShowAdmin(false);
        loadHistory();
      }} />

      {/* Contenu principal : soit le dashboard admin, soit la vue normale */}
      {showAdmin && user?.role === 'admin' ? (
        <AdminDashboard onBack={() => setShowAdmin(false)} onLoadProject={(data) => {
          setShowAdmin(false);
          if (data.data?.toolType === 'transcription' || data.toolType === 'transcription') {
            setActiveTranscriptionProject(data);
            setShowTranscriptionTool(true);
          } else if (data.data?.toolType === 'linguistic' || data.toolType === 'linguistic') {
            setActiveLinguisticProject(data);
            setShowLinguisticTool(true);
          } else {
            loadFromHistory(data);
          }
        }} />
      ) : (
        // Zone de contenu principal. Si on est dans l'éditeur NLE (segments > 0),
        // on ne limite pas la largeur (plein écran). Sinon, on centre avec max-w-7xl.
        <main className={segments.length > 0 ? "" : "max-w-7xl mx-auto px-6 py-8"}>
          {/* C'est ici que renderContent() décide quelle vue afficher */}
          {renderContent()}
        </main>
      )}

      {/* Modale de partage de projet (s'affiche par-dessus tout le reste) */}
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

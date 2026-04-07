/**
 * HEADER.TSX : Barre de navigation principale de l'application Clipr
 *
 * Ce fichier contient le composant Header qui s'affiche tout en haut de l'écran.
 * C'est la barre de navigation qui reste toujours visible (sticky).
 *
 * Elle contient :
 * - Le logo Clipr (cliquable pour revenir à l'accueil)
 * - Le nom du projet en cours (qu'on peut renommer en cliquant dessus)
 * - Un indicateur de traitement en cours (spinner animé)
 * - Des boutons d'action : accueil, sauvegarde, thème clair/sombre,
 *   documentation, paramètres, administration, déconnexion
 * - L'indicateur de la file d'attente IA (QueueStatus)
 *
 * Le header adapte son affichage selon l'état de l'application :
 * pas de projet, projet ouvert, traitement en cours, etc.
 */

// useState : pour gérer l'état local du renommage de projet
import { useState } from "react";

// Icônes importées depuis lucide-react (bibliothèque d'icônes légère et modulaire)
// Chaque icône correspond à un bouton ou un indicateur dans le header
import { Settings, Save, RotateCcw, Sun, Moon, BookOpen, Pencil, Check, X, Home, LogOut, User, Shield } from "lucide-react";

// Store Zustand principal : contient l'état global de l'application
// (fichiers vidéo, étape de traitement, projet actif, etc.)
import { useStore } from "@/store/useStore";

// Store d'authentification : contient les infos de l'utilisateur connecté
import { useAuthStore } from "@/store/useAuthStore";

// Hook de next-themes pour gérer le thème clair/sombre de l'application
import { useTheme } from "next-themes";

// Composant bouton du design system (shadcn/ui)
import { Button } from "@/components/ui/button";

// Composant qui affiche l'état de la file d'attente IA dans le header
import QueueStatus from "@/components/new/QueueStatus";

// Image SVG du logo Clipr
import logo from "@/assets/Clipr.svg";

/**
 * Interface des props (propriétés) du composant Header.
 * Les trois callbacks sont optionnels (marqués par "?") car le parent
 * peut ne pas vouloir gérer certaines actions.
 */
interface HeaderProps {
  onOpenSetup?: () => void;   // Appelé quand on clique sur le bouton Paramètres
  onOpenAdmin?: () => void;   // Appelé quand on clique sur le bouton Administration
  onHome?: () => void;        // Appelé quand on clique sur Accueil ou le logo
}

/**
 * Composant Header : barre de navigation sticky en haut de l'écran.
 * Reçoit les callbacks de navigation en props depuis le composant parent.
 */
const Header = ({ onOpenSetup, onOpenAdmin, onHome }: HeaderProps) => {
  // --- Extraction des données du store global ---
  // videoFiles : liste des fichiers vidéo importés
  // processingStep : étape actuelle du traitement ("idle", "transcribing", "analyzing", etc.)
  // reset : fonction pour réinitialiser l'état et revenir à l'écran d'accueil
  // saveProject : sauvegarde le projet en cours sur le serveur
  // activeProjectId / activeProjectName : identifiant et nom du projet ouvert
  // renameProject : fonction pour changer le nom d'un projet
  const { videoFiles, processingStep, reset, saveProject, activeProjectId, activeProjectName, renameProject } = useStore();

  // Récupère l'utilisateur connecté et la fonction de déconnexion
  const { user, logout } = useAuthStore();

  // Hook pour lire et changer le thème (clair ou sombre)
  const { theme, setTheme } = useTheme();

  // --- État local pour le renommage du projet ---
  // isRenaming : indique si l'utilisateur est en train de modifier le nom
  // tempName : contient le nouveau nom tapé dans le champ texte
  const [isRenaming, setIsRenaming] = useState(false);
  const [tempName, setTempName] = useState("");

  // --- Variables dérivées de l'état ---
  // hasVideos : vrai si au moins un fichier vidéo est chargé
  const hasVideos = videoFiles.length > 0;

  // hasProject : vrai si un projet est ouvert (a un ID)
  const hasProject = !!activeProjectId;

  // isProcessing : vrai si un traitement est en cours
  // (tout sauf "idle", "ready" et "done" qui sont des états de repos)
  const isProcessing =
    processingStep !== "idle" && processingStep !== "ready" && processingStep !== "done";

  /**
   * Bascule entre le thème clair et le thème sombre.
   * Si on est en mode sombre, on passe en clair, et vice versa.
   */
  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  /**
   * Démarre le mode renommage : on copie le nom actuel dans le champ temporaire
   * et on active le mode édition.
   */
  const handleStartRename = () => {
    setTempName(activeProjectName || '');
    setIsRenaming(true);
  };

  /**
   * Confirme le renommage : envoie le nouveau nom au serveur via renameProject(),
   * puis quitte le mode édition.
   * On vérifie que le nom n'est pas vide (après suppression des espaces).
   */
  const handleConfirmRename = async () => {
    if (activeProjectId && tempName.trim()) {
      await renameProject(activeProjectId, tempName.trim());
    }
    setIsRenaming(false);
  };

  /**
   * Annule le renommage : on quitte simplement le mode édition
   * sans sauvegarder le nom temporaire.
   */
  const handleCancelRename = () => {
    setIsRenaming(false);
  };

  // --- Rendu JSX ---
  return (
    // Header sticky : reste toujours visible en haut de la page
    // z-[60] : valeur de z-index élevée pour passer au-dessus des autres éléments
    // backdrop-blur-sm : flou léger en arrière-plan pour un effet "verre dépoli"
    <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-[60]">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">

        {/* ===== PARTIE GAUCHE : Logo et nom de l'application ===== */}
        {/* Cliquer sur le logo réinitialise l'état et ramène à l'accueil */}
        <div className="flex items-center gap-3 select-none cursor-pointer" onClick={() => { reset(); onHome?.(); }}>
          <div className="w-8 h-8 rounded-xl bg-primary/10 p-1 flex items-center justify-center overflow-hidden">
            <img src={logo} alt="Clipr Logo" className="w-6 h-6" />
          </div>
          <span className="text-xl font-bold tracking-tight text-foreground">Clipr</span>
        </div>

        {/* ===== PARTIE CENTRALE : Infos du projet en cours ===== */}
        <div className="flex-1 px-8">
          {/* Si un traitement est en cours, on affiche un indicateur animé */}
          {isProcessing ? (
            <div className="flex items-center gap-2 text-primary animate-pulse text-sm font-medium">
              <RotateCcw className="w-4 h-4 animate-spin-slow" />
              <span>Analyse ou traitement en cours...</span>
            </div>
          ) : hasProject ? (
            // Si un projet est ouvert et qu'aucun traitement n'est en cours,
            // on affiche le nom du projet (cliquable pour renommer)
            <div className="flex items-center gap-2">
              {/* Mode renommage : affiche un champ texte avec boutons valider/annuler */}
              {isRenaming ? (
                <div className="flex items-center gap-1.5">
                  <input
                    value={tempName}
                    onChange={(e) => setTempName(e.target.value)}
                    onKeyDown={(e) => {
                      // Entrée pour valider, Échap pour annuler
                      if (e.key === 'Enter') handleConfirmRename();
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    className="text-sm font-semibold text-foreground bg-secondary border border-primary/30 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-primary w-48"
                    autoFocus
                  />
                  {/* Bouton vert de validation */}
                  <button onClick={handleConfirmRename} className="p-1 text-green-500 hover:text-green-400"><Check className="w-4 h-4" /></button>
                  {/* Bouton d'annulation */}
                  <button onClick={handleCancelRename} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                </div>
              ) : (
                // Mode lecture : affiche le nom avec une icône crayon au survol
                <div className="flex items-center gap-2 group cursor-pointer" onClick={handleStartRename}>
                  <span className="text-sm font-semibold text-foreground truncate max-w-md">
                    {activeProjectName || 'Projet Sans Nom'}
                  </span>
                  {/* L'icône crayon apparaît au survol grâce à group-hover */}
                  <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              )}
              {/* Affiche le nom du fichier vidéo ou le nombre de vidéos */}
              {hasVideos && !isRenaming && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  {videoFiles.length === 1 ? videoFiles[0].name : `${videoFiles.length} vidéos`}
                </span>
              )}
            </div>
          ) : null}
        </div>

        {/* ===== PARTIE DROITE : Barre d'actions ===== */}
        <div className="flex items-center gap-2">
          {/* Indicateur de la file d'attente IA (nombre de tâches en cours/en attente) */}
          <QueueStatus />

          {/* Groupe de boutons séparé par une bordure droite */}
          <div className="flex items-center gap-1 border-r border-border pr-3 mr-1">
            {/* Bouton "Accueil" : visible uniquement quand un projet ou des vidéos sont chargés */}
            {(hasProject || hasVideos) && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { reset(); onHome?.(); }}
                className="h-8 gap-2 bg-primary/10 hover:bg-primary/20 text-primary border-primary/30"
                title="Retour à l'accueil (l'analyse continue en arrière-plan)"
              >
                <Home className="w-4 h-4" />
                <span>Accueil</span>
              </Button>
            )}

            {/* Bouton "Sauver" : visible uniquement quand des vidéos sont chargées */}
            {hasVideos && (
              <Button
                variant="secondary"
                size="sm"
                onClick={saveProject}
                className="h-8 gap-2 text-primary hover:text-primary transition-colors"
                title="Sauvegarder"
              >
                <Save className="w-4 h-4" />
                <span className="hidden sm:inline">Sauver</span>
              </Button>
            )}
          </div>

          {/* Bouton de bascule thème clair/sombre */}
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title={theme === "dark" ? "Mode clair" : "Mode sombre"}
          >
            {/* Affiche un soleil en mode sombre (pour passer en clair) et inversement */}
            {theme === "dark" ? (
              <Sun className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Moon className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>

          {/* Bouton vers la documentation (ouvre dans un nouvel onglet) */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open('/docs/', '_blank')}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title="Documentation"
          >
            <BookOpen className="w-4 h-4 text-muted-foreground" />
          </Button>

          {/* Bouton des paramètres IA / configuration */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSetup}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title="Configuration IA & Parametres"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </Button>

          {/* Bouton Administration : visible uniquement pour les utilisateurs avec le rôle "admin" */}
          {user?.role === 'admin' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenAdmin}
              className="w-8 h-8 p-0 rounded-lg hover:bg-primary/10 transition-colors"
              title="Administration"
            >
              <Shield className="w-4 h-4 text-primary" />
            </Button>
          )}

          {/* ===== Bloc utilisateur : nom + badge admin + bouton déconnexion ===== */}
          <div className="flex items-center gap-1.5 border-l border-border pl-3 ml-1">
            {/* Affichage du nom d'utilisateur et du badge admin si applicable */}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="w-3.5 h-3.5" />
              {/* Le nom est masqué sur les petits écrans (hidden sm:inline) */}
              <span className="font-medium hidden sm:inline">{user?.username}</span>
              {/* Badge "Admin" affiché uniquement pour les administrateurs */}
              {user?.role === 'admin' && (
                <span className="text-[8px] font-bold uppercase bg-primary/10 text-primary px-1 py-0.5 rounded">Admin</span>
              )}
            </div>
            {/* Bouton de déconnexion */}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-8 h-8 p-0 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors"
              title="Déconnexion"
            >
              <LogOut className="w-4 h-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;

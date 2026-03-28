/**
 * HEADER.TSX : Barre de navigation principale
 *
 * Affiche le logo, le nom du projet actif (éditable), et les actions :
 * ouvrir/sauvegarder un projet, réinitialiser, basculer le thème clair/sombre,
 * et accéder aux paramètres. Se fixe en haut de l'écran (sticky).
 */

import { useState } from "react";
import { Settings, Save, RotateCcw, Sun, Moon, BookOpen, Pencil, Check, X, Home, LogOut, User } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import logo from "@/assets/Clipr.svg";

interface HeaderProps {
  onOpenSetup?: () => void;
}

const Header = ({ onOpenSetup }: HeaderProps) => {
  const { videoFiles, processingStep, reset, saveProject, activeProjectId, activeProjectName, renameProject } = useStore();
  const { user, logout } = useAuthStore();
  const { theme, setTheme } = useTheme();

  const [isRenaming, setIsRenaming] = useState(false);
  const [tempName, setTempName] = useState("");

  const hasVideos = videoFiles.length > 0;
  const hasProject = !!activeProjectId;
  const isProcessing =
    processingStep !== "idle" && processingStep !== "ready" && processingStep !== "done";

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  const handleStartRename = () => {
    setTempName(activeProjectName || '');
    setIsRenaming(true);
  };

  const handleConfirmRename = async () => {
    if (activeProjectId && tempName.trim()) {
      await renameProject(activeProjectId, tempName.trim());
    }
    setIsRenaming(false);
  };

  const handleCancelRename = () => {
    setIsRenaming(false);
  };

  return (
    <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo et nom de l'application */}
        <div className="flex items-center gap-3 select-none">
          <div className="w-8 h-8 rounded-xl bg-primary/10 p-1 flex items-center justify-center overflow-hidden">
            <img src={logo} alt="Clipr Logo" className="w-6 h-6" />
          </div>
          <span className="text-xl font-bold tracking-tight text-foreground">Clipr</span>
        </div>

        {/* Informations du projet en cours */}
        <div className="flex-1 px-8">
          {isProcessing ? (
            <div className="flex items-center gap-2 text-primary animate-pulse text-sm font-medium">
              <RotateCcw className="w-4 h-4 animate-spin-slow" />
              <span>Analyse ou traitement en cours...</span>
            </div>
          ) : hasProject ? (
            <div className="flex items-center gap-2">
              {isRenaming ? (
                <div className="flex items-center gap-1.5">
                  <input
                    value={tempName}
                    onChange={(e) => setTempName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmRename();
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    className="text-sm font-semibold text-foreground bg-secondary border border-primary/30 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-primary w-48"
                    autoFocus
                  />
                  <button onClick={handleConfirmRename} className="p-1 text-green-500 hover:text-green-400"><Check className="w-4 h-4" /></button>
                  <button onClick={handleCancelRename} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                </div>
              ) : (
                <div className="flex items-center gap-2 group cursor-pointer" onClick={handleStartRename}>
                  <span className="text-sm font-semibold text-foreground truncate max-w-md">
                    {activeProjectName || 'Projet Sans Nom'}
                  </span>
                  <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              )}
              {hasVideos && !isRenaming && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  {videoFiles.length === 1 ? videoFiles[0].name : `${videoFiles.length} vidéos`}
                </span>
              )}
            </div>
          ) : null}
        </div>

        {/* Barre d'actions */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 border-r border-border pr-3 mr-1">
            {/* Retour accueil */}
            {hasProject && (
              <Button
                variant="secondary"
                size="sm"
                onClick={reset}
                disabled={isProcessing}
                className="h-8 gap-2"
                title="Retour à l'accueil"
              >
                <Home className="w-4 h-4" />
                <span className="hidden sm:inline">Accueil</span>
              </Button>
            )}

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

          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title={theme === "dark" ? "Mode clair" : "Mode sombre"}
          >
            {theme === "dark" ? (
              <Sun className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Moon className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open('/docs/', '_blank')}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title="Documentation"
          >
            <BookOpen className="w-4 h-4 text-muted-foreground" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSetup}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title="Configuration IA & Parametres"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </Button>

          {/* User info & logout */}
          <div className="flex items-center gap-1.5 border-l border-border pl-3 ml-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="w-3.5 h-3.5" />
              <span className="font-medium hidden sm:inline">{user?.username}</span>
              {user?.role === 'admin' && (
                <span className="text-[8px] font-bold uppercase bg-primary/10 text-primary px-1 py-0.5 rounded">Admin</span>
              )}
            </div>
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

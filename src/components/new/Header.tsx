/**
 * HEADER.TSX : Barre de navigation principale
 *
 * Affiche le logo, les informations du projet en cours, et les actions :
 * ouvrir/sauvegarder un projet, réinitialiser, basculer le thème clair/sombre,
 * et accéder aux paramètres. Se fixe en haut de l'écran (sticky).
 */

import { Settings, Save, FolderOpen, RotateCcw, Sun, Moon, BookOpen } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import logo from "@/assets/Clipr.svg";

interface HeaderProps {
  onOpenSetup?: () => void;
}

const Header = ({ onOpenSetup }: HeaderProps) => {
  // --- Etat global et utilitaires ---
  const { videoFiles, processingStep, reset, saveProject, loadProject } = useStore();
  const { theme, setTheme } = useTheme();

  // Drapeaux dérivés de l'état
  const hasVideos = videoFiles.length > 0;
  const isProcessing =
    processingStep !== "idle" && processingStep !== "ready" && processingStep !== "done";

  // Bascule entre thème clair et sombre
  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  // --- Rendu JSX ---
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

        {/* Informations du projet en cours ou indicateur de traitement */}
        <div className="flex-1 px-8">
          {isProcessing ? (
            <div className="flex items-center gap-2 text-primary animate-pulse text-sm font-medium">
              <RotateCcw className="w-4 h-4 animate-spin-slow" />
              <span>Analyse ou traitement en cours...</span>
            </div>
          ) : hasVideos ? (
            <div className="text-sm text-muted-foreground truncate max-w-md">
              <span className="font-semibold text-foreground">Projet:</span>{" "}
              {videoFiles.length === 1 ? videoFiles[0].name : `${videoFiles.length} vidéos`}
            </div>
          ) : null}
        </div>

        {/* Barre d'actions : gestion de projet, thème, paramètres */}
        <div className="flex items-center gap-2">
          {/* Actions projet : ouvrir, sauvegarder, réinitialiser */}
          <div className="flex items-center gap-1 border-r border-border pr-3 mr-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={loadProject}
              className="h-8 gap-2"
              title="Ouvrir un projet"
            >
              <FolderOpen className="w-4 h-4" />
              <span className="hidden sm:inline">Ouvrir</span>
            </Button>

            {hasVideos && (
              <>
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

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={reset}
                  disabled={isProcessing}
                  className="h-8 text-muted-foreground hover:text-destructive transition-colors px-2"
                  title="Nouveau projet / Reset"
                >
                  <RotateCcw className="w-4 h-4" />
                </Button>
              </>
            )}
          </div>

          {/* Bascule du thème clair/sombre */}
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

          {/* Documentation */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open('/docs/', '_blank')}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title="Documentation"
          >
            <BookOpen className="w-4 h-4 text-muted-foreground" />
          </Button>

          {/* Bouton parametres / configuration IA */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSetup}
            className="w-8 h-8 p-0 rounded-lg hover:bg-secondary/80 transition-colors"
            title="Configuration IA & Parametres"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </header>
  );
};

export default Header;

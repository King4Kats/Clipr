/**
 * HEADER.TSX : Barre de navigation principale
 *
 * Affiche le logo, les onglets de projets, et les actions :
 * ouvrir/sauvegarder un projet, reinitialiser, basculer le theme clair/sombre,
 * et acceder aux parametres. Se fixe en haut de l'ecran (sticky).
 */

import { Settings, Save, FolderOpen, RotateCcw, Sun, Moon, Plus, X } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import logo from "@/assets/Clipr.svg";

interface HeaderProps {
  onOpenSetup?: () => void;
}

const Header = ({ onOpenSetup }: HeaderProps) => {
  // --- Etat global et utilitaires ---
  const { videoFiles, processingStep, reset, saveProject, loadProject, tabs, activeTabId, addTab, removeTab, switchTab } = useStore();
  const { theme, setTheme } = useTheme();

  // Drapeaux derives de l'etat
  const hasVideos = videoFiles.length > 0;
  const isProcessing =
    processingStep !== "idle" && processingStep !== "ready" && processingStep !== "done";

  // Bascule entre theme clair et sombre
  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  // --- Rendu JSX ---
  return (
    <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo et nom de l'application */}
        <div className="flex items-center gap-3 select-none shrink-0">
          <div className="w-8 h-8 rounded-xl bg-primary/10 p-1 flex items-center justify-center overflow-hidden">
            <img src={logo} alt="Clipr Logo" className="w-6 h-6" />
          </div>
          <span className="text-xl font-bold tracking-tight text-foreground">Clipr</span>
        </div>

        {/* Onglets de projets */}
        <div className="flex-1 flex items-center gap-1 px-4 overflow-x-auto scrollbar-none">
          {tabs.length > 0 && tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => !isProcessing && switchTab(tab.id)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap shrink-0 ${
                isProcessing && activeTabId !== tab.id
                  ? "text-muted-foreground/40 cursor-not-allowed"
                  : activeTabId === tab.id
                  ? "bg-primary/10 text-primary border border-primary/20 cursor-default"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground cursor-pointer"
              }`}
            >
              <span className="max-w-[120px] truncate">{tab.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-all p-0.5 rounded"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {/* Bouton nouveau projet / onglet */}
          {hasVideos && (
            <Button
              variant="ghost"
              size="sm"
              onClick={addTab}
              className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-primary"
              title="Nouveau projet (nouvel onglet)"
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          )}

          {/* Info projet courant (quand pas d'onglets) */}
          {tabs.length === 0 && (
            <>
              {isProcessing ? (
                <div className="flex items-center gap-2 text-primary animate-pulse text-sm font-medium">
                  <RotateCcw className="w-4 h-4 animate-spin-slow" />
                  <span>Analyse ou traitement en cours...</span>
                </div>
              ) : hasVideos ? (
                <div className="text-sm text-muted-foreground truncate max-w-md">
                  <span className="font-semibold text-foreground">Projet:</span>{" "}
                  {videoFiles.length === 1 ? videoFiles[0].name : `${videoFiles.length} videos`}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Barre d'actions : gestion de projet, theme, parametres */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Actions projet : ouvrir, sauvegarder, reinitialiser */}
          <div className="flex items-center gap-1 border-r border-border pr-3 mr-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                // En web, on charge depuis l'historique (pas de dialogue fichier)
                loadProject()
              }}
              className="h-8 gap-2"
              title="Ouvrir un projet récent"
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

          {/* Bascule du theme clair/sombre */}
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

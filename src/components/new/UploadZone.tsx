/**
 * UPLOADZONE.TSX : Zone d'importation vidéo (drag & drop)
 *
 * Composant d'upload permettant à l'utilisateur d'importer des vidéos
 * soit par glisser-déposer, soit via un dialogue de sélection de fichiers.
 * Valide les extensions vidéo et récupère la durée via FFmpeg.
 */

import { useState, useCallback, useEffect } from "react";
import { Upload, Film, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "@/store/useStore";

const UploadZone = () => {
  // --- Etat local : indicateurs de drag & chargement ---
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [convertProgress, setConvertProgress] = useState<{ percent: number; message: string } | null>(null);
  const { addVideoFile, setProcessing } = useStore();

  // Ecouter les events de progression IPC pendant la conversion
  useEffect(() => {
    if (!isLoading) return;
    const unsub = window.electron.onProgress(({ progress, message }) => {
      setConvertProgress({ percent: Math.round(progress), message });
    });
    return () => { unsub(); };
  }, [isLoading]);

  // Formats non supportés nativement par le lecteur HTML5 de Chromium
  const UNSUPPORTED_FORMATS = ['mts', 'avi', 'mkv', 'mov', 'wmv', 'flv'];

  // Traite les fichiers sélectionnés : convertit si nécessaire, récupère la durée et ajoute au store
  const handleFiles = useCallback(
    async (filePaths: string[]) => {
      setIsLoading(true);
      setConvertProgress(null);
      try {
        for (const filePath of filePaths) {
          const ext = filePath.split('.').pop()?.toLowerCase() || '';
          let playablePath = filePath;

          // Convertir en MP4 si le format n'est pas supporté par le lecteur
          if (UNSUPPORTED_FORMATS.includes(ext)) {
            setConvertProgress({ percent: 0, message: 'Conversion vidéo en cours...' });
            playablePath = await window.electron.convertToMp4(filePath);
          }

          setConvertProgress(null);
          const duration = await window.electron.getVideoDuration(filePath);
          const name = filePath.split(/[\\/]/).pop() || "video";

          addVideoFile({
            path: playablePath,
            originalPath: filePath,
            name,
            duration,
            size: 0,
          });
        }
        setProcessing("idle", 0, "");
      } catch (error) {
        console.error("Erreur chargement vidéo:", error);
        setProcessing("error", 0, "Erreur lors du chargement de la vidéo");
      }
      setIsLoading(false);
      setConvertProgress(null);
    },
    [addVideoFile, setProcessing]
  );

  // Ouvre le dialogue natif de sélection de fichiers vidéo
  const handleClick = async () => {
    if (isLoading) return;
    const filePaths = await window.electron.openVideosDialog();
    if (filePaths && filePaths.length > 0) {
      handleFiles(filePaths);
    }
  };

  // --- Gestionnaires de drag & drop ---
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  // Valide les extensions vidéo autorisées et traite les fichiers déposés
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isLoading) return;

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const videoExtensions = ["mp4", "avi", "mov", "mkv", "mts", "webm"];
      const validPaths: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path: string };
        const ext = file.name.split(".").pop()?.toLowerCase();
        if (ext && videoExtensions.includes(ext) && file.path) {
          validPaths.push(file.path);
        }
      }

      if (validPaths.length > 0) {
        handleFiles(validPaths);
      }
    }
  };

  // --- Rendu : zone d'upload avec indicateurs visuels ---
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="relative group cursor-pointer"
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`border-2 border-dashed rounded-lg p-10 text-center transition-all duration-300 bg-card/50 ${isDragging
            ? "border-primary glow bg-primary/5 scale-[1.02]"
            : isLoading
            ? "border-primary/50 bg-primary/5"
            : "border-border hover:border-primary hover:glow"
          }`}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div
              className={`w-16 h-16 rounded-full bg-secondary flex items-center justify-center transition-colors ${isDragging || isLoading ? "bg-primary/20" : "group-hover:bg-primary/10"
                }`}
            >
              {isLoading ? (
                <Loader2 className="w-7 h-7 text-primary animate-spin" />
              ) : (
                <Upload
                  className={`w-7 h-7 transition-colors ${isDragging ? "text-primary" : "text-muted-foreground group-hover:text-primary"
                    }`}
                />
              )}
            </div>
          </div>
          <div>
            <p className="text-foreground font-medium text-lg">
              {convertProgress
                ? "Conversion de la vidéo..."
                : isLoading
                ? "Chargement de la vidéo..."
                : "Déposer une interview ici"}
            </p>
            <p className="text-muted-foreground text-sm mt-1">
              {convertProgress
                ? `${convertProgress.percent}% — Cette opération peut prendre quelques minutes`
                : "MP4, MOV, AVI, MTS • Automatiquement prêt pour l'IA"}
            </p>
          </div>

          {/* Barre de progression de conversion */}
          {convertProgress && convertProgress.percent > 0 && (
            <div className="w-full max-w-xs">
              <div className="h-2 bg-secondary/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${convertProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          {!isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Film className="w-3.5 h-3.5" />
              <span>ou parcourir vos fichiers</span>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default UploadZone;

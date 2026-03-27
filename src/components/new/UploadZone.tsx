/**
 * UPLOADZONE.TSX : Zone d'importation vidéo (drag & drop) — Version Web
 *
 * Utilise un <input type="file"> et l'upload HTTP multipart au lieu
 * des dialogues natifs Electron.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { Upload, Film, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "@/store/useStore";
import { api } from "@/api";

const UploadZone = () => {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [convertProgress, setConvertProgress] = useState<{ percent: number; message: string } | null>(null);
  const { addVideoFile, setProcessing } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Écouter la progression via WebSocket pendant l'upload/conversion
  useEffect(() => {
    if (!isLoading) return;
    const unsub = window.electron.onProgress(({ progress, message }) => {
      setConvertProgress({ percent: Math.round(progress), message });
    });
    return () => { unsub(); };
  }, [isLoading]);

  // Traite les fichiers uploadés via l'API web
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setIsLoading(true);
      setConvertProgress(null);
      try {
        const results = await api.uploadVideos(files);

        for (const fileInfo of results) {
          addVideoFile({
            path: fileInfo.path,
            originalPath: fileInfo.originalPath,
            name: fileInfo.name,
            duration: fileInfo.duration,
            size: fileInfo.size || 0,
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

  // Ouvre le sélecteur de fichier natif du navigateur
  const handleClick = () => {
    if (isLoading) return;
    fileInputRef.current?.click();
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFiles(files);
    }
    // Reset l'input pour pouvoir re-sélectionner le même fichier
    e.target.value = '';
  };

  // Drag & drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isLoading) return;

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const videoExtensions = ["mp4", "avi", "mov", "mkv", "mts", "webm"];
      const validFiles: File[] = [];

      for (let i = 0; i < files.length; i++) {
        const ext = files[i].name.split(".").pop()?.toLowerCase();
        if (ext && videoExtensions.includes(ext)) {
          validFiles.push(files[i]);
        }
      }

      if (validFiles.length > 0) {
        handleFiles(validFiles);
      }
    }
  };

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
      {/* Input fichier caché */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".mp4,.avi,.mov,.mkv,.mts,.webm"
        onChange={handleFileInput}
        className="hidden"
      />

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

/**
 * UPLOADZONE.TSX : Zone d'importation video (drag & drop + input file)
 * Version web : utilise <input type="file"> + upload multipart vers /api/upload
 */

import { useState, useCallback, useRef } from "react";
import { Upload, Film, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "@/store/useStore";
import api from "@/api";

const VIDEO_EXTENSIONS = ["mp4", "avi", "mov", "mkv", "mts", "webm"];

const UploadZone = () => {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const { addVideoFile, setProcessing, setAudioPaths } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      const valid = files.filter(f => {
        const ext = f.name.split(".").pop()?.toLowerCase();
        return ext && VIDEO_EXTENSIONS.includes(ext);
      });
      if (valid.length === 0) return;

      setIsLoading(true);
      setUploadProgress(0);
      try {
        const results = await api.uploadFiles(valid, (pct) => setUploadProgress(Math.round(pct * 100)));
        for (const r of results) {
          addVideoFile({
            path: r.path,
            name: r.name,
            duration: r.duration,
            size: r.size,
            id: r.id,
          } as any);
        }
        setProcessing("idle", 0, "");

        // Extraire l'audio en arrière-plan pour la waveform
        (async () => {
          try {
            const audioPaths: string[] = [];
            for (const r of results) {
              const audioPath = await api.extractAudio(r.path);
              audioPaths.push(audioPath);
            }
            setAudioPaths(audioPaths);
          } catch (err) {
            console.warn("Extraction audio waveform:", err);
          }
        })();
      } catch (error) {
        console.error("Erreur upload:", error);
        setProcessing("error", 0, "Erreur lors du chargement de la video");
      }
      setIsLoading(false);
      setUploadProgress(0);
    },
    [addVideoFile, setProcessing]
  );

  const handleClick = () => fileInputRef.current?.click();

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
      e.target.value = ""; // reset pour permettre re-selection du meme fichier
    }
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
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
              {isLoading
                ? uploadProgress > 0 ? `Chargement... ${uploadProgress}%` : "Chargement de la video..."
                : "Deposer une interview ici"}
            </p>
            {isLoading && uploadProgress > 0 && (
              <div className="w-48 mx-auto mt-2 bg-secondary rounded-full h-1.5">
                <div className="bg-primary h-1.5 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
              </div>
            )}
            <p className="text-muted-foreground text-sm mt-1">MP4, MOV, AVI — Automatiquement pret pour l'IA</p>
          </div>
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

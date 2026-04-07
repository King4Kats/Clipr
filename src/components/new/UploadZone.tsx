/**
 * UPLOADZONE.TSX : Zone d'importation de fichiers vidéo (drag & drop + sélection de fichiers)
 *
 * Ce composant est la première chose que l'utilisateur voit quand il ouvre l'application.
 * Il permet d'importer des fichiers vidéo de deux manières :
 * 1. En glissant-déposant des fichiers depuis l'explorateur (drag & drop)
 * 2. En cliquant sur la zone pour ouvrir le sélecteur de fichiers du navigateur
 *
 * Version web : utilise un <input type="file"> classique et envoie les fichiers
 * au serveur backend via un upload multipart HTTP (endpoint /api/upload).
 *
 * Après l'upload, le composant lance aussi l'extraction audio en arrière-plan
 * pour préparer l'affichage de la forme d'onde (waveform) dans la timeline.
 *
 * Formats vidéo acceptés : MP4, AVI, MOV, MKV, MTS, WebM
 */

// useState : pour gérer les états locaux (drag en cours, chargement, progression)
// useCallback : pour mémoriser la fonction handleFiles et éviter des re-rendus inutiles
// useRef : pour garder une référence vers l'input file caché
import { useState, useCallback, useRef } from "react";

// Icônes : Upload (flèche vers le haut), Film (pellicule), Loader2 (spinner de chargement)
import { Upload, Film, Loader2 } from "lucide-react";

// Framer Motion : utilisé pour l'animation d'entrée de la zone
import { motion } from "framer-motion";

// Store global Zustand : pour enregistrer les fichiers vidéo dans l'état de l'application
import { useStore } from "@/store/useStore";

// Module API : contient les fonctions pour communiquer avec le serveur backend
import api from "@/api";

/**
 * Liste des extensions de fichiers vidéo acceptées.
 * Utilisée pour filtrer les fichiers que l'utilisateur dépose ou sélectionne.
 */
const VIDEO_EXTENSIONS = ["mp4", "avi", "mov", "mkv", "mts", "webm"];

/**
 * Composant UploadZone : zone interactive d'importation de vidéos.
 * Gère le drag & drop, le clic pour ouvrir le sélecteur de fichiers,
 * l'upload vers le serveur et l'extraction audio en arrière-plan.
 */
const UploadZone = () => {
  // isDragging : vrai quand l'utilisateur survole la zone avec un fichier (effet visuel)
  const [isDragging, setIsDragging] = useState(false);

  // isLoading : vrai pendant que les fichiers sont en cours d'upload vers le serveur
  const [isLoading, setIsLoading] = useState(false);

  // uploadProgress : pourcentage d'avancement de l'upload (0 à 100)
  const [uploadProgress, setUploadProgress] = useState(0);

  // Fonctions du store global :
  // addVideoFile : ajoute un fichier vidéo à la liste dans le store
  // setProcessing : met à jour l'étape de traitement (ex: "idle", "error")
  // setAudioPaths : enregistre les chemins des fichiers audio extraits (pour la waveform)
  const { addVideoFile, setProcessing, setAudioPaths } = useStore();

  // Référence vers l'élément <input type="file"> caché (invisible à l'écran)
  // On l'utilise pour déclencher le sélecteur de fichiers quand l'utilisateur clique
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Fonction principale de traitement des fichiers.
   * Appelée après un drop ou une sélection de fichiers.
   *
   * 1. Filtre les fichiers pour ne garder que les formats vidéo acceptés
   * 2. Envoie les fichiers au serveur via l'API (upload multipart)
   * 3. Enregistre chaque fichier dans le store global
   * 4. Lance l'extraction audio en arrière-plan pour la waveform
   *
   * @param files - Tableau de fichiers File sélectionnés par l'utilisateur
   */
  const handleFiles = useCallback(
    async (files: File[]) => {
      // Filtrage : on ne garde que les fichiers dont l'extension est dans VIDEO_EXTENSIONS
      const valid = files.filter(f => {
        const ext = f.name.split(".").pop()?.toLowerCase();
        return ext && VIDEO_EXTENSIONS.includes(ext);
      });

      // Si aucun fichier valide, on ne fait rien
      if (valid.length === 0) return;

      // Début du chargement : on affiche le spinner et la barre de progression
      setIsLoading(true);
      setUploadProgress(0);

      try {
        // Upload des fichiers vers le serveur.
        // Le second argument est un callback de progression appelé régulièrement
        // avec un pourcentage entre 0 et 1 (qu'on convertit en 0-100).
        const results = await api.uploadFiles(valid, (pct) => setUploadProgress(Math.round(pct * 100)));

        // Pour chaque fichier uploadé avec succès, on l'ajoute au store global
        for (const r of results) {
          addVideoFile({
            path: r.path,       // Chemin du fichier sur le serveur
            name: r.name,       // Nom original du fichier
            duration: r.duration, // Durée de la vidéo en secondes
            size: r.size,       // Taille du fichier en octets
            id: r.id,           // Identifiant unique généré par le serveur
          } as any);
        }

        // Remet l'état de traitement à "idle" (en attente)
        setProcessing("idle", 0, "");

        // --- Extraction audio en arrière-plan (pour la waveform) ---
        // On utilise une IIFE (Immediately Invoked Function Expression) async
        // pour ne pas bloquer le flux principal. L'extraction audio peut prendre
        // du temps mais n'empêche pas l'utilisateur de continuer à utiliser l'app.
        (async () => {
          try {
            const audioPaths: string[] = [];
            for (const r of results) {
              // Demande au serveur d'extraire la piste audio du fichier vidéo
              const audioPath = await api.extractAudio(r.path);
              audioPaths.push(audioPath);
            }
            // Enregistre les chemins audio dans le store pour que la timeline
            // puisse afficher la waveform
            setAudioPaths(audioPaths);
          } catch (err) {
            // En cas d'erreur, on affiche juste un avertissement dans la console
            // (ce n'est pas bloquant, la waveform ne s'affichera simplement pas)
            console.warn("Extraction audio waveform:", err);
          }
        })();
      } catch (error) {
        // En cas d'erreur d'upload, on affiche un message d'erreur
        console.error("Erreur upload:", error);
        setProcessing("error", 0, "Erreur lors du chargement de la video");
      }

      // Fin du chargement : on remet les indicateurs à zéro
      setIsLoading(false);
      setUploadProgress(0);
    },
    [addVideoFile, setProcessing] // Dépendances du useCallback
  );

  /**
   * Ouvre le sélecteur de fichiers natif du navigateur
   * en simulant un clic sur l'input file caché.
   */
  const handleClick = () => fileInputRef.current?.click();

  /**
   * Callback appelé quand l'utilisateur sélectionne des fichiers via le sélecteur natif.
   * Récupère les fichiers depuis l'événement et les passe à handleFiles.
   * On remet la valeur de l'input à "" pour permettre de re-sélectionner le même fichier.
   */
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
      e.target.value = ""; // Reset pour permettre la re-sélection du même fichier
    }
  };

  // --- Gestionnaires d'événements drag & drop ---

  /**
   * handleDragOver : appelé quand un fichier est survolé au-dessus de la zone.
   * preventDefault() est obligatoire pour que le drop fonctionne.
   * On active l'effet visuel de survol (isDragging = true).
   */
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };

  /**
   * handleDragLeave : appelé quand le fichier quitte la zone.
   * On désactive l'effet visuel de survol.
   */
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };

  /**
   * handleDrop : appelé quand l'utilisateur lâche les fichiers sur la zone.
   * Récupère les fichiers depuis l'événement de drop et les traite.
   */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  // --- Rendu JSX ---
  return (
    // Animation d'entrée : la zone apparaît avec un fondu et un glissement vers le haut
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="relative group cursor-pointer"
      onClick={handleClick}         // Clic : ouvre le sélecteur de fichiers
      onDragOver={handleDragOver}   // Survol avec fichier : active l'effet visuel
      onDragLeave={handleDragLeave} // Sortie de la zone : désactive l'effet visuel
      onDrop={handleDrop}           // Lâcher du fichier : lance l'upload
    >
      {/* Input file caché : invisible mais fonctionnel.
          accept : filtre les types de fichiers dans le sélecteur natif
          multiple : permet de sélectionner plusieurs fichiers à la fois */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".mp4,.avi,.mov,.mkv,.mts,.webm"
        onChange={handleFileInput}
        className="hidden"
      />

      {/* Zone visuelle avec bordure en pointillés */}
      {/* Les classes changent dynamiquement selon l'état (isDragging, isLoading) */}
      <div
        className={`border-2 border-dashed rounded-lg p-10 text-center transition-all duration-300 bg-card/50 ${isDragging
          ? "border-primary glow bg-primary/5 scale-[1.02]"   // Effet de surbrillance quand on survole avec un fichier
          : "border-border hover:border-primary hover:glow"     // État normal avec effet au survol de la souris
        }`}
      >
        <div className="flex flex-col items-center gap-4">
          {/* Icône centrale : spinner de chargement ou flèche d'upload */}
          <div className="relative">
            <div
              className={`w-16 h-16 rounded-full bg-secondary flex items-center justify-center transition-colors ${isDragging || isLoading ? "bg-primary/20" : "group-hover:bg-primary/10"
              }`}
            >
              {isLoading ? (
                // Pendant le chargement : spinner animé
                <Loader2 className="w-7 h-7 text-primary animate-spin" />
              ) : (
                // En attente : icône de téléversement
                <Upload
                  className={`w-7 h-7 transition-colors ${isDragging ? "text-primary" : "text-muted-foreground group-hover:text-primary"
                  }`}
                />
              )}
            </div>
          </div>

          {/* Texte principal : change selon l'état de chargement */}
          <div>
            <p className="text-foreground font-medium text-lg">
              {isLoading
                ? uploadProgress > 0 ? `Chargement... ${uploadProgress}%` : "Chargement de la video..."
                : "Deposer une interview ici"}
            </p>

            {/* Barre de progression de l'upload (visible uniquement pendant le chargement) */}
            {isLoading && uploadProgress > 0 && (
              <div className="w-48 mx-auto mt-2 bg-secondary rounded-full h-1.5">
                <div className="bg-primary h-1.5 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
              </div>
            )}

            {/* Texte secondaire : formats acceptés */}
            <p className="text-muted-foreground text-sm mt-1">MP4, MOV, AVI — Automatiquement pret pour l'IA</p>
          </div>

          {/* Texte d'aide : "ou parcourir vos fichiers" (masqué pendant le chargement) */}
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

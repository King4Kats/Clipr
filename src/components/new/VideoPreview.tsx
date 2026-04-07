/**
 * VIDEOPREVIEW.TSX : Lecteur vidéo avec prévisualisation de segment
 *
 * Ce composant est le lecteur vidéo principal de l'éditeur. Il fonctionne
 * en deux modes distincts :
 *
 * 1. MODE COMPLET (pas de segment sélectionné) :
 *    L'utilisateur peut lire la vidéo entière librement, comme un lecteur classique.
 *
 * 2. MODE SEGMENT / FRAGMENT (un segment est sélectionné) :
 *    La lecture est contrainte entre les bornes "start" et "end" du segment.
 *    Le lecteur se positionne automatiquement au début du segment et s'arrête
 *    à la fin. C'est utile pour prévisualiser un chapitre découpé par l'IA.
 *
 * Le composant gère aussi :
 * - La synchronisation avec la timeline (sélection d'un segment = le lecteur saute dessus)
 * - Le renommage des segments directement depuis la barre d'en-tête
 * - Les contrôles de lecture (play/pause) et de volume
 * - L'affichage du timecode (temps actuel / durée)
 */

// useRef : pour accéder directement à l'élément <video> du DOM
// useEffect : pour synchroniser le lecteur avec l'état global
// useState : pour l'état local (temps courant, volume, mode édition du nom)
import { useRef, useEffect, useState } from "react";

// Store global Zustand contenant l'état de l'application
import { useStore } from "@/store/useStore";

// Module API pour construire les URLs de streaming vidéo
import api from "@/api";

// Icônes utilisées dans le lecteur
// Play/Pause : boutons de lecture
// Volume2 : icône de volume
// Edit2 : crayon pour le renommage
// Check : validation du renommage
// GripHorizontal : poignée de drag (pour déplacer le panneau dans la grille)
import { Play, Pause, Volume2, Edit2, Check, GripHorizontal } from "lucide-react";

// Composants du design system shadcn/ui
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";  // Curseur de volume
import { Input } from "@/components/ui/input";    // Champ texte pour le renommage

/**
 * Formate un nombre de secondes en chaîne de temps lisible.
 * Exemples :
 * - 65 secondes  -> "1:05"
 * - 3661 secondes -> "1:01:01"
 * - 0 secondes    -> "0:00"
 *
 * @param seconds - Le temps en secondes à formater
 * @returns La chaîne formatée (H:MM:SS ou M:SS)
 */
function formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const h = Math.floor(seconds / 3600);           // Heures
    const m = Math.floor((seconds % 3600) / 60);    // Minutes
    const s = Math.floor(seconds % 60);              // Secondes
    // Si plus d'une heure, on affiche le format H:MM:SS, sinon M:SS
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Composant VideoPreview : lecteur vidéo intelligent avec support des segments.
 * S'affiche dans un panneau redimensionnable de la grille de l'éditeur.
 */
const VideoPreview = () => {
    // --- État local ---
    // videoRef : référence directe vers l'élément HTML <video> pour le contrôler
    const videoRef = useRef<HTMLVideoElement>(null);

    // currentTime : position de lecture actuelle en secondes (mise à jour en continu)
    const [currentTime, setCurrentTime] = useState(0);

    // volume : niveau sonore entre 0 (muet) et 1 (maximum)
    const [volume, setVolume] = useState(1);

    // isEditingName : vrai quand l'utilisateur renomme le segment dans la barre d'en-tête
    const [isEditingName, setIsEditingName] = useState(false);

    // tempName : nom temporaire saisi par l'utilisateur pendant le renommage
    const [tempName, setTempName] = useState("");

    // --- État global depuis le store Zustand ---
    // videoFiles : tous les fichiers vidéo importés
    // currentVideoIndex : index du fichier vidéo actuellement affiché
    // segments : liste des segments découpés par l'IA
    // selectedSegmentId : ID du segment sélectionné dans la timeline (ou null)
    // getVideoAtTime : fonction qui trouve quel fichier vidéo contient un temps donné
    //   (utile quand on a plusieurs vidéos concaténées)
    // updateSegment : pour modifier les propriétés d'un segment (titre, bornes, etc.)
    // isPlaying : état global de lecture (play/pause), partagé avec la timeline
    // setIsPlaying : pour changer l'état de lecture depuis n'importe quel composant
    const {
        videoFiles,
        currentVideoIndex,
        segments,
        selectedSegmentId,
        getVideoAtTime,
        updateSegment,
        isPlaying,
        setIsPlaying
    } = useStore();

    // --- Données dérivées ---

    // Fichier vidéo actuellement affiché (peut être null si pas de vidéo chargée)
    const videoFile = videoFiles[currentVideoIndex] || null;

    // Segment actuellement sélectionné dans la timeline (null si aucun)
    const selectedSegment = segments.find(s => s.id === selectedSegmentId) || null;

    // Information sur le fichier vidéo qui contient le début du segment sélectionné.
    // Inclut un "offset" (décalage) car si on a plusieurs vidéos bout à bout,
    // le temps global n'est pas le même que le temps local dans le fichier.
    const videoInfo = selectedSegment ? getVideoAtTime(selectedSegment.start) : null;

    // isFragmentMode : vrai quand un segment est sélectionné
    // En mode fragment, la lecture est limitée aux bornes du segment
    const isFragmentMode = !!selectedSegment;

    // Offset global : décalage en secondes du début du fichier vidéo par rapport
    // au temps global de la timeline (0 si un seul fichier vidéo)
    const globalOffset = videoInfo?.video.offset || 0;

    // Calcul des bornes locales du segment dans le fichier vidéo.
    // On soustrait l'offset global car l'élément <video> utilise des temps locaux.
    // Exemple : si le segment va de 120s à 180s dans la timeline globale,
    // mais que le fichier vidéo commence à 100s d'offset, alors les bornes
    // locales sont 20s à 80s.
    const segmentStartLocal = isFragmentMode ? (selectedSegment!.start - globalOffset) : 0;
    const segmentEndLocal = isFragmentMode ? (selectedSegment!.end - globalOffset) : (videoFile?.duration || 0);

    // Temps et durée affichés dans le timecode.
    // En mode fragment : on affiche le temps relatif au début du segment (commence à 0:00)
    // En mode complet : on affiche le temps absolu dans la vidéo
    const displayTime = isFragmentMode ? Math.max(0, currentTime - segmentStartLocal) : currentTime;
    const displayDuration = isFragmentMode ? (selectedSegment!.end - selectedSegment!.start) : (videoFile?.duration || 0);

    /**
     * Effet : quand le segment sélectionné change, on met à jour le nom temporaire
     * et on quitte le mode édition du nom.
     */
    useEffect(() => {
        if (selectedSegment) {
            setTempName(selectedSegment.title);
            setIsEditingName(false);
        }
    }, [selectedSegmentId]);

    /**
     * Effet : écoute l'événement "timeupdate" de l'élément <video>.
     * Cet événement est déclenché régulièrement pendant la lecture (~4 fois/seconde).
     *
     * Deux rôles :
     * 1. Met à jour le temps courant affiché dans l'interface
     * 2. En mode fragment : arrête la lecture quand on atteint la fin du segment
     *    (avec une tolérance de 0.05s pour éviter un léger dépassement)
     */
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            // En mode fragment : on stoppe la lecture quand on atteint la fin du segment
            if (isFragmentMode && video.currentTime >= segmentEndLocal - 0.05) {
                video.pause();
                video.currentTime = segmentEndLocal;
                setIsPlaying(false);
            }
        };

        // Synchronisation de l'état isPlaying quand l'utilisateur utilise
        // les contrôles natifs du navigateur
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);

        video.addEventListener("timeupdate", handleTimeUpdate);
        video.addEventListener("play", handlePlay);
        video.addEventListener("pause", handlePause);

        // Nettoyage : on retire les listeners quand le composant est démonté
        return () => {
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("play", handlePlay);
            video.removeEventListener("pause", handlePause);
        };
    }, [isFragmentMode, segmentEndLocal, videoFile?.path, setIsPlaying]);

    /**
     * Effet : vérifie la cohérence entre la durée détectée par le navigateur
     * et celle stockée dans le store. Si elles divergent de plus d'1 seconde,
     * un avertissement est loggé dans la console (utile pour le debug).
     */
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !videoFile) return;

        const syncDuration = () => {
            if (video.duration && Math.abs(video.duration - videoFile.duration) > 1) {
                console.warn(`[VideoPreview] Durée divergente: Browser: ${video.duration.toFixed(2)}, Store: ${videoFile.duration.toFixed(2)}`);
            }
        };
        video.addEventListener("loadedmetadata", syncDuration);
        return () => video.removeEventListener("loadedmetadata", syncDuration);
    }, [videoFile?.path, videoFile?.duration]);

    /**
     * Effet principal de synchronisation du lecteur vidéo.
     * C'est le coeur du mécanisme qui fait fonctionner le mode fragment.
     *
     * Quand le segment sélectionné change ou que l'état play/pause change :
     * 1. En mode fragment : on saute au début du segment si nécessaire (seek)
     * 2. On synchronise l'état play/pause entre le store et l'élément <video>
     *
     * La variable isSyncing empêche les conflits entre le seek et le play :
     * on attend que le seek soit terminé (événement "seeked") avant de lancer la lecture.
     */
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !videoFile) return;

        // Flag pour éviter de jouer pendant un seek en cours
        let isSyncing = false;

        const syncPlayer = async () => {
            if (isFragmentMode) {
                // Calcule la distance entre la position actuelle et le début du segment
                const diff = Math.abs(video.currentTime - segmentStartLocal);
                // On saute au début du segment si on en est loin (> 0.5s) ou si on est à 0
                const shouldJump = diff > 0.5 || video.currentTime === 0;

                if (shouldJump) {
                    isSyncing = true;
                    // On met en pause avant de seek pour éviter les glitchs
                    if (!video.paused) video.pause();

                    // Positionne le lecteur au début du segment
                    video.currentTime = segmentStartLocal;
                    setCurrentTime(segmentStartLocal);

                    // Quand le seek est terminé, on relance la lecture si nécessaire
                    const onSeeked = async () => {
                        video.removeEventListener("seeked", onSeeked);
                        isSyncing = false;

                        if (isPlaying && video.paused) {
                            try { await video.play(); } catch { /* autoplay bloqué par le navigateur */ }
                        }
                    };
                    video.addEventListener("seeked", onSeeked);
                    return;
                }
            }

            // Synchronisation play/pause (hors seek)
            if (!isSyncing) {
                if (isPlaying && video.paused) {
                    video.play().catch(() => { });
                } else if (!isPlaying && !video.paused) {
                    video.pause();
                }
            }
        };

        // Si les métadonnées sont déjà chargées (readyState >= 1), on synchronise immédiatement
        if (video.readyState >= 1) {
            syncPlayer();
        } else {
            // Sinon, on attend que les métadonnées soient disponibles
            const onReady = () => {
                video.removeEventListener("loadedmetadata", onReady);
                syncPlayer();
            };
            video.addEventListener("loadedmetadata", onReady);
        }

        // Nettoyage des listeners (formes simplifiées)
        return () => {
            video.removeEventListener("loadedmetadata", () => { });
            video.removeEventListener("seeked", () => { });
        };
    }, [selectedSegmentId, isPlaying, segmentStartLocal, videoFile?.path]);

    // --- Gestionnaires d'événements ---

    /** Bascule entre lecture et pause */
    const togglePlay = () => setIsPlaying(!isPlaying);

    /**
     * Valide le renommage du segment.
     * Met à jour le titre dans le store si le nom n'est pas vide.
     */
    const handleRename = () => {
        if (selectedSegment && tempName.trim()) {
            updateSegment(selectedSegment.id, { title: tempName.trim() });
            setIsEditingName(false);
        }
    };

    // Si aucune vidéo n'est chargée, on ne rend rien
    if (!videoFile) return null;

    // --- Rendu JSX ---
    return (
        <div className="bg-card rounded-xl border border-border overflow-hidden shadow-lg flex flex-col h-full">

            {/* ===== BARRE D'EN-TÊTE : poignée de drag, nom du segment, timecode ===== */}
            {/* panel-drag-handle : classe CSS utilisée par react-grid-layout pour le drag */}
            <div className="panel-drag-handle px-3 py-1.5 bg-secondary/30 border-b border-border flex items-center justify-between cursor-grab active:cursor-grabbing">
                <div className="flex items-center gap-2 overflow-hidden mr-3 min-w-0">
                    {/* Icône de poignée de drag (6 petits points horizontaux) */}
                    <GripHorizontal className="w-3 h-3 text-muted-foreground/40 shrink-0" />

                    {/* Pastille de couleur : utilise la couleur du segment sélectionné
                        ou la couleur primaire si on est en mode complet */}
                    <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: isFragmentMode ? (selectedSegment?.color || 'hsl(var(--primary))') : 'hsl(var(--primary))' }}
                    />

                    {/* Zone du nom : mode édition ou mode lecture */}
                    {isEditingName ? (
                        // Mode édition : champ texte + bouton de validation
                        <div className="flex items-center gap-1.5 min-w-0">
                            <Input
                                value={tempName}
                                onChange={(e) => setTempName(e.target.value)}
                                className="h-6 text-xs font-bold py-0 w-48 bg-background"
                                autoFocus
                                onKeyDown={(e) => e.key === "Enter" && handleRename()}
                                onBlur={handleRename} // Valide aussi quand on clique ailleurs
                            />
                            <Button size="icon" variant="ghost" className="h-6 w-6 text-primary" onClick={handleRename}>
                                <Check className="w-3 h-3" />
                            </Button>
                        </div>
                    ) : (
                        // Mode lecture : affiche le nom du segment ou de la vidéo
                        // Le clic sur le nom active le mode édition (seulement en mode fragment)
                        <h2
                            className="text-xs font-bold truncate cursor-pointer hover:text-primary transition-colors flex items-center gap-1.5 group"
                            onClick={() => isFragmentMode && setIsEditingName(true)}
                        >
                            {isFragmentMode ? selectedSegment.title : videoFile.name}
                            {/* Icône crayon visible au survol en mode fragment */}
                            {isFragmentMode && <Edit2 className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100" />}
                        </h2>
                    )}
                </div>

                {/* Timecode : affiche "temps actuel / durée totale" */}
                <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-mono font-bold text-primary">
                        {formatTime(displayTime)} / {formatTime(displayDuration)}
                    </span>
                </div>
            </div>

            {/* ===== ZONE VIDÉO : élément <video> avec overlay de lecture ===== */}
            {/* flex-1 min-h-0 : prend tout l'espace vertical disponible */}
            <div className="relative flex-1 min-h-0 bg-black group/video overflow-hidden">
                {/* Élément vidéo HTML natif.
                    key={videoFile.path} : force React à recréer l'élément quand on change de fichier.
                    src : URL de streaming construite par l'API.
                    playsInline : empêche le passage en plein écran automatique sur mobile */}
                <video
                    key={videoFile.path}
                    ref={videoRef}
                    src={api.getVideoUrl(videoFile.id || videoFile.path.split('/').pop() || '')}
                    className="w-full h-full object-contain cursor-pointer"
                    onClick={togglePlay}
                    playsInline
                />

                {/* Overlay avec gros bouton play : visible au survol quand la vidéo est en pause.
                    pointer-events-none : le clic passe à travers vers la vidéo en dessous */}
                {!isPlaying && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover/video:opacity-100 transition-all duration-200">
                        <div className="w-14 h-14 rounded-full bg-primary/80 flex items-center justify-center shadow-lg">
                            <Play className="w-6 h-6 text-white ml-1 fill-white" />
                        </div>
                    </div>
                )}
            </div>

            {/* ===== BARRE DE CONTRÔLES : play/pause et volume ===== */}
            <div className="flex items-center justify-between px-3 py-2 bg-secondary/10 border-t border-border">
                {/* Bouton play/pause */}
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={togglePlay}>
                        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                    </Button>
                </div>

                {/* Contrôle du volume : icône + curseur (slider) */}
                <div className="flex items-center gap-2">
                    <Volume2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <Slider
                        value={[volume * 100]}  // Le slider travaille en 0-100
                        max={100}
                        onValueChange={v => {
                            // Convertit la valeur 0-100 en 0-1 pour l'API audio
                            setVolume(v[0] / 100);
                            if (videoRef.current) videoRef.current.volume = v[0] / 100;
                        }}
                        className="w-20"
                    />
                </div>
            </div>
        </div>
    );
};

export default VideoPreview;

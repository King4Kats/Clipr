/**
 * VIDEOPREVIEW.TSX : Lecteur vidéo avec prévisualisation de segment
 *
 * Composant de lecture vidéo intelligent qui fonctionne en deux modes :
 * - Mode complet : lecture libre de la vidéo entière
 * - Mode segment : lecture contrainte entre les bornes start/end du segment sélectionné
 * Gère la synchronisation avec la timeline, le renommage des segments et les contrôles.
 */

import { useRef, useEffect, useState } from "react";
import { useStore } from "@/store/useStore";
import { Play, Pause, Volume2, Edit2, Check, GripHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";

// Formate un nombre de secondes en chaîne lisible (H:MM:SS ou M:SS)
function formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

const VideoPreview = () => {
    // --- Etat local : lecture, volume, édition du nom ---
    const videoRef = useRef<HTMLVideoElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isEditingName, setIsEditingName] = useState(false);
    const [tempName, setTempName] = useState("");

    // --- Etat global depuis le store ---
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

    // Données dérivées : fichier vidéo courant, segment sélectionné, mode de lecture
    const videoFile = videoFiles[currentVideoIndex] || null;
    const selectedSegment = segments.find(s => s.id === selectedSegmentId) || null;
    const videoInfo = selectedSegment ? getVideoAtTime(selectedSegment.start) : null;

    // Mode fragment : lecture contrainte entre les bornes du segment
    const isFragmentMode = !!selectedSegment;
    const globalOffset = videoInfo?.video.offset || 0;

    // Calcul des bornes locales du segment dans le fichier vidéo
    const segmentStartLocal = isFragmentMode ? (selectedSegment!.start - globalOffset) : 0;
    const segmentEndLocal = isFragmentMode ? (selectedSegment!.end - globalOffset) : (videoFile?.duration || 0);

    // Temps et durée affichés (relatifs au segment en mode fragment)
    const displayTime = isFragmentMode ? Math.max(0, currentTime - segmentStartLocal) : currentTime;
    const displayDuration = isFragmentMode ? (selectedSegment!.end - selectedSegment!.start) : (videoFile?.duration || 0);

    // --- Effet : synchronise le nom temporaire quand le segment sélectionné change ---
    useEffect(() => {
        if (selectedSegment) {
            setTempName(selectedSegment.title);
            setIsEditingName(false);
        }
    }, [selectedSegmentId]);

    // --- Effet : écoute timeUpdate pour mettre à jour le curseur et stopper en fin de segment ---
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            if (isFragmentMode && video.currentTime >= segmentEndLocal - 0.05) {
                video.pause();
                video.currentTime = segmentEndLocal;
                setIsPlaying(false);
            }
        };
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);

        video.addEventListener("timeupdate", handleTimeUpdate);
        video.addEventListener("play", handlePlay);
        video.addEventListener("pause", handlePause);

        return () => {
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("play", handlePlay);
            video.removeEventListener("pause", handlePause);
        };
    }, [isFragmentMode, segmentEndLocal, videoFile?.path, setIsPlaying]);

    // --- Effet : vérifie la cohérence de durée entre le navigateur et le store ---
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

    // --- Effet : synchronise le lecteur vidéo avec le segment sélectionné et l'état play/pause ---
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !videoFile) return;

        let cancelled = false;

        const syncPlayer = async () => {
            if (cancelled) return;

            if (isFragmentMode) {
                const diff = Math.abs(video.currentTime - segmentStartLocal);
                const shouldJump = diff > 0.5 || video.currentTime === 0;

                if (shouldJump) {
                    if (!video.paused) video.pause();
                    video.currentTime = segmentStartLocal;
                    setCurrentTime(segmentStartLocal);

                    // Attendre le seek puis jouer si besoin
                    await new Promise<void>(resolve => {
                        const onSeeked = () => {
                            video.removeEventListener("seeked", onSeeked);
                            resolve();
                        };
                        video.addEventListener("seeked", onSeeked);
                    });

                    if (cancelled) return;
                    if (isPlaying && video.paused) {
                        try { await video.play(); } catch { /* autoplay blocked */ }
                    }
                    return;
                }
            }

            if (isPlaying && video.paused) {
                video.play().catch(() => { });
            } else if (!isPlaying && !video.paused) {
                video.pause();
            }
        };

        if (video.readyState >= 1) {
            syncPlayer();
        } else {
            const onReady = () => {
                video.removeEventListener("loadedmetadata", onReady);
                syncPlayer();
            };
            video.addEventListener("loadedmetadata", onReady);
        }

        return () => {
            cancelled = true;
        };
    }, [selectedSegmentId, isPlaying, segmentStartLocal, videoFile?.path]);

    // --- Gestionnaires ---
    // Bascule lecture / pause
    const togglePlay = () => setIsPlaying(!isPlaying);

    // Valide le renommage du segment et met à jour le store
    const handleRename = () => {
        if (selectedSegment && tempName.trim()) {
            updateSegment(selectedSegment.id, { title: tempName.trim() });
            setIsEditingName(false);
        }
    };

    if (!videoFile) return null;

    // --- Rendu JSX ---
    return (
        <div className="bg-card rounded-xl border border-border overflow-hidden shadow-lg flex flex-col h-full">
            {/* Barre d'en-tête : poignée de drag, nom du segment/vidéo, timecode */}
            <div className="panel-drag-handle px-3 py-1.5 bg-secondary/30 border-b border-border flex items-center justify-between cursor-grab active:cursor-grabbing">
                <div className="flex items-center gap-2 overflow-hidden mr-3 min-w-0">
                    <GripHorizontal className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                    <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: isFragmentMode ? (selectedSegment?.color || 'hsl(var(--primary))') : 'hsl(var(--primary))' }}
                    />
                    {isEditingName ? (
                        <div className="flex items-center gap-1.5 min-w-0">
                            <Input
                                value={tempName}
                                onChange={(e) => setTempName(e.target.value)}
                                className="h-6 text-xs font-bold py-0 w-48 bg-background"
                                autoFocus
                                onKeyDown={(e) => e.key === "Enter" && handleRename()}
                                onBlur={handleRename}
                            />
                            <Button size="icon" variant="ghost" className="h-6 w-6 text-primary" onClick={handleRename}>
                                <Check className="w-3 h-3" />
                            </Button>
                        </div>
                    ) : (
                        <h2
                            className="text-xs font-bold truncate cursor-pointer hover:text-primary transition-colors flex items-center gap-1.5 group"
                            onClick={() => isFragmentMode && setIsEditingName(true)}
                        >
                            {isFragmentMode ? selectedSegment.title : videoFile.name}
                            {isFragmentMode && <Edit2 className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100" />}
                        </h2>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-mono font-bold text-primary">
                        {formatTime(displayTime)} / {formatTime(displayDuration)}
                    </span>
                </div>
            </div>

            {/* Zone vidéo : élément <video> avec overlay play au hover */}
            <div className="relative flex-1 min-h-0 bg-black group/video overflow-hidden">
                <video
                    key={videoFile.path}
                    ref={videoRef}
                    src={`local-video:///${videoFile.path.replace(/\\/g, '/')}`}
                    className="w-full h-full object-contain cursor-pointer"
                    onClick={togglePlay}
                    onError={(e) => console.error('[VideoPreview] Erreur lecture vidéo:', (e.target as HTMLVideoElement).error)}
                    playsInline
                />
                {!isPlaying && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover/video:opacity-100 transition-all duration-200">
                        <div className="w-14 h-14 rounded-full bg-primary/80 flex items-center justify-center shadow-lg">
                            <Play className="w-6 h-6 text-white ml-1 fill-white" />
                        </div>
                    </div>
                )}
            </div>

            {/* Barre de contrôles : play/pause et volume */}
            <div className="flex items-center justify-between px-3 py-2 bg-secondary/10 border-t border-border">
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={togglePlay}>
                        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                    </Button>
                </div>
                <div className="flex items-center gap-2">
                    <Volume2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <Slider
                        value={[volume * 100]}
                        max={100}
                        onValueChange={v => {
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

/**
 * TIMELINE.TSX : Liste des segments avec gestion et export
 *
 * Panneau latéral affichant la liste ordonnée des segments thématiques.
 * Permet de sélectionner, renommer, réordonner (drag & drop), supprimer
 * et ajouter des segments. Intègre aussi les fonctions d'export :
 * - Export vidéo (découpe FFmpeg par segment)
 * - Export TXT avec timecodes
 * - Export TXT propre (transcription brute)
 */

import { useState, useRef, useEffect } from "react";
import { motion, Reorder } from "framer-motion";
import { Scissors, Play, Trash2, Plus, Pause, FileText, Film, ChevronDown, GripVertical, GripHorizontal } from "lucide-react";
import { useStore } from "@/store/useStore";
import { Button } from "@/components/ui/button";

// Formate un nombre de secondes en chaîne lisible (H:MM:SS ou M:SS)
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const Timeline = () => {
  // --- Etat global depuis le store ---
  const {
    segments,
    selectedSegmentId,
    setSelectedSegmentId,
    videoFiles,
    removeSegment,
    addSegment,
    getTotalDuration,
    isPlaying,
    setIsPlaying,
    updateSegment,
    getClipsForSegment,
    setProcessing,
    transcript,
    setSegments
  } = useStore();

  // --- Etat local : export et menu déroulant ---
  const [isExporting, setIsExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const totalDuration = getTotalDuration();

  // --- Effet : ferme le menu d'export au clic en dehors ---
  useEffect(() => {
    if (!showExportMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showExportMenu]);

  // Ajoute un nouveau segment par défaut (30s après le dernier segment)
  const handleAddDefault = () => {
    if (videoFiles.length === 0) return;
    const lastEnd = segments.length > 0 ? Math.max(...segments.map((s) => s.end)) : 0;
    if (lastEnd >= totalDuration) return;

    addSegment({
      id: crypto.randomUUID(),
      title: `Séquence ${segments.length + 1}`,
      start: lastEnd,
      end: Math.min(lastEnd + 30, totalDuration),
      color: "",
      transcriptSegments: [],
    });
  };

  // Exporte chaque segment en fichier vidéo MP4 via FFmpeg
  const handleExportVideo = async () => {
    if (segments.length === 0 || videoFiles.length === 0) return;

    const outputFolder = await window.electron.selectFolderDialog();
    if (!outputFolder) return;

    setIsExporting(true);
    setShowExportMenu(false);
    setProcessing('exporting', 0, 'Démarrage de l\'export...');

    try {
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const safeTitle = segment.title
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9\s-]/g, '')
          .replace(/\s+/g, '_')
          .substring(0, 50);

        const sep = navigator.platform.includes('Win') ? '\\' : '/';
        const outputPath = `${outputFolder}${sep}${String(i + 1).padStart(2, '0')}_${safeTitle}.mp4`;

        setProcessing(
          'exporting',
          ((i / segments.length) * 100),
          `Export ${i + 1}/${segments.length}: ${segment.title}`
        );

        const clips = getClipsForSegment(segment.start, segment.end);
        if (clips.length === 0) continue;

        if (clips.length === 1) {
          await window.electron.cutVideo(clips[0].videoPath, clips[0].start, clips[0].end, outputPath);
        } else {
          const tempDir = await window.electron.getAppPath('temp');
          const tempFiles: string[] = [];

          for (let j = 0; j < clips.length; j++) {
            const clip = clips[j];
            const tempPath = `${tempDir}${sep}decoupeur-video${sep}temp_clip_${i}_${j}_${Date.now()}.mp4`;
            tempFiles.push(tempPath);
            await window.electron.cutVideo(clip.videoPath, clip.start, clip.end, tempPath);
          }

          await window.electron.concatenateVideos(tempFiles, outputPath);
        }
      }

      setProcessing('done', 100, 'Export terminé !');
      await window.electron.openFolder(outputFolder);
    } catch (error: any) {
      console.error('Export error:', error);
      setProcessing('error', 0, `Erreur lors de l'export: ${error.message || error}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Exporte les séquences en fichier TXT avec timecodes et transcription
  const handleExportTxtSequences = async () => {
    if (segments.length === 0) return;
    setShowExportMenu(false);

    let content = '='.repeat(60) + '\n';
    content += 'SÉQUENCES AVEC TIMECODES\n';
    content += '='.repeat(60) + '\n\n';

    segments.forEach((segment, index) => {
      content += `[${String(index + 1).padStart(2, '0')}] ${segment.title}\n`;
      content += `     Début: ${formatTime(segment.start)} | Fin: ${formatTime(segment.end)} | Durée: ${formatTime(segment.end - segment.start)}\n`;

      const segmentTranscript = transcript.filter(
        t => t.start < segment.end && t.end > segment.start
      );

      if (segmentTranscript.length > 0) {
        content += '     Transcription:\n';
        segmentTranscript.forEach(t => {
          content += `     [${formatTime(t.start)}] ${t.text}\n`;
        });
      }
      content += '\n';
    });

    content += '\n' + '-'.repeat(40) + '\n';
    content += `Total: ${segments.length} séquences | Durée totale: ${formatTime(segments.reduce((acc, s) => acc + (s.end - s.start), 0))}\n`;

    const defaultName = videoFiles.length > 0
      ? videoFiles[0].name.replace(/\.[^/.]+$/, '') + '_sequences.txt'
      : 'sequences.txt';

    await window.electron.saveTextFile(content, defaultName);
  };

  // Exporte la transcription brute en fichier TXT (sans timecodes)
  const handleExportTxtPropre = async () => {
    if (transcript.length === 0) return;
    setShowExportMenu(false);

    let content = '';

    if (segments.length > 0) {
      segments.forEach((segment, index) => {
        const segmentTranscript = transcript.filter(
          t => t.start < segment.end && t.end > segment.start
        );
        if (segmentTranscript.length > 0) {
          content += `== ${String(index + 1).padStart(2, '0')}. ${segment.title} ==\n\n`;
          content += segmentTranscript.map(t => t.text).join(' ') + '\n\n';
        }
      });
    } else {
      content = transcript.map(t => t.text).join(' ');
    }

    content = content.trim();

    const defaultName = videoFiles.length > 0
      ? videoFiles[0].name.replace(/\.[^/.]+$/, '') + '_transcription.txt'
      : 'transcription.txt';

    await window.electron.saveTextFile(content, defaultName);
  };

  if (videoFiles.length === 0) return null;

  // --- Rendu JSX ---
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card border border-border rounded-xl shadow-sm flex flex-col h-full"
    >
      {/* En-tête : compteur de séquences, bouton ajout et menu d'export */}
      <div className="panel-drag-handle flex items-center justify-between px-4 py-3 border-b border-border cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3 h-3 text-muted-foreground/40" />
          <Scissors className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold text-foreground">{segments.length} séquences</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddDefault}
            className="h-7 w-7 p-0"
            title="Ajouter une séquence"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>

          {/* Export dropdown */}
          {segments.length > 0 && (
            <div className="relative" ref={exportMenuRef}>
              <Button
                variant="default"
                size="sm"
                onClick={() => setShowExportMenu(!showExportMenu)}
                disabled={isExporting}
                className="h-7 px-2.5 gap-1 text-[10px] font-bold uppercase tracking-wider"
              >
                <Film className="w-3 h-3" />
                Export
                <ChevronDown className="w-3 h-3" />
              </Button>

              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-popover border border-border rounded-lg shadow-lg z-50 py-1">
                  <button
                    onClick={handleExportVideo}
                    className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-secondary/50 transition-colors flex items-center gap-2"
                  >
                    <Film className="w-3.5 h-3.5 text-primary" />
                    Exporter les vidéos
                  </button>
                  <button
                    onClick={handleExportTxtSequences}
                    className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-secondary/50 transition-colors flex items-center gap-2"
                  >
                    <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                    TXT avec timecodes
                  </button>
                  {transcript.length > 0 && (
                    <button
                      onClick={handleExportTxtPropre}
                      className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-secondary/50 transition-colors flex items-center gap-2"
                    >
                      <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      TXT propre
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Liste des segments réordonnables (drag & drop via Reorder) */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        <Reorder.Group
          axis="y"
          values={segments}
          onReorder={(newOrder) => setSegments(newOrder)}
          className="space-y-1"
        >
          {segments.map((seg, i) => (
            <Reorder.Item
              key={seg.id}
              value={seg}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all select-none ${
                selectedSegmentId === seg.id
                  ? "bg-primary/10 ring-1 ring-primary/30"
                  : "hover:bg-muted/60"
              }`}
              onClick={() => setSelectedSegmentId(seg.id)}
              whileDrag={{ scale: 1.02, boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }}
            >
              {/* Drag handle */}
              <GripVertical className="w-3 h-3 text-muted-foreground/40 shrink-0 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity" />

              {/* Color indicator */}
              <div
                className="w-1.5 h-8 rounded-full shrink-0 shadow-sm"
                style={{ backgroundColor: seg.color || "hsl(var(--primary))" }}
              />

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold text-muted-foreground">{i + 1}</span>
                  <input
                    type="text"
                    value={seg.title}
                    onChange={(e) => updateSegment(seg.id, { title: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    className="bg-transparent text-xs font-semibold text-foreground outline-none w-full truncate hover:text-primary focus:text-primary transition-colors"
                    placeholder="Nom du segment..."
                  />
                </div>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {formatTime(seg.start)} — {formatTime(seg.end)} ({formatTime(seg.end - seg.start)})
                </span>
              </div>

              {/* Actions - visible on hover or selected */}
              <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ${
                selectedSegmentId === seg.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    const isSelected = selectedSegmentId === seg.id;
                    if (!isSelected) {
                      setSelectedSegmentId(seg.id);
                      setIsPlaying(true);
                    } else {
                      setIsPlaying(!isPlaying);
                    }
                  }}
                >
                  {selectedSegmentId === seg.id && isPlaying ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSegment(seg.id);
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </Reorder.Item>
          ))}
        </Reorder.Group>

        {segments.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Scissors className="w-8 h-8 text-muted-foreground/30 mb-3" />
            <p className="text-xs text-muted-foreground/60">Aucune séquence</p>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default Timeline;

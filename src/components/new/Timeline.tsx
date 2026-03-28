/**
 * TIMELINE.TSX : Liste des segments avec gestion et export
 * Version web : export via API backend + download navigateur
 */

import { useState, useRef, useEffect } from "react";
import { motion, Reorder } from "framer-motion";
import { Scissors, Play, Trash2, Plus, Pause, FileText, Film, ChevronDown, GripVertical, GripHorizontal, Loader2 } from "lucide-react";
import { useStore } from "@/store/useStore";
import { Button } from "@/components/ui/button";
import api from "@/api";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const Timeline = () => {
  const {
    segments, selectedSegmentId, setSelectedSegmentId, videoFiles,
    removeSegment, addSegment, getTotalDuration, isPlaying, setIsPlaying,
    updateSegment, getClipsForSegment, setProcessing, transcript, setTranscript, setSegments,
    videoFile, audioPaths, setAudioPaths, config
  } = useStore();

  const [isExporting, setIsExporting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Assure qu'on a une transcription, la lance si besoin
  const ensureTranscript = async (): Promise<boolean> => {
    if (transcript.length > 0) return true;
    if (videoFiles.length === 0) return false;

    setIsTranscribing(true);
    try {
      // Extraire l'audio si pas encore fait
      let paths = audioPaths;
      if (!paths || paths.length === 0) {
        paths = [];
        for (const vf of videoFiles) {
          const audioPath = await api.extractAudio(vf.path);
          paths.push(audioPath);
        }
        setAudioPaths(paths);
      }

      // Transcrire chaque audio
      const allSegments: any[] = [];
      for (let i = 0; i < paths.length; i++) {
        const segs = await api.transcribe(paths[i], config.language, config.whisperModel, config.whisperPrompt);
        const offset = videoFiles[i]?.offset || 0;
        const adjusted = segs.map((s: any) => ({ ...s, start: s.start + offset, end: s.end + offset }));
        allSegments.push(...adjusted);
      }

      setTranscript(allSegments);
      setIsTranscribing(false);
      return allSegments.length > 0;
    } catch (err) {
      console.error('Erreur transcription auto:', err);
      setIsTranscribing(false);
      return false;
    }
  };
  const totalDuration = getTotalDuration();

  useEffect(() => {
    if (!showExportMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setShowExportMenu(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showExportMenu]);

  const handleAddDefault = () => {
    if (videoFiles.length === 0) return;
    const lastEnd = segments.length > 0 ? Math.max(...segments.map(s => s.end)) : 0;
    if (lastEnd >= totalDuration) return;
    addSegment({
      id: crypto.randomUUID(),
      title: `Sequence ${segments.length + 1}`,
      start: lastEnd, end: Math.min(lastEnd + 30, totalDuration),
      color: "", transcriptSegments: [],
    });
  };

  const handleExportVideo = async () => {
    if (segments.length === 0 || videoFiles.length === 0) return;
    setIsExporting(true);
    setShowExportMenu(false);
    setProcessing('exporting', 0, 'Demarrage de l\'export...');

    try {
      const downloadUrls: { url: string; name: string }[] = [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        setProcessing('exporting', ((i / segments.length) * 100), `Export ${i + 1}/${segments.length}: ${segment.title}`);

        const clips = getClipsForSegment(segment.start, segment.end);
        if (clips.length === 0) continue;

        const result = await api.exportSegment(clips, segment.title, i);
        downloadUrls.push({ url: result.downloadUrl, name: result.filename });
      }

      setProcessing('done', 100, 'Export termine !');

      // Telecharger tous les fichiers
      for (const { url, name } of downloadUrls) {
        api.downloadExport(url, name);
        await new Promise(r => setTimeout(r, 500)); // delai entre downloads
      }
    } catch (error: any) {
      console.error('Export error:', error);
      setProcessing('error', 0, `Erreur export: ${error.message || error}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportTxtSequences = async () => {
    if (segments.length === 0) return;
    setShowExportMenu(false);

    // Lancer la transcription si pas encore faite
    await ensureTranscript();
    const currentTranscript = useStore.getState().transcript;

    let content = '='.repeat(60) + '\n';
    content += 'SEQUENCES AVEC TIMECODES\n';
    content += '='.repeat(60) + '\n\n';

    segments.forEach((segment, index) => {
      content += `[${String(index + 1).padStart(2, '0')}] ${segment.title}\n`;
      content += `     Debut: ${formatTime(segment.start)} | Fin: ${formatTime(segment.end)} | Duree: ${formatTime(segment.end - segment.start)}\n`;
      const segTranscript = currentTranscript.filter(t => t.start < segment.end && t.end > segment.start);
      if (segTranscript.length > 0) {
        content += '     Transcription:\n';
        segTranscript.forEach(t => { content += `     [${formatTime(t.start)}] ${t.text}\n`; });
      }
      content += '\n';
    });

    content += '\n' + '-'.repeat(40) + '\n';
    content += `Total: ${segments.length} sequences | Duree totale: ${formatTime(segments.reduce((acc, s) => acc + (s.end - s.start), 0))}\n`;

    const defaultName = videoFiles.length > 0
      ? videoFiles[0].name.replace(/\.[^/.]+$/, '') + '_sequences.txt'
      : 'sequences.txt';

    const result = await api.exportText(content, defaultName);
    api.downloadExport(result.downloadUrl, defaultName);
  };

  const handleExportTxtPropre = async () => {
    setShowExportMenu(false);

    // Lancer la transcription si pas encore faite
    const hasTranscript = await ensureTranscript();
    if (!hasTranscript) return;
    const currentTranscript = useStore.getState().transcript;

    let content = '';
    if (segments.length > 0) {
      segments.forEach((segment, index) => {
        const segTranscript = currentTranscript.filter(t => t.start < segment.end && t.end > segment.start);
        if (segTranscript.length > 0) {
          content += `== ${String(index + 1).padStart(2, '0')}. ${segment.title} ==\n\n`;
          content += segTranscript.map(t => t.text).join(' ') + '\n\n';
        }
      });
    } else {
      content = currentTranscript.map(t => t.text).join(' ');
    }
    content = content.trim();

    const defaultName = videoFiles.length > 0
      ? videoFiles[0].name.replace(/\.[^/.]+$/, '') + '_transcription.txt'
      : 'transcription.txt';

    const result = await api.exportText(content, defaultName);
    api.downloadExport(result.downloadUrl, defaultName);
  };

  if (videoFiles.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card border border-border rounded-xl shadow-sm flex flex-col h-full"
    >
      <div className="panel-drag-handle flex items-center justify-between px-4 py-3 border-b border-border cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3 h-3 text-muted-foreground/40" />
          <Scissors className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold text-foreground">{segments.length} sequences</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={handleAddDefault} className="h-7 w-7 p-0" title="Ajouter une sequence">
            <Plus className="w-3.5 h-3.5" />
          </Button>
          {segments.length > 0 && (
            <div className="relative" ref={exportMenuRef}>
              <Button variant="default" size="sm" onClick={() => setShowExportMenu(!showExportMenu)} disabled={isExporting} className="h-7 px-2.5 gap-1 text-[10px] font-bold uppercase tracking-wider">
                <Film className="w-3 h-3" /> Export <ChevronDown className="w-3 h-3" />
              </Button>
              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-popover border border-border rounded-lg shadow-lg z-50 py-1">
                  <button onClick={handleExportVideo} className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-secondary/50 transition-colors flex items-center gap-2">
                    <Film className="w-3.5 h-3.5 text-primary" /> Exporter les videos
                  </button>
                  <button onClick={handleExportTxtSequences} disabled={isTranscribing} className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-secondary/50 transition-colors flex items-center gap-2 disabled:opacity-50">
                    {isTranscribing ? <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" /> : <FileText className="w-3.5 h-3.5 text-muted-foreground" />}
                    TXT avec timecodes
                  </button>
                  <button onClick={handleExportTxtPropre} disabled={isTranscribing} className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-secondary/50 transition-colors flex items-center gap-2 disabled:opacity-50">
                    {isTranscribing ? <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" /> : <FileText className="w-3.5 h-3.5 text-muted-foreground" />}
                    TXT propre {transcript.length === 0 && <span className="text-[8px] text-muted-foreground">(transcription auto)</span>}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        <Reorder.Group axis="y" values={segments} onReorder={(newOrder) => setSegments(newOrder)} className="space-y-1">
          {segments.map((seg, i) => (
            <Reorder.Item
              key={seg.id} value={seg}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all select-none ${
                selectedSegmentId === seg.id ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-muted/60"
              }`}
              onClick={() => setSelectedSegmentId(seg.id)}
              whileDrag={{ scale: 1.02, boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }}
            >
              <GripVertical className="w-3 h-3 text-muted-foreground/40 shrink-0 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-1.5 h-8 rounded-full shrink-0 shadow-sm" style={{ backgroundColor: seg.color || "hsl(var(--primary))" }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold text-muted-foreground">{i + 1}</span>
                  <input type="text" value={seg.title} onChange={(e) => updateSegment(seg.id, { title: e.target.value })} onClick={(e) => e.stopPropagation()} className="bg-transparent text-xs font-semibold text-foreground outline-none w-full truncate hover:text-primary focus:text-primary transition-colors" placeholder="Nom du segment..." />
                </div>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {formatTime(seg.start)} — {formatTime(seg.end)} ({formatTime(seg.end - seg.start)})
                </span>
              </div>
              <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ${selectedSegmentId === seg.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" onClick={(e) => {
                  e.stopPropagation();
                  if (selectedSegmentId !== seg.id) { setSelectedSegmentId(seg.id); setIsPlaying(true); }
                  else setIsPlaying(!isPlaying);
                }}>
                  {selectedSegmentId === seg.id && isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); removeSegment(seg.id); }}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </Reorder.Item>
          ))}
        </Reorder.Group>

        {segments.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Scissors className="w-8 h-8 text-muted-foreground/30 mb-3" />
            <p className="text-xs text-muted-foreground/60">Aucune sequence</p>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default Timeline;

/**
 * MANUALSEGMENTPANEL.TSX : Panneau de decoupage manuel
 * Permet d'ajouter des segments a la main en definissant debut/fin sur la timeline.
 */

import { useState } from "react";
import { Scissors, Plus, Clock } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "@/store/useStore";
import { Button } from "@/components/ui/button";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseTime(str: string): number {
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

const ManualSegmentPanel = () => {
  const { videoFiles, segments, addSegment, getTotalDuration } = useStore();
  const totalDuration = getTotalDuration();

  const [title, setTitle] = useState("");
  const [startStr, setStartStr] = useState("");
  const [endStr, setEndStr] = useState("");

  const lastEnd = segments.length > 0 ? Math.max(...segments.map(s => s.end)) : 0;

  const handleAdd = () => {
    if (videoFiles.length === 0) return;

    const start = startStr ? parseTime(startStr) : lastEnd;
    const end = endStr ? parseTime(endStr) : Math.min(start + 60, totalDuration);

    if (end <= start || start >= totalDuration) return;

    addSegment({
      id: crypto.randomUUID(),
      title: title.trim() || `Sequence ${segments.length + 1}`,
      start: Math.max(0, start),
      end: Math.min(end, totalDuration),
      color: "",
      transcriptSegments: [],
    });

    setTitle("");
    setStartStr("");
    setEndStr("");
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      className="space-y-6"
    >
      {/* Formulaire d'ajout */}
      <div className="space-y-3">
        <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Scissors className="w-3.5 h-3.5" /> Ajouter un segment
        </label>

        {/* Titre */}
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Sequence ${segments.length + 1}`}
          className="w-full bg-secondary/10 text-xs text-foreground px-3 py-2.5 rounded-lg border border-border focus:ring-1 focus:ring-primary outline-none"
        />

        {/* Debut / Fin */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-secondary/30 p-3 rounded-lg border border-border">
            <span className="text-[9px] font-bold text-muted-foreground uppercase block mb-1.5">Debut</span>
            <input
              type="text"
              value={startStr}
              onChange={(e) => setStartStr(e.target.value)}
              placeholder={formatTime(lastEnd)}
              className="w-full bg-transparent text-xs font-semibold text-foreground outline-none font-mono"
            />
          </div>
          <div className="bg-secondary/30 p-3 rounded-lg border border-border">
            <span className="text-[9px] font-bold text-muted-foreground uppercase block mb-1.5">Fin</span>
            <input
              type="text"
              value={endStr}
              onChange={(e) => setEndStr(e.target.value)}
              placeholder={formatTime(Math.min(lastEnd + 60, totalDuration))}
              className="w-full bg-transparent text-xs font-semibold text-foreground outline-none font-mono"
            />
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground">Format : M:SS ou H:MM:SS</p>
      </div>

      {/* Bouton ajouter */}
      <Button
        onClick={handleAdd}
        disabled={videoFiles.length === 0}
        className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-bold uppercase tracking-wide rounded-lg"
      >
        <span className="flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Ajouter le segment
        </span>
      </Button>

      {/* Raccourcis rapides */}
      <div className="space-y-3">
        <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" /> Raccourcis
        </label>

        <div className="grid grid-cols-2 gap-2">
          {[30, 60, 120, 300].map((dur) => (
            <button
              key={dur}
              onClick={() => {
                const start = lastEnd;
                const end = Math.min(start + dur, totalDuration);
                if (end > start) {
                  addSegment({
                    id: crypto.randomUUID(),
                    title: `Sequence ${segments.length + 1}`,
                    start, end,
                    color: "", transcriptSegments: [],
                  });
                }
              }}
              disabled={lastEnd >= totalDuration}
              className="px-3 py-2 text-xs font-medium bg-secondary/20 hover:bg-secondary/40 text-foreground rounded-lg border border-border transition-colors disabled:opacity-30"
            >
              +{dur >= 60 ? `${dur / 60}min` : `${dur}s`}
            </button>
          ))}
        </div>
      </div>

      {/* Info */}
      <div className="p-4 bg-secondary/5 rounded-xl border border-border">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Decoupe manuelle : definir les bornes de chaque segment. Les segments apparaissent dans la liste a gauche une fois ajoutes.
        </p>
        {totalDuration > 0 && (
          <p className="text-[10px] text-muted-foreground/60 mt-2 font-mono">
            Duree totale : {formatTime(totalDuration)} | Couvert : {formatTime(lastEnd)} ({Math.round(lastEnd / totalDuration * 100)}%)
          </p>
        )}
      </div>
    </motion.div>
  );
};

export default ManualSegmentPanel;

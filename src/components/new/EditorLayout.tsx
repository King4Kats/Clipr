/**
 * EDITORLAYOUT.TSX : Disposition de l'éditeur NLE redimensionnable
 *
 * Utilise react-grid-layout pour créer une interface de type éditeur vidéo
 * non-linéaire (NLE) avec trois panneaux déplaçables et redimensionnables :
 * - Prévisualisation vidéo (VideoPreview)
 * - Liste des segments (Timeline)
 * - Timeline avec waveform (SegmentTimeline)
 * La disposition est sauvegardée dans le localStorage.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import GridLayout, { Layout } from "react-grid-layout";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import VideoPreview from "./VideoPreview";
import Timeline from "./Timeline";
import SegmentTimeline from "./SegmentTimeline";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

// --- Constantes de configuration de la grille ---
const STORAGE_KEY = "clipr-editor-layout";
const COLS = 12;
const ROW_HEIGHT = 80;
const GAP = 6;

// Disposition par défaut des trois panneaux (vidéo, segments, timeline)
const DEFAULT_LAYOUT: Layout[] = [
  { i: "video", x: 0, y: 0, w: 8, h: 5, minW: 3, minH: 2 },
  { i: "segments", x: 8, y: 0, w: 4, h: 5, minW: 2, minH: 2 },
  { i: "timeline", x: 0, y: 5, w: 12, h: 3, minW: 4, minH: 2 },
];

// Correspondance clé → composant pour chaque panneau de l'éditeur
const PANELS: Record<string, { component: React.FC }> = {
  video: { component: VideoPreview },
  segments: { component: Timeline },
  timeline: { component: SegmentTimeline },
};

export default function EditorLayout() {
  // --- Etat : référence au conteneur et largeur mesurée ---
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Charge la disposition sauvegardée depuis le localStorage ou utilise la disposition par défaut
  const [layout, setLayout] = useState<Layout[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 3) return parsed;
      }
    } catch { /* ignore */ }
    return DEFAULT_LAYOUT;
  });

  // --- Effet : mesure la largeur du conteneur et réagit au redimensionnement ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => setWidth(el.offsetWidth);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Sauvegarde la disposition dans le localStorage à chaque modification
  const handleLayoutChange = useCallback((newLayout: Layout[]) => {
    setLayout(newLayout);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newLayout));
  }, []);

  // Réinitialise la disposition à la configuration par défaut
  const resetLayout = useCallback(() => {
    setLayout([...DEFAULT_LAYOUT]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_LAYOUT));
  }, []);

  // --- Rendu : grille react-grid-layout avec les panneaux et bouton de reset ---
  return (
    <div ref={containerRef} className="relative min-h-[calc(100vh-3.5rem)]">
      {width > 0 && (
        <GridLayout
          layout={layout}
          cols={COLS}
          rowHeight={ROW_HEIGHT}
          width={width}
          margin={[GAP, GAP]}
          containerPadding={[GAP, GAP]}
          onLayoutChange={handleLayoutChange}
          draggableHandle=".panel-drag-handle"
          isResizable
          isDraggable
          useCSSTransforms
          resizeHandles={["se", "sw", "ne", "nw", "e", "w", "n", "s"]}
        >
          {Object.entries(PANELS).map(([key, panel]) => (
            <div key={key} className="h-full">
              <panel.component />
            </div>
          ))}
        </GridLayout>
      )}

      {/* Bouton de réinitialisation de la disposition */}
      <div className="sticky bottom-0 flex justify-end p-2 pointer-events-none">
        <Button
          variant="ghost"
          size="sm"
          onClick={resetLayout}
          className="h-6 px-2 gap-1 text-[9px] text-muted-foreground/40 hover:text-muted-foreground uppercase tracking-wider font-bold pointer-events-auto"
          title="Réinitialiser la disposition"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </Button>
      </div>
    </div>
  );
}

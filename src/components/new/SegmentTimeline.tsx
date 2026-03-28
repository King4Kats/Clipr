import { useRef, useEffect, useState, useCallback } from "react";
import { useStore } from "@/store/useStore";
import { ZoomIn, ZoomOut, Maximize2, GripHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * SegmentTimeline — Timeline interactive style NLE (Non-Linear Editor)
 *
 * Affiche la waveform audio avec les segments en overlay coloré.
 * Permet de sélectionner, redimensionner (drag handles) et naviguer.
 */

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Couleurs de segment avec alpha pour overlay
const SEGMENT_COLORS_ALPHA = [
  "rgba(59, 130, 246, 0.35)",
  "rgba(16, 185, 129, 0.35)",
  "rgba(245, 158, 11, 0.35)",
  "rgba(239, 68, 68, 0.35)",
  "rgba(139, 92, 246, 0.35)",
  "rgba(236, 72, 153, 0.35)",
  "rgba(6, 182, 212, 0.35)",
  "rgba(132, 204, 22, 0.35)",
];

const SEGMENT_COLORS_SOLID = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
];

interface DragState {
  segmentId: string;
  edge: "start" | "end";
  initialTime: number;
  initialMouseX: number;
}

const SegmentTimeline = () => {
  const {
    segments,
    selectedSegmentId,
    setSelectedSegmentId,
    updateSegment,
    getTotalDuration,
  } = useStore();

  const audioPath = useStore((s) => s.audioPath);
  const containerRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // Zoom & scroll
  const [zoom, setZoom] = useState(1);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Drag state
  const dragRef = useRef<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Hover state for handles
  const [hoveredHandle, setHoveredHandle] = useState<{ segmentId: string; edge: string } | null>(null);

  const totalDuration = getTotalDuration();
  const visibleDuration = totalDuration / zoom;
  const visibleStart = scrollOffset;
  const visibleEnd = scrollOffset + visibleDuration;

  // Sync with video currentTime
  useEffect(() => {
    const video = document.querySelector("video");
    if (!video) return;

    const handleTimeUpdate = () => {
      const segment = segments.find((s) => s.id === selectedSegmentId);
      const videoFile = useStore.getState().videoFiles[useStore.getState().currentVideoIndex];
      if (segment && videoFile) {
        setCurrentTime(video.currentTime + (videoFile.offset || 0));
      } else if (videoFile) {
        setCurrentTime(video.currentTime + (videoFile.offset || 0));
      }
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, [selectedSegmentId, segments]);

  // Load audio buffer
  useEffect(() => {
    if (!audioPath) {
      setAudioBuffer(null);
      return;
    }

    const loadAudio = async () => {
      setLoading(true);
      try {
        // En mode web, charger l'audio via HTTP avec auth
        const dataDir = audioPath.includes('/data/') ? audioPath.split('/data/')[1] : audioPath;
        const token = localStorage.getItem('clipr-auth-token');
        const url = `/api/data-files/${dataDir}${token ? `?token=${token}` : ''}`;
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        setAudioBuffer(decoded);
      } catch (err) {
        console.warn("Waveform load error:", err);
      } finally {
        setLoading(false);
      }
    };

    loadAudio();
  }, [audioPath]);

  // Render waveform
  useEffect(() => {
    if (!audioBuffer || !waveformCanvasRef.current) return;

    const canvas = waveformCanvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.parentElement?.getBoundingClientRect();
    const displayWidth = rect?.width || 1200;
    const displayHeight = rect?.height || 120;

    canvas.width = displayWidth * 2; // 2x for retina
    canvas.height = displayHeight * 2;

    const channelData = audioBuffer.getChannelData(0);
    const duration = audioBuffer.duration;

    const startFrac = visibleStart / duration;
    const endFrac = visibleEnd / duration;
    const startSample = Math.floor(startFrac * channelData.length);
    const endSample = Math.floor(endFrac * channelData.length);

    const width = canvas.width;
    const height = canvas.height;
    const mid = height / 2;

    ctx.clearRect(0, 0, width, height);

    const barWidth = 2;
    const gap = 1;
    const totalBarWidth = barWidth + gap;
    const barCount = Math.floor(width / totalBarWidth);
    const samplesPerBar = Math.max(1, Math.floor((endSample - startSample) / barCount));

    for (let i = 0; i < barCount; i++) {
      let max = 0;
      const frameOffset = startSample + i * samplesPerBar;

      if (frameOffset >= channelData.length) break;

      const searchLimit = Math.min(samplesPerBar, channelData.length - frameOffset);
      for (let j = 0; j < searchLimit; j++) {
        const sample = Math.abs(channelData[frameOffset + j] || 0);
        if (sample > max) max = sample;
      }

      const x = i * totalBarWidth;
      const barHeight = Math.max(2, max * height * 1.1);
      const top = mid - barHeight / 2;

      const barTime = visibleStart + (i / barCount) * visibleDuration;
      ctx.fillStyle = barTime <= currentTime ? "#ea580c" : "#334155";

      ctx.fillRect(x, top, barWidth, barHeight);
    }

    // Playhead
    const progress = (currentTime - visibleStart) / visibleDuration;
    if (progress >= 0 && progress <= 1) {
      const px = progress * width;
      ctx.fillStyle = "#ffffff";
      ctx.shadowBlur = 12;
      ctx.shadowColor = "rgba(255,255,255,0.9)";
      ctx.fillRect(px - 1, 0, 2, height);
      ctx.shadowBlur = 0;
    }
  }, [audioBuffer, currentTime, visibleStart, visibleEnd, visibleDuration, zoom]);

  // Time-to-pixel helpers
  const timeToPercent = useCallback(
    (time: number) => ((time - visibleStart) / visibleDuration) * 100,
    [visibleStart, visibleDuration]
  );

  const pixelToTime = useCallback(
    (clientX: number) => {
      if (!containerRef.current) return 0;
      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const frac = x / rect.width;
      return visibleStart + frac * visibleDuration;
    },
    [visibleStart, visibleDuration]
  );

  // Drag handlers
  const handleDragStart = useCallback(
    (e: React.MouseEvent, segmentId: string, edge: "start" | "end") => {
      e.stopPropagation();
      e.preventDefault();
      const segment = segments.find((s) => s.id === segmentId);
      if (!segment) return;

      dragRef.current = {
        segmentId,
        edge,
        initialTime: edge === "start" ? segment.start : segment.end,
        initialMouseX: e.clientX,
      };
      setIsDragging(true);
    },
    [segments]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const newTime = pixelToTime(e.clientX);
      const clamped = Math.max(0, Math.min(newTime, totalDuration));
      const segment = segments.find((s) => s.id === dragRef.current!.segmentId);
      if (!segment) return;

      if (dragRef.current.edge === "start") {
        const newStart = Math.min(clamped, segment.end - 1);
        updateSegment(dragRef.current.segmentId, { start: Math.round(newStart * 10) / 10 });
      } else {
        const newEnd = Math.max(clamped, segment.start + 1);
        updateSegment(dragRef.current.segmentId, { end: Math.round(newEnd * 10) / 10 });
      }
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, segments, pixelToTime, totalDuration, updateSegment]);

  // Click on timeline to seek
  const handleTimelineClick = (e: React.MouseEvent) => {
    if (isDragging) return;
    const time = pixelToTime(e.clientX);

    // Find segment at this time
    const seg = segments.find((s) => time >= s.start && time <= s.end);
    if (seg) {
      setSelectedSegmentId(seg.id);
    }

    // Seek video
    const video = document.querySelector("video") as HTMLVideoElement;
    if (video) {
      const state = useStore.getState();
      const videoInfo = state.getVideoAtTime(time);
      if (videoInfo) {
        video.currentTime = videoInfo.localTime;
      }
    }
  };

  // Zoom controls
  const handleZoomIn = () => {
    setZoom((z) => Math.min(z * 1.5, 20));
  };

  const handleZoomOut = () => {
    setZoom((z) => Math.max(z / 1.5, 1));
  };

  const handleFitAll = () => {
    setZoom(1);
    setScrollOffset(0);
  };

  // Scroll with wheel
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      e.preventDefault();
      if (e.deltaY < 0) handleZoomIn();
      else handleZoomOut();
    } else {
      // Scroll
      const delta = (e.deltaY / 500) * visibleDuration;
      setScrollOffset((o) => Math.max(0, Math.min(o + delta, totalDuration - visibleDuration)));
    }
  };

  // Time ruler ticks
  const getTimeTicks = () => {
    const ticks: { time: number; label: string }[] = [];
    // Determine tick interval based on visible duration
    let interval: number;
    if (visibleDuration > 7200) interval = 600;
    else if (visibleDuration > 3600) interval = 300;
    else if (visibleDuration > 1800) interval = 120;
    else if (visibleDuration > 600) interval = 60;
    else if (visibleDuration > 120) interval = 30;
    else if (visibleDuration > 30) interval = 10;
    else interval = 5;

    const start = Math.ceil(visibleStart / interval) * interval;
    for (let t = start; t <= visibleEnd; t += interval) {
      ticks.push({ time: t, label: formatTime(t) });
    }
    return ticks;
  };

  if (totalDuration === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm h-full flex flex-col">
      {/* Toolbar - drag handle */}
      <div className="panel-drag-handle flex items-center justify-between px-4 py-2 bg-secondary/30 border-b border-border cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3 h-3 text-muted-foreground/40" />
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground">
            Timeline
          </span>
          {zoom > 1 && (
            <span className="text-[9px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
              x{zoom.toFixed(1)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomOut} title="Dézoomer">
            <ZoomOut className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleFitAll} title="Voir tout">
            <Maximize2 className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomIn} title="Zoomer">
            <ZoomIn className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Time Ruler */}
      <div className="relative h-5 bg-black/40 border-b border-white/5 select-none overflow-hidden">
        {getTimeTicks().map((tick) => {
          const left = timeToPercent(tick.time);
          if (left < -5 || left > 105) return null;
          return (
            <div
              key={tick.time}
              className="absolute top-0 bottom-0 flex flex-col items-center"
              style={{ left: `${left}%` }}
            >
              <div className="w-px h-2 bg-white/20" />
              <span className="text-[8px] font-mono text-white/30 mt-0.5 whitespace-nowrap">{tick.label}</span>
            </div>
          );
        })}
        {/* Playhead marker on ruler */}
        {(() => {
          const left = timeToPercent(currentTime);
          if (left < 0 || left > 100) return null;
          return (
            <div
              className="absolute top-0 w-0 h-0 z-30"
              style={{
                left: `${left}%`,
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "6px solid #ea580c",
                transform: "translateX(-5px)",
              }}
            />
          );
        })()}
      </div>

      {/* Main Timeline Area */}
      <div
        ref={containerRef}
        className="relative select-none flex-1 min-h-0"
        style={{ minHeight: "80px", cursor: isDragging ? "col-resize" : "default" }}
        onClick={handleTimelineClick}
        onWheel={handleWheel}
      >
        {/* Waveform Canvas */}
        <canvas
          ref={waveformCanvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ imageRendering: "crisp-edges" }}
        />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-40">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Segment Overlays */}
        {segments.map((seg, i) => {
          const left = timeToPercent(seg.start);
          const right = timeToPercent(seg.end);
          const width = right - left;

          if (right < 0 || left > 100) return null;

          const isSelected = selectedSegmentId === seg.id;
          const colorIndex = i % SEGMENT_COLORS_ALPHA.length;
          const bgColor = SEGMENT_COLORS_ALPHA[colorIndex];
          const borderColor = SEGMENT_COLORS_SOLID[colorIndex];

          return (
            <div
              key={seg.id}
              className={`absolute top-0 bottom-0 transition-opacity ${isSelected ? "z-20" : "z-10"}`}
              style={{
                left: `${Math.max(0, left)}%`,
                width: `${Math.min(width, 100 - Math.max(0, left))}%`,
                backgroundColor: bgColor,
                borderTop: `2px solid ${borderColor}`,
                borderBottom: `2px solid ${borderColor}`,
                opacity: isSelected ? 1 : 0.7,
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedSegmentId(seg.id);
              }}
            >
              {/* Segment Label */}
              <div className="absolute top-1 left-1.5 right-6 pointer-events-none">
                <span
                  className="text-[10px] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] truncate block"
                  style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}
                >
                  {seg.title}
                </span>
                <span className="text-[8px] font-mono text-white/60 mt-0.5 block">
                  {formatTime(seg.start)} — {formatTime(seg.end)}
                </span>
              </div>

              {/* Left Drag Handle (start) */}
              <div
                className={`absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-30 group/handle transition-colors ${
                  hoveredHandle?.segmentId === seg.id && hoveredHandle?.edge === "start"
                    ? "bg-white/40"
                    : "hover:bg-white/30"
                }`}
                onMouseDown={(e) => handleDragStart(e, seg.id, "start")}
                onMouseEnter={() => setHoveredHandle({ segmentId: seg.id, edge: "start" })}
                onMouseLeave={() => setHoveredHandle(null)}
              >
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-white/60 shadow-lg" />
              </div>

              {/* Right Drag Handle (end) */}
              <div
                className={`absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-30 group/handle transition-colors ${
                  hoveredHandle?.segmentId === seg.id && hoveredHandle?.edge === "end"
                    ? "bg-white/40"
                    : "hover:bg-white/30"
                }`}
                onMouseDown={(e) => handleDragStart(e, seg.id, "end")}
                onMouseEnter={() => setHoveredHandle({ segmentId: seg.id, edge: "end" })}
                onMouseLeave={() => setHoveredHandle(null)}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-white/60 shadow-lg" />
              </div>
            </div>
          );
        })}

        {/* Playhead Line */}
        {(() => {
          const left = timeToPercent(currentTime);
          if (left < 0 || left > 100) return null;
          return (
            <div
              className="absolute top-0 bottom-0 z-30 pointer-events-none"
              style={{ left: `${left}%` }}
            >
              <div className="w-0.5 h-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]" />
            </div>
          );
        })()}
      </div>

      {/* Scrollbar (visible when zoomed) */}
      {zoom > 1 && (
        <div className="h-3 bg-black/30 border-t border-white/5 relative">
          <div
            className="absolute top-0.5 bottom-0.5 bg-white/20 rounded-full cursor-grab active:cursor-grabbing hover:bg-white/30 transition-colors"
            style={{
              left: `${(scrollOffset / totalDuration) * 100}%`,
              width: `${(1 / zoom) * 100}%`,
            }}
            onMouseDown={(e) => {
              const startX = e.clientX;
              const startOffset = scrollOffset;
              const bar = e.currentTarget.parentElement!;

              const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const barWidth = bar.getBoundingClientRect().width;
                const timeDelta = (dx / barWidth) * totalDuration;
                setScrollOffset(Math.max(0, Math.min(startOffset + timeDelta, totalDuration - visibleDuration)));
              };

              const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
              };

              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
            }}
          />
        </div>
      )}
    </div>
  );
};

export default SegmentTimeline;

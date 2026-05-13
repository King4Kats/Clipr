/**
 * TIMELINE.TSX : Liste des segments avec gestion et export
 *
 * Ce fichier gere le panneau lateral qui affiche la liste des segments (sequences)
 * decoupes dans la video. Il permet de :
 * - Voir tous les segments avec leur titre, duree et timecodes
 * - Reordonner les segments par drag & drop
 * - Ajouter / supprimer / renommer des segments
 * - Exporter les segments en video (via le backend) ou en fichier texte (TXT)
 * - Lancer automatiquement une transcription si necessaire avant l'export texte
 *
 * Version web : l'export passe par une API backend puis le navigateur telecharge le fichier.
 */

// Imports React : hooks pour l'etat local, les refs DOM et les effets de bord
import { useState, useRef, useEffect } from "react";
// Framer Motion : animations fluides + composant Reorder pour le drag & drop
import { motion, Reorder } from "framer-motion";
// Icones Lucide utilisees dans l'interface (ciseaux, lecture, corbeille, etc.)
import { Scissors, Play, Trash2, Plus, Pause, FileText, Film, ChevronDown, GripVertical, GripHorizontal, Loader2, CheckCircle, Brain } from "lucide-react";
// Store Zustand global : contient l'etat partage de toute l'application (segments, fichiers video, etc.)
import { useStore } from "@/store/useStore";
// Composant bouton reutilisable de l'interface
import { Button } from "@/components/ui/button";
// Module API : toutes les fonctions pour communiquer avec le serveur backend
import api from "@/api";
import SemanticAnalysis from "@/components/new/SemanticAnalysis";

/**
 * Formate un nombre de secondes en chaine lisible "M:SS" ou "H:MM:SS".
 * Exemple : 125 secondes -> "2:05", 3661 secondes -> "1:01:01"
 * @param seconds - Le temps en secondes a formater
 * @returns La chaine formatee
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Composant principal Timeline.
 * Affiche la liste des segments, les boutons d'action et le menu d'export.
 */
const Timeline = () => {
  // ── Extraction des donnees et fonctions depuis le store global ──
  // segments : la liste des segments decoupes
  // selectedSegmentId : l'ID du segment actuellement selectionne
  // videoFiles : les fichiers video charges dans l'application
  // removeSegment / addSegment : fonctions pour gerer la liste de segments
  // isPlaying : indique si la video est en lecture
  // transcript : la transcription audio (tableau de segments de texte avec timecodes)
  // config : configuration globale (langue, modele Whisper, etc.)
  const {
    segments, selectedSegmentId, setSelectedSegmentId, videoFiles,
    removeSegment, addSegment, getTotalDuration, isPlaying, setIsPlaying,
    updateSegment, getClipsForSegment, setProcessing, processingStep, transcript, setTranscript, setSegments,
    videoFile, audioPaths, setAudioPaths, config
  } = useStore();

  // Etat local pour savoir si un export est en cours
  const [isExporting, setIsExporting] = useState(false);
  // Etat local pour savoir si une transcription automatique est en cours
  const [isTranscribing, setIsTranscribing] = useState(false);
  // Etat local pour afficher/masquer le menu deroulant d'export
  const [showExportMenu, setShowExportMenu] = useState(false);
  // Affichage du modal d'analyse semantique
  const [showSemanticAnalysis, setShowSemanticAnalysis] = useState(false);
  // Reference DOM vers le menu d'export (pour detecter les clics en dehors)
  const exportMenuRef = useRef<HTMLDivElement>(null);

  /**
   * S'assure qu'une transcription existe. Si elle n'existe pas encore,
   * elle lance automatiquement l'extraction audio puis la transcription Whisper.
   * Retourne true si la transcription est disponible, false sinon.
   */
  const ensureTranscript = async (): Promise<boolean> => {
    // Si on a deja une transcription, pas besoin de relancer
    if (transcript.length > 0) return true;
    // Pas de video = pas de transcription possible
    if (videoFiles.length === 0) return false;

    setIsTranscribing(true);
    try {
      // Etape 1 : Extraire l'audio de chaque video si ce n'est pas deja fait
      let paths = audioPaths;
      if (!paths || paths.length === 0) {
        paths = [];
        for (const vf of videoFiles) {
          const audioPath = await api.extractAudio(vf.path);
          paths.push(audioPath);
        }
        // Sauvegarder les chemins audio dans le store pour ne pas les re-extraire
        setAudioPaths(paths);
      }

      // Etape 2 : Transcrire chaque fichier audio avec Whisper
      const allSegments: any[] = [];
      for (let i = 0; i < paths.length; i++) {
        const segs = await api.transcribe(paths[i], config.language, config.whisperModel, config.whisperPrompt);
        // Appliquer l'offset temporel de chaque video (utile si plusieurs videos bout a bout)
        const offset = videoFiles[i]?.offset || 0;
        const adjusted = segs.map((s: any) => ({ ...s, start: s.start + offset, end: s.end + offset }));
        allSegments.push(...adjusted);
      }

      // Sauvegarder la transcription dans le store
      setTranscript(allSegments);
      setIsTranscribing(false);
      return allSegments.length > 0;
    } catch (err) {
      console.error('Erreur transcription auto:', err);
      setIsTranscribing(false);
      return false;
    }
  };

  // Calcul de la duree totale de toutes les videos chargees
  const totalDuration = getTotalDuration();

  /**
   * Effet pour fermer le menu d'export quand on clique en dehors.
   * On ecoute les clics sur le document entier, et si le clic est
   * en dehors du menu, on le ferme.
   */
  useEffect(() => {
    if (!showExportMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setShowExportMenu(false);
    };
    document.addEventListener("mousedown", handleClick);
    // Nettoyage : on retire l'ecouteur quand le composant se demonte ou le menu se ferme
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showExportMenu]);

  /**
   * Ajoute un segment par defaut de 30 secondes a la suite du dernier segment.
   * Si la duree totale est deja couverte, ne fait rien.
   */
  const handleAddDefault = () => {
    if (videoFiles.length === 0) return;
    // Trouver la fin du dernier segment existant
    const lastEnd = segments.length > 0 ? Math.max(...segments.map(s => s.end)) : 0;
    // Si tout est deja couvert, on ne peut plus ajouter
    if (lastEnd >= totalDuration) return;
    addSegment({
      id: crypto.randomUUID(), // Generer un identifiant unique
      title: `Sequence ${segments.length + 1}`,
      start: lastEnd, end: Math.min(lastEnd + 30, totalDuration), // 30 secondes ou jusqu'a la fin
      color: "", transcriptSegments: [],
    });
  };

  /**
   * Exporte chaque segment en fichier video via le backend.
   * Pour chaque segment, on envoie les clips (morceaux de video) correspondants
   * au backend qui les assemble, puis on telecharge le resultat.
   */
  const handleExportVideo = async () => {
    if (segments.length === 0 || videoFiles.length === 0) return;
    setIsExporting(true);
    setShowExportMenu(false);
    setProcessing('exporting', 0, 'Demarrage de l\'export...');

    try {
      // Collecter les URLs de telechargement pour chaque segment exporte
      const downloadUrls: { url: string; name: string }[] = [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        // Mettre a jour la barre de progression
        setProcessing('exporting', ((i / segments.length) * 100), `Export ${i + 1}/${segments.length}: ${segment.title}`);

        // Recuperer les clips video qui couvrent ce segment temporel
        const clips = getClipsForSegment(segment.start, segment.end);
        if (clips.length === 0) continue;

        // Envoyer au backend pour assemblage
        const result = await api.exportSegment(clips, segment.title, i);
        downloadUrls.push({ url: result.downloadUrl, name: result.filename });
      }

      setProcessing('done', 100, 'Export termine !');

      // Telecharger tous les fichiers un par un avec un petit delai entre chaque
      for (const { url, name } of downloadUrls) {
        api.downloadExport(url, name);
        await new Promise(r => setTimeout(r, 500)); // delai entre downloads pour eviter les conflits
      }
    } catch (error: any) {
      console.error('Export error:', error);
      setProcessing('error', 0, `Erreur export: ${error.message || error}`);
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * Exporte un fichier TXT contenant les sequences avec leurs timecodes.
   * Si la transcription n'existe pas, elle est lancee automatiquement.
   * Le format inclut : numero, titre, debut/fin, duree, et le texte transcrit.
   */
  const handleExportTxtSequences = async () => {
    if (segments.length === 0) return;
    setShowExportMenu(false);

    // Lancer la transcription si pas encore faite
    await ensureTranscript();
    // Recuperer la transcription la plus recente depuis le store
    const currentTranscript = useStore.getState().transcript;

    // Construction du contenu texte avec mise en forme
    let content = '='.repeat(60) + '\n';
    content += 'SEQUENCES AVEC TIMECODES\n';
    content += '='.repeat(60) + '\n\n';

    segments.forEach((segment, index) => {
      content += `[${String(index + 1).padStart(2, '0')}] ${segment.title}\n`;
      content += `     Debut: ${formatTime(segment.start)} | Fin: ${formatTime(segment.end)} | Duree: ${formatTime(segment.end - segment.start)}\n`;
      // Filtrer les segments de transcription qui chevauchent ce segment video
      const segTranscript = currentTranscript.filter(t => t.start < segment.end && t.end > segment.start);
      if (segTranscript.length > 0) {
        content += '     Transcription:\n';
        segTranscript.forEach(t => { content += `     [${formatTime(t.start)}] ${t.text}\n`; });
      }
      content += '\n';
    });

    // Resume en bas du fichier
    content += '\n' + '-'.repeat(40) + '\n';
    content += `Total: ${segments.length} sequences | Duree totale: ${formatTime(segments.reduce((acc, s) => acc + (s.end - s.start), 0))}\n`;

    // Nom du fichier de sortie base sur le nom de la premiere video
    const defaultName = videoFiles.length > 0
      ? videoFiles[0].name.replace(/\.[^/.]+$/, '') + '_sequences.txt'
      : 'sequences.txt';

    // Envoyer au backend et telecharger
    const result = await api.exportText(content, defaultName);
    api.downloadExport(result.downloadUrl, defaultName);
  };

  /**
   * Exporte un fichier TXT "propre" avec uniquement le texte de la transcription,
   * organise par sequence (sans timecodes). Ideal pour la lecture.
   */
  const handleExportTxtPropre = async () => {
    setShowExportMenu(false);

    // Lancer la transcription si pas encore faite
    const hasTranscript = await ensureTranscript();
    if (!hasTranscript) return;
    const currentTranscript = useStore.getState().transcript;

    let content = '';
    if (segments.length > 0) {
      // Si des segments existent, organiser le texte par segment
      segments.forEach((segment, index) => {
        const segTranscript = currentTranscript.filter(t => t.start < segment.end && t.end > segment.start);
        if (segTranscript.length > 0) {
          content += `== ${String(index + 1).padStart(2, '0')}. ${segment.title} ==\n\n`;
          // Joindre tous les textes du segment en un seul paragraphe
          content += segTranscript.map(t => t.text).join(' ') + '\n\n';
        }
      });
    } else {
      // Pas de segments : tout le texte en un seul bloc
      content = currentTranscript.map(t => t.text).join(' ');
    }
    content = content.trim();

    const defaultName = videoFiles.length > 0
      ? videoFiles[0].name.replace(/\.[^/.]+$/, '') + '_transcription.txt'
      : 'transcription.txt';

    const result = await api.exportText(content, defaultName);
    api.downloadExport(result.downloadUrl, defaultName);
  };

  // Si aucune video n'est chargee, ne rien afficher
  if (videoFiles.length === 0) return null;

  // ── Rendu JSX du composant ──
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card border border-border rounded-xl shadow-sm flex flex-col h-full"
    >
      {/* ── En-tete du panneau : titre + boutons d'action ── */}
      <div className="panel-drag-handle flex items-center justify-between px-4 py-3 border-b border-border cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3 h-3 text-muted-foreground/40" />
          <Scissors className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold text-foreground">{segments.length} sequences</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Bouton pour ajouter un segment par defaut */}
          <Button variant="ghost" size="sm" onClick={handleAddDefault} className="h-7 w-7 p-0" title="Ajouter une sequence">
            <Plus className="w-3.5 h-3.5" />
          </Button>
          {/* Menu deroulant d'export (visible uniquement s'il y a des segments) */}
          {segments.length > 0 && (
            <div className="relative" ref={exportMenuRef}>
              <Button variant="default" size="sm" onClick={() => setShowExportMenu(!showExportMenu)} disabled={isExporting} className="h-7 px-2.5 gap-1 text-[10px] font-bold uppercase tracking-wider">
                <Film className="w-3 h-3" /> Export <ChevronDown className="w-3 h-3" />
              </Button>
              {/* Menu deroulant avec les 3 options d'export */}
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
                  <div className="border-t border-border my-1" />
                  <button
                    onClick={() => { setShowExportMenu(false); setShowSemanticAnalysis(true) }}
                    disabled={transcript.length === 0}
                    className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-primary/10 transition-colors flex items-center gap-2 text-primary disabled:opacity-50"
                  >
                    <Brain className="w-3.5 h-3.5" /> Analyse semantique
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Liste des segments avec drag & drop (Reorder de Framer Motion) ── */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {/* Reorder.Group permet le drag & drop pour reordonner les segments */}
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
              {/* Icone de grip pour le drag (visible au survol) */}
              <GripVertical className="w-3 h-3 text-muted-foreground/40 shrink-0 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity" />
              {/* Pastille de couleur du segment */}
              <div className="w-1.5 h-8 rounded-full shrink-0 shadow-sm" style={{ backgroundColor: seg.color || "hsl(var(--primary))" }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {/* Numero du segment */}
                  <span className="text-[9px] font-bold text-muted-foreground">{i + 1}</span>
                  {/* Champ de texte editable pour le titre du segment */}
                  <input type="text" value={seg.title} onChange={(e) => updateSegment(seg.id, { title: e.target.value })} onClick={(e) => e.stopPropagation()} className="bg-transparent text-xs font-semibold text-foreground outline-none w-full truncate hover:text-primary focus:text-primary transition-colors" placeholder="Nom du segment..." />
                </div>
                {/* Timecodes : debut, fin, duree */}
                <span className="text-[10px] text-muted-foreground font-mono">
                  {formatTime(seg.start)} — {formatTime(seg.end)} ({formatTime(seg.end - seg.start)})
                </span>
              </div>
              {/* Boutons d'action : lecture et suppression (visibles au survol ou quand selectionne) */}
              <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ${selectedSegmentId === seg.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" onClick={(e) => {
                  e.stopPropagation();
                  // Si on clique sur un segment non selectionne, le selectionner et lancer la lecture
                  if (selectedSegmentId !== seg.id) { setSelectedSegmentId(seg.id); setIsPlaying(true); }
                  // Si deja selectionne, toggle play/pause
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

        {/* Message affiche quand il n'y a aucun segment */}
        {segments.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Scissors className="w-8 h-8 text-muted-foreground/30 mb-3" />
            <p className="text-xs text-muted-foreground/60">Aucune sequence</p>
          </div>
        )}
      </div>

      {/* ── Section d'export rapide, visible quand les segments sont prets ── */}
      {(processingStep === 'done' || processingStep === 'ready') && segments.length > 0 && (
        <div className="border-t border-border p-3 space-y-2">
          <div className="flex items-center gap-2 text-green-400 mb-2">
            <CheckCircle className="w-4 h-4" />
            <span className="text-xs font-semibold">{segments.length} segments prets</span>
          </div>
          {/* Bouton principal : export video */}
          <Button variant="default" size="sm" onClick={handleExportVideo} disabled={isExporting} className="w-full gap-2 text-xs font-bold">
            <Film className="w-3.5 h-3.5" /> Exporter les videos
          </Button>
          {/* Boutons secondaires : export TXT */}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={handleExportTxtSequences} disabled={isTranscribing} className="gap-1.5 text-[10px]">
              {isTranscribing ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
              TXT timecodes
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportTxtPropre} disabled={isTranscribing} className="gap-1.5 text-[10px]">
              {isTranscribing ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
              TXT propre
            </Button>
          </div>
          {/* Bouton analyse semantique : nuage de mots, frequences, themes */}
          {transcript.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSemanticAnalysis(true)}
              className="w-full gap-1.5 text-[10px] border-primary/30 text-primary hover:bg-primary/10 mt-1"
            >
              <Brain className="w-3 h-3" /> Analyse semantique
            </Button>
          )}
        </div>
      )}

      {/* Modal d'analyse semantique (nuage de mots, frequences, themes IA) */}
      {showSemanticAnalysis && transcript.length > 0 && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowSemanticAnalysis(false)}>
          <div className="w-full max-w-4xl max-h-[85vh] overflow-auto m-4" onClick={e => e.stopPropagation()}>
            <SemanticAnalysis
              segments={transcript}
              ollamaModel={config.ollamaModel || 'mistral-nemo:12b'}
              onClose={() => setShowSemanticAnalysis(false)}
            />
          </div>
        </div>
      )}
    </motion.div>
  );
};

export default Timeline;

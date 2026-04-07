/**
 * EDITORLAYOUT.TSX : Disposition de l'éditeur NLE redimensionnable
 *
 * Ce fichier gère la mise en page principale de l'éditeur vidéo.
 * Il utilise une bibliothèque appelée "react-grid-layout" qui permet de créer
 * des panneaux que l'utilisateur peut déplacer et redimensionner librement,
 * un peu comme les fenêtres d'un logiciel de montage vidéo (Premiere Pro, DaVinci, etc.).
 *
 * L'éditeur contient 3 panneaux :
 * - VideoPreview : le lecteur vidéo (prévisualisation)
 * - Timeline : la liste des segments découpés par l'IA
 * - SegmentTimeline : une timeline visuelle avec la forme d'onde audio (waveform)
 *
 * La disposition choisie par l'utilisateur est sauvegardée dans le localStorage
 * du navigateur, pour qu'elle soit conservée entre les sessions.
 */

// --- Imports React ---
// useState : pour gérer l'état local (largeur du conteneur, disposition)
// useEffect : pour exécuter du code au montage du composant (mesure de la largeur)
// useRef : pour garder une référence vers l'élément DOM du conteneur
// useCallback : pour mémoriser des fonctions et éviter des re-rendus inutiles
import { useState, useEffect, useRef, useCallback } from "react";

// GridLayout : le composant principal de react-grid-layout qui crée la grille redimensionnable
// Layout : le type TypeScript qui décrit la position et taille d'un panneau dans la grille
import GridLayout, { Layout } from "react-grid-layout";

// RotateCcw : icône de flèche circulaire (reset) de la bibliothèque lucide-react
import { RotateCcw } from "lucide-react";

// Button : composant bouton réutilisable du design system de l'application (shadcn/ui)
import { Button } from "@/components/ui/button";

// Les trois composants qui constituent les panneaux de l'éditeur
import VideoPreview from "./VideoPreview";
import Timeline from "./Timeline";
import SegmentTimeline from "./SegmentTimeline";

// Feuilles de style CSS nécessaires pour que react-grid-layout fonctionne correctement
// (gestion du drag & drop et du redimensionnement visuel)
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

// --- Constantes de configuration de la grille ---

// Clé utilisée pour sauvegarder/charger la disposition dans le localStorage du navigateur
const STORAGE_KEY = "clipr-editor-layout";

// Nombre de colonnes dans la grille (12 est un standard courant, comme Bootstrap)
const COLS = 12;

// Hauteur en pixels d'une "unité de ligne" de la grille
// Si un panneau a h=5, sa hauteur sera environ 5 * 80 = 400px
const ROW_HEIGHT = 80;

// Espacement en pixels entre les panneaux de la grille
const GAP = 6;

/**
 * Disposition par défaut des trois panneaux.
 * Chaque objet décrit un panneau avec :
 * - i : identifiant unique du panneau (correspond aux clés de PANELS)
 * - x, y : position dans la grille (en unités de colonnes/lignes)
 * - w, h : largeur et hauteur (en unités de colonnes/lignes)
 * - minW, minH : taille minimale en dessous de laquelle on ne peut pas réduire
 *
 * Par défaut :
 * - "video" occupe 8 colonnes sur 12, en haut à gauche
 * - "segments" occupe 4 colonnes, à droite de la vidéo
 * - "timeline" occupe toute la largeur (12 colonnes), en dessous
 */
const DEFAULT_LAYOUT: Layout[] = [
  { i: "video", x: 0, y: 0, w: 8, h: 5, minW: 3, minH: 2 },
  { i: "segments", x: 8, y: 0, w: 4, h: 5, minW: 2, minH: 2 },
  { i: "timeline", x: 0, y: 5, w: 12, h: 3, minW: 4, minH: 2 },
];

/**
 * Table de correspondance entre l'identifiant d'un panneau et son composant React.
 * Cela permet de boucler dynamiquement sur les panneaux pour les afficher
 * sans avoir à écrire manuellement chaque composant dans le JSX.
 */
const PANELS: Record<string, { component: React.FC }> = {
  video: { component: VideoPreview },
  segments: { component: Timeline },
  timeline: { component: SegmentTimeline },
};

/**
 * Composant principal de l'éditeur.
 * Il mesure la largeur de son conteneur, charge la disposition sauvegardée,
 * et rend une grille react-grid-layout avec les trois panneaux.
 */
export default function EditorLayout() {
  // Référence vers l'élément HTML <div> qui contient toute la grille.
  // On en a besoin pour mesurer sa largeur réelle en pixels.
  const containerRef = useRef<HTMLDivElement>(null);

  // Largeur mesurée du conteneur en pixels. Initialisée à 0 car on ne connaît
  // pas encore la taille au premier rendu.
  const [width, setWidth] = useState(0);

  /**
   * État de la disposition des panneaux.
   * Au premier chargement, on essaie de récupérer une disposition sauvegardée
   * dans le localStorage. Si elle existe et contient bien 3 panneaux, on l'utilise.
   * Sinon, on utilise la disposition par défaut (DEFAULT_LAYOUT).
   */
  const [layout, setLayout] = useState<Layout[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // On vérifie que c'est bien un tableau de 3 éléments (nos 3 panneaux)
        if (Array.isArray(parsed) && parsed.length === 3) return parsed;
      }
    } catch { /* Si le JSON est corrompu, on ignore silencieusement */ }
    return DEFAULT_LAYOUT;
  });

  /**
   * Effet exécuté au montage du composant.
   * Il mesure la largeur du conteneur et met en place un ResizeObserver
   * pour recalculer la largeur chaque fois que la fenêtre est redimensionnée.
   * C'est nécessaire car react-grid-layout a besoin de la largeur en pixels
   * pour positionner correctement les panneaux.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Fonction qui met à jour la largeur à partir de l'élément DOM
    const update = () => setWidth(el.offsetWidth);
    update(); // Mesure initiale

    // ResizeObserver surveille les changements de taille de l'élément
    const observer = new ResizeObserver(update);
    observer.observe(el);

    // Nettoyage : on arrête d'observer quand le composant est démonté
    return () => observer.disconnect();
  }, []);

  /**
   * Callback appelé chaque fois que l'utilisateur déplace ou redimensionne un panneau.
   * On met à jour l'état local ET on sauvegarde dans le localStorage
   * pour que la disposition soit conservée au prochain chargement de la page.
   */
  const handleLayoutChange = useCallback((newLayout: Layout[]) => {
    setLayout(newLayout);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newLayout));
  }, []);

  /**
   * Réinitialise la disposition à la configuration par défaut.
   * Utile si l'utilisateur a "cassé" sa disposition et veut revenir à l'état initial.
   * On utilise le spread [...DEFAULT_LAYOUT] pour créer une copie et forcer un re-rendu.
   */
  const resetLayout = useCallback(() => {
    setLayout([...DEFAULT_LAYOUT]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_LAYOUT));
  }, []);

  // --- Rendu JSX ---
  return (
    // Conteneur principal qui prend toute la hauteur de l'écran moins le header (3.5rem)
    <div ref={containerRef} className="relative min-h-[calc(100vh-3.5rem)]">
      {/* On ne rend la grille que quand la largeur est connue (> 0),
          sinon react-grid-layout ne pourrait pas calculer les positions */}
      {width > 0 && (
        <GridLayout
          layout={layout}            // Disposition actuelle des panneaux
          cols={COLS}                 // Nombre de colonnes de la grille
          rowHeight={ROW_HEIGHT}      // Hauteur d'une unité de ligne
          width={width}               // Largeur totale mesurée du conteneur
          margin={[GAP, GAP]}         // Espacement horizontal et vertical entre panneaux
          containerPadding={[GAP, GAP]} // Padding autour de la grille
          onLayoutChange={handleLayoutChange} // Sauvegarde à chaque changement
          draggableHandle=".panel-drag-handle" // Seuls les éléments avec cette classe CSS permettent le drag
          isResizable                 // Active le redimensionnement des panneaux
          isDraggable                 // Active le déplacement des panneaux
          useCSSTransforms            // Utilise les transformations CSS pour de meilleures performances
          resizeHandles={["se", "sw", "ne", "nw", "e", "w", "n", "s"]} // Poignées de redimensionnement sur tous les bords et coins
        >
          {/* On boucle sur les panneaux définis dans PANELS et on rend chaque composant */}
          {Object.entries(PANELS).map(([key, panel]) => (
            <div key={key} className="h-full">
              <panel.component />
            </div>
          ))}
        </GridLayout>
      )}

      {/* Bouton de réinitialisation de la disposition, fixé en bas à droite.
          pointer-events-none sur le conteneur + pointer-events-auto sur le bouton
          permet au bouton d'être cliquable sans bloquer les interactions avec la grille */}
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

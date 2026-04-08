/**
 * MANUALSEGMENTPANEL.TSX : Panneau de découpage manuel des segments vidéo
 *
 * Ce composant permet à l'utilisateur d'ajouter des segments à la main,
 * en définissant un titre, un temps de début et un temps de fin.
 * Il propose aussi des raccourcis rapides (+30s, +1min, +2min, +5min)
 * pour créer des segments de durée prédéfinie en un seul clic.
 *
 * Utilisé dans le mode "Découpe manuelle" de l'application (par opposition
 * au mode "Analyse IA" qui découpe automatiquement).
 */

import { useState } from "react";
import { Scissors, Plus, Clock } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "@/store/useStore";
import { Button } from "@/components/ui/button";

/**
 * formatTime : convertit un nombre de secondes en chaîne lisible (ex: "1:23" ou "1:02:05").
 * Gère le format H:MM:SS si la durée dépasse 1 heure, sinon M:SS.
 *
 * @param seconds - Le temps en secondes à formater
 * @returns La chaîne formatée, par ex. "3:45" pour 225 secondes
 */
function formatTime(seconds: number): string {
  // Calcul des heures, minutes et secondes à partir du total en secondes
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  // Si on dépasse 1 heure, on affiche le format H:MM:SS
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;

  // Sinon, format court M:SS
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * parseTime : convertit une chaîne de temps (ex: "1:30" ou "1:02:05") en nombre de secondes.
 * Accepte les formats M:SS et H:MM:SS.
 *
 * @param str - La chaîne de temps saisie par l'utilisateur
 * @returns Le temps en secondes (nombre entier)
 */
function parseTime(str: string): number {
  // On découpe la chaîne par ":" et on convertit chaque partie en nombre
  const parts = str.split(":").map(Number);

  // Format H:MM:SS → heures * 3600 + minutes * 60 + secondes
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];

  // Format M:SS → minutes * 60 + secondes
  if (parts.length === 2) return parts[0] * 60 + parts[1];

  // Si un seul nombre, on le prend tel quel (en secondes)
  return parts[0] || 0;
}

/**
 * ManualSegmentPanel : Composant principal du panneau de découpe manuelle.
 *
 * Il se compose de 3 sections :
 *   1. Un formulaire pour saisir titre + début + fin d'un segment
 *   2. Des boutons raccourcis pour créer rapidement un segment de durée fixe
 *   3. Un bloc d'information affichant la durée totale et le pourcentage couvert
 */
const ManualSegmentPanel = () => {
  // Récupération des données et actions depuis le store global Zustand
  const { videoFiles, segments, addSegment, getTotalDuration } = useStore();

  // Durée totale de toutes les vidéos combinées (en secondes)
  const totalDuration = getTotalDuration();

  // États locaux du formulaire : titre, début et fin du segment à créer
  const [title, setTitle] = useState("");
  const [startStr, setStartStr] = useState("");
  const [endStr, setEndStr] = useState("");

  // Calcul de la fin du dernier segment existant.
  // Cela sert de valeur par défaut pour le début du prochain segment
  // (on enchaîne les segments les uns après les autres).
  const lastEnd = segments.length > 0 ? Math.max(...segments.map(s => s.end)) : 0;

  /**
   * handleAdd : Ajoute un nouveau segment au store quand l'utilisateur clique sur "Ajouter".
   *
   * - Si aucun début n'est saisi, on prend la fin du dernier segment (enchaînement)
   * - Si aucune fin n'est saisie, on ajoute 60 secondes par défaut
   * - On vérifie que le segment est valide (fin > début, début < durée totale)
   * - Le segment reçoit un UUID unique via crypto.randomUUID()
   */
  const handleAdd = () => {
    // Pas de vidéo importée → on ne peut pas ajouter de segment
    if (videoFiles.length === 0) return;

    // Conversion des chaînes saisies en secondes, avec valeurs par défaut
    const start = startStr ? parseTime(startStr) : lastEnd;
    const end = endStr ? parseTime(endStr) : Math.min(start + 60, totalDuration);

    // Validation : la fin doit être après le début, et le début dans les bornes
    if (end <= start || start >= totalDuration) return;

    // Ajout du segment dans le store global
    addSegment({
      id: crypto.randomUUID(), // Génère un identifiant unique universel
      title: title.trim() || `Sequence ${segments.length + 1}`, // Titre par défaut si vide
      start: Math.max(0, start), // On empêche un début négatif
      end: Math.min(end, totalDuration), // On empêche une fin au-delà de la durée totale
      color: "", // La couleur sera attribuée automatiquement par la timeline
      transcriptSegments: [], // Pas de transcription en mode manuel
    });

    // Réinitialisation du formulaire après l'ajout
    setTitle("");
    setStartStr("");
    setEndStr("");
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }} // Animation d'entrée : glissement depuis la droite
      animate={{ opacity: 1, x: 0 }}
      className="space-y-6"
    >
      {/* =====================================================
          SECTION 1 : Formulaire d'ajout d'un segment
          ===================================================== */}
      <div className="space-y-3">
        {/* Label du formulaire avec icône ciseaux */}
        <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Scissors className="w-3.5 h-3.5" /> Ajouter un segment
        </label>

        {/* Champ de saisie du titre du segment */}
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Sequence ${segments.length + 1}`}
          className="w-full bg-secondary/10 text-xs text-foreground px-3 py-2.5 rounded-lg border border-border focus:ring-1 focus:ring-primary outline-none"
        />

        {/* Champs Début / Fin côte à côte dans une grille 2 colonnes */}
        <div className="grid grid-cols-2 gap-3">
          {/* Champ "Début" : temps de départ du segment */}
          <div className="bg-secondary/30 p-3 rounded-lg border border-border">
            <span className="text-[9px] font-bold text-muted-foreground uppercase block mb-1.5">Debut</span>
            <input
              type="text"
              value={startStr}
              onChange={(e) => setStartStr(e.target.value)}
              placeholder={formatTime(lastEnd)} // Placeholder = fin du dernier segment
              className="w-full bg-transparent text-xs font-semibold text-foreground outline-none font-mono"
            />
          </div>
          {/* Champ "Fin" : temps de fin du segment */}
          <div className="bg-secondary/30 p-3 rounded-lg border border-border">
            <span className="text-[9px] font-bold text-muted-foreground uppercase block mb-1.5">Fin</span>
            <input
              type="text"
              value={endStr}
              onChange={(e) => setEndStr(e.target.value)}
              placeholder={formatTime(Math.min(lastEnd + 60, totalDuration))} // +60s par défaut
              className="w-full bg-transparent text-xs font-semibold text-foreground outline-none font-mono"
            />
          </div>
        </div>

        {/* Indication du format de saisie attendu */}
        <p className="text-[10px] text-muted-foreground">Format : M:SS ou H:MM:SS</p>
      </div>

      {/* =====================================================
          BOUTON D'AJOUT PRINCIPAL
          Désactivé si aucune vidéo n'est chargée
          ===================================================== */}
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

      {/* =====================================================
          SECTION 2 : Raccourcis rapides
          Crée un segment de durée fixe (30s, 60s, 2min, 5min)
          en un seul clic, sans remplir le formulaire.
          ===================================================== */}
      <div className="space-y-3">
        <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" /> Raccourcis
        </label>

        <div className="grid grid-cols-2 gap-2">
          {/* On itère sur les durées prédéfinies : 30s, 60s, 120s, 300s */}
          {[30, 60, 120, 300].map((dur) => (
            <button
              key={dur}
              onClick={() => {
                // Le nouveau segment commence là où le dernier s'est arrêté
                const start = lastEnd;
                // La fin = début + durée souhaitée, sans dépasser la durée totale
                const end = Math.min(start + dur, totalDuration);

                // On ne crée le segment que si la fin est bien après le début
                if (end > start) {
                  addSegment({
                    id: crypto.randomUUID(),
                    title: `Sequence ${segments.length + 1}`,
                    start, end,
                    color: "", transcriptSegments: [],
                  });
                }
              }}
              disabled={lastEnd >= totalDuration} // Désactivé si toute la durée est déjà couverte
              className="px-3 py-2 text-xs font-medium bg-secondary/20 hover:bg-secondary/40 text-foreground rounded-lg border border-border transition-colors disabled:opacity-30"
            >
              {/* Affichage : "+30s", "+1min", "+2min", "+5min" */}
              +{dur >= 60 ? `${dur / 60}min` : `${dur}s`}
            </button>
          ))}
        </div>
      </div>

      {/* =====================================================
          SECTION 3 : Bloc d'information
          Affiche la durée totale des vidéos et le pourcentage
          de temps déjà couvert par les segments existants.
          ===================================================== */}
      <div className="p-4 bg-secondary/5 rounded-xl border border-border">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Decoupe manuelle : definir les bornes de chaque segment. Les segments apparaissent dans la liste a gauche une fois ajoutes.
        </p>
        {totalDuration > 0 && (
          <p className="text-[10px] text-muted-foreground/60 mt-2 font-mono">
            {/* Affiche la durée totale, le temps couvert et le pourcentage */}
            Duree totale : {formatTime(totalDuration)} | Couvert : {formatTime(lastEnd)} ({Math.round(lastEnd / totalDuration * 100)}%)
          </p>
        )}
      </div>
    </motion.div>
  );
};

export default ManualSegmentPanel;

/**
 * PROGRESSPANEL.TSX : Overlay de progression du traitement
 *
 * Ce composant affiche un panneau modal en plein écran (overlay) pendant
 * les opérations longues de l'application. Il recouvre toute l'interface
 * pour informer l'utilisateur de ce qui se passe en arrière-plan.
 *
 * Les étapes possibles du traitement sont :
 * - extracting-audio : extraction de la piste audio depuis la vidéo
 * - transcribing : transcription de l'audio en texte via Whisper
 * - analyzing : analyse sémantique du texte par le LLM (Ollama)
 * - exporting : export des segments vidéo découpés
 *
 * Le panneau affiche :
 * - L'icône et le libellé de l'étape en cours
 * - Une barre de progression animée avec le pourcentage
 * - Un aperçu en temps réel de la transcription (pendant l'étape Whisper)
 * - Un bouton "Passer en arrière-plan" pour continuer à utiliser l'app
 * - Un bouton "Redémarrer" en cas d'erreur
 */

// Store global Zustand : contient l'état du traitement (étape, progression, transcription)
import { useStore } from "@/store/useStore";

// Framer Motion : bibliothèque d'animations
// motion : composants animés, AnimatePresence : gère l'entrée/sortie des éléments
import { motion, AnimatePresence } from "framer-motion";

// Icônes représentant les différentes étapes et états
// Loader2 : spinner de chargement (étape par défaut)
// Music : note de musique (extraction audio)
// MessageSquare : bulle de texte (transcription)
// Sparkles : étoiles (analyse IA)
// AlertCircle : triangle d'alerte (erreur)
// CheckCircle2 : coche dans un cercle (terminé)
// Download : flèche vers le bas (export)
// Clock : horloge (file d'attente)
// ArrowDownToLine : flèche vers le bas avec ligne (passer en arrière-plan)
import { Loader2, Music, MessageSquare, Sparkles, AlertCircle, CheckCircle2, Download, Clock, ArrowDownToLine } from "lucide-react";

// Composant bouton du design system
import { Button } from "@/components/ui/button";

/**
 * Table de correspondance : étape de traitement -> libellé affiché.
 * Chaque clé correspond à une valeur possible de processingStep dans le store.
 * Les valeurs sont les textes affichés en gros titre dans le panneau.
 */
const STEP_LABELS: Record<string, string> = {
    idle: "En attente",
    queued: "En file d'attente",
    "extracting-audio": "Extraction audio",
    transcribing: "Transcription (Whisper)",
    analyzing: "Analyse IA (Ollama)",
    ready: "Prêt",
    exporting: "Export des segments",
    done: "Terminé",
    error: "Erreur",
};

/**
 * Table de correspondance : étape de traitement -> composant d'icône.
 * Chaque étape a une icône spécifique pour un repère visuel rapide.
 * Si l'étape n'a pas d'icône définie ici, on utilise Loader2 (spinner) par défaut.
 */
const STEP_ICONS: Record<string, any> = {
    queued: Clock,
    "extracting-audio": Music,
    transcribing: MessageSquare,
    analyzing: Sparkles,
    exporting: Download,
    done: CheckCircle2,
    error: AlertCircle,
};

/**
 * Composant ProgressPanel : overlay modal de progression.
 * Se rend par-dessus toute l'application pendant un traitement.
 */
const ProgressPanel = () => {
    // --- Extraction de l'état global depuis le store ---
    // processingStep : étape actuelle du traitement ("idle", "transcribing", etc.)
    // progress : pourcentage de progression (0 à 100)
    // progressMessage : message textuel décrivant l'action en cours
    // transcript : tableau des segments transcrits (texte reconnu par Whisper)
    // reset : fonction pour réinitialiser l'état et revenir à l'écran principal
    const { processingStep, progress, progressMessage, transcript, reset } = useStore();

    // --- Drapeaux dérivés pour le rendu conditionnel ---
    // isError : vrai si le traitement a échoué
    const isError = processingStep === "error";

    // isDone : vrai si le traitement est terminé avec succès
    const isDone = processingStep === "done";

    // Icon : le composant d'icône à afficher, dépend de l'étape actuelle
    // Si l'étape n'a pas d'icône définie, on utilise le spinner Loader2
    const Icon = STEP_ICONS[processingStep] || Loader2;

    // Si aucun traitement n'est en cours ("idle" ou "ready"), on ne rend rien du tout.
    // Le panneau est complètement masqué dans ces états.
    if (processingStep === "idle" || processingStep === "ready") return null;

    // --- Rendu : overlay modal plein écran avec progression ---
    return (
        // Overlay plein écran : couvre toute la page avec un fond semi-transparent et un flou
        // z-50 : z-index élevé pour passer au-dessus de tout sauf le header
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-6">
            {/* Carte centrale animée (apparaît avec un fondu et un léger zoom) */}
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-lg bg-card border border-border rounded-xl p-8 shadow-xl relative overflow-hidden text-center"
            >
                <div className="flex flex-col items-center relative z-10">
                    {/* Grande icône de l'étape en cours */}
                    {/* En cas d'erreur : fond rouge. Sinon : fond de la couleur primaire.
                        L'animation pulse rend l'icône plus vivante pendant le traitement. */}
                    <div className={`w-16 h-16 rounded-xl flex items-center justify-center mb-6 border ${isError ? "bg-destructive/10 text-destructive border-destructive/20" : "bg-primary/10 text-primary border-primary/20"
                        }`}>
                        <Icon className={`w-8 h-8 ${!isError && !isDone ? "animate-pulse" : ""}`} />
                    </div>

                    {/* Titre de l'étape en cours (ex: "Transcription (Whisper)") */}
                    <h2 className={`text-xl font-bold mb-2 ${isError ? "text-destructive" : "text-foreground"}`}>
                        {STEP_LABELS[processingStep] || processingStep}
                    </h2>

                    {/* Message de progression détaillé (ex: "Traitement segment 3/12...") */}
                    <p className="text-sm text-muted-foreground mb-8">
                        {progressMessage || "Traitement en cours..."}
                    </p>

                    {/* ===== Barre de progression (masquée en cas d'erreur) ===== */}
                    {!isError && (
                        <div className="w-full space-y-4">
                            {/* Labels "Progression" et pourcentage */}
                            <div className="flex justify-between text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                                <span>Progression</span>
                                <span>{Math.round(progress)}%</span>
                            </div>

                            {/* Barre de progression animée via Framer Motion */}
                            <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                                <motion.div
                                    className="h-full bg-primary"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${progress}%` }}
                                    transition={{ duration: 0.5 }}
                                />
                            </div>

                            {/* ===== Aperçu en temps réel de la transcription ===== */}
                            {/* Visible uniquement pendant l'étape "transcribing" et si du texte a été reconnu.
                                AnimatePresence gère les animations d'entrée/sortie de ce bloc. */}
                            <AnimatePresence mode="wait">
                                {processingStep === "transcribing" && transcript.length > 0 && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        className="bg-secondary/50 rounded-lg p-4 text-left border border-border mt-4"
                                    >
                                        {/* Indicateur "Transcription en cours" avec pastille animée */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                                            <span className="text-[10px] font-bold uppercase text-muted-foreground">Transcription en cours</span>
                                        </div>
                                        {/* Affiche les 2 derniers segments transcrits en italique */}
                                        {/* slice(-2) prend les 2 derniers éléments du tableau */}
                                        <div className="space-y-1">
                                            {transcript.slice(-2).map((seg) => (
                                                <p key={seg.id} className="text-xs text-foreground/80 italic leading-relaxed">
                                                    "{seg.text}"
                                                </p>
                                            ))}
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    )}

                    {/* ===== Bouton "Redémarrer" affiché en cas d'erreur ===== */}
                    {/* Recharge complètement la page pour repartir de zéro */}
                    {isError && (
                        <Button
                            variant="destructive"
                            onClick={() => window.location.reload()}
                            className="mt-4 px-6"
                        >
                            Redémarrer
                        </Button>
                    )}

                    {/* ===== Bouton "Passer en arrière-plan" ===== */}
                    {/* Permet de fermer l'overlay et continuer à utiliser l'app
                        pendant que l'analyse tourne en arrière-plan.
                        Non affiché en cas d'erreur, quand c'est terminé, ou pendant l'export. */}
                    {!isError && !isDone && processingStep !== 'exporting' && (
                        <button
                            onClick={reset}
                            className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mx-auto"
                            title="L'analyse continue en arrière-plan"
                        >
                            <ArrowDownToLine className="w-3.5 h-3.5" />
                            Passer en arrière-plan
                        </button>
                    )}
                </div>
            </motion.div>
        </div>
    );
};

export default ProgressPanel;

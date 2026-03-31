/**
 * PROGRESSPANEL.TSX : Overlay de progression du traitement
 *
 * Affiche un panneau modal plein écran pendant les opérations longues
 * (extraction audio, transcription, analyse IA, export). Montre l'étape
 * en cours, la barre de progression et un aperçu en temps réel de la
 * transcription pendant l'étape Whisper.
 */

import { useStore } from "@/store/useStore";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Music, MessageSquare, Sparkles, AlertCircle, CheckCircle2, Download, Clock, ArrowDownToLine } from "lucide-react";
import { Button } from "@/components/ui/button";

// Libellés affichés pour chaque étape du traitement
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

// Icônes associées à chaque étape du traitement
const STEP_ICONS: Record<string, any> = {
    queued: Clock,
    "extracting-audio": Music,
    transcribing: MessageSquare,
    analyzing: Sparkles,
    exporting: Download,
    done: CheckCircle2,
    error: AlertCircle,
};

const ProgressPanel = () => {
    // --- Etat global depuis le store ---
    const { processingStep, progress, progressMessage, transcript, reset } = useStore();

    // Drapeaux dérivés pour le rendu conditionnel
    const isError = processingStep === "error";
    const isDone = processingStep === "done";
    const Icon = STEP_ICONS[processingStep] || Loader2;

    // Ne rien afficher si aucun traitement n'est en cours
    if (processingStep === "idle" || processingStep === "ready") return null;

    // --- Rendu : overlay modal avec progression ---
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-6">
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-lg bg-card border border-border rounded-xl p-8 shadow-xl relative overflow-hidden text-center"
            >
                <div className="flex flex-col items-center relative z-10">
                    <div className={`w-16 h-16 rounded-xl flex items-center justify-center mb-6 border ${isError ? "bg-destructive/10 text-destructive border-destructive/20" : "bg-primary/10 text-primary border-primary/20"
                        }`}>
                        <Icon className={`w-8 h-8 ${!isError && !isDone ? "animate-pulse" : ""}`} />
                    </div>

                    <h2 className={`text-xl font-bold mb-2 ${isError ? "text-destructive" : "text-foreground"}`}>
                        {STEP_LABELS[processingStep] || processingStep}
                    </h2>

                    <p className="text-sm text-muted-foreground mb-8">
                        {progressMessage || "Traitement en cours..."}
                    </p>

                    {!isError && (
                        <div className="w-full space-y-4">
                            <div className="flex justify-between text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                                <span>Progression</span>
                                <span>{Math.round(progress)}%</span>
                            </div>

                            <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                                <motion.div
                                    className="h-full bg-primary"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${progress}%` }}
                                    transition={{ duration: 0.5 }}
                                />
                            </div>

                            <AnimatePresence mode="wait">
                                {processingStep === "transcribing" && transcript.length > 0 && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        className="bg-secondary/50 rounded-lg p-4 text-left border border-border mt-4"
                                    >
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                                            <span className="text-[10px] font-bold uppercase text-muted-foreground">Transcription en cours</span>
                                        </div>
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

                    {isError && (
                        <Button
                            variant="destructive"
                            onClick={() => window.location.reload()}
                            className="mt-4 px-6"
                        >
                            Redémarrer
                        </Button>
                    )}

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

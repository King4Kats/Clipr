/**
 * AIANALYSISPANEL.TSX : Panneau de configuration et lancement de l'analyse IA
 *
 * Interface permettant à l'utilisateur de configurer les paramètres d'analyse
 * (modèle LLM, langue, modèle Whisper, consignes de découpage) et de lancer
 * le workflow complet : extraction audio → transcription → analyse sémantique.
 * Affiche aussi la progression en temps réel.
 */

import { useState, useEffect } from "react";
import { Brain, Sparkles, Settings2, MessageSquareText, Lock, HelpCircle } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "@/store/useStore";
import { useAuthStore } from "@/store/useAuthStore";
import { Button } from "@/components/ui/button";
import api from "@/api";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";

const InfoTip = ({ text }: { text: string }) => (
  <span className="relative group/tip inline-flex">
    <HelpCircle className="w-3 h-3 text-muted-foreground/50 cursor-help" />
    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-popover border border-border rounded-lg text-[10px] text-foreground leading-relaxed w-56 shadow-lg opacity-0 pointer-events-none group-hover/tip:opacity-100 group-hover/tip:pointer-events-auto transition-opacity z-50">
      {text}
    </span>
  </span>
);

const AIAnalysisPanel = () => {
  // --- Etat global depuis le store (vidéos, config, progression) ---
  const {
    videoFiles,
    config,
    updateConfig,
    processingStep,
    progress,
    progressMessage,
  } = useStore();

  const { user } = useAuthStore();

  // --- Etat local ---
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<string>("Vérification...");
  const [aiLock, setAiLock] = useState<{ locked: boolean; lock: any }>({ locked: false, lock: null });

  // --- Effet : vérifie Ollama + statut AI lock ---
  useEffect(() => {
    const checkModels = async () => {
      try {
        const running = await (window as any).electron.checkOllama();
        if (running) {
          const models = await (window as any).electron.listOllamaModels();
          setAvailableModels(models);
          setModelsReady(models.length > 0);
          setOllamaStatus(models.length > 0 ? "Ollama prêt" : "Aucun modèle trouvé");
          if (models.length > 0 && (!config.ollamaModel || !models.includes(config.ollamaModel))) {
            updateConfig({ ollamaModel: models[0] });
          }
        } else {
          setModelsReady(false);
          setOllamaStatus("Ollama non détecté");
        }
      } catch (e) {
        setModelsReady(false);
        setOllamaStatus("Erreur Ollama");
      }
    };
    const checkAiLock = async () => {
      try {
        const status = await api.getAiStatus();
        setAiLock(status);
      } catch { /* ignore */ }
    };
    checkModels();
    checkAiLock();

    // Poll AI lock status every 15s
    const interval = setInterval(checkAiLock, 15000);
    return () => clearInterval(interval);
  }, []);

  // Détermine si un traitement est en cours (empêche les interactions)
  const isProcessing =
    processingStep !== "idle" &&
    processingStep !== "ready" &&
    processingStep !== "done" &&
    processingStep !== "error";

  // Lance le workflow d'analyse complet (extraction audio + transcription + analyse IA)
  const handleStart = async () => {
    if (videoFiles.length === 0) return;
    await useStore.getState().triggerAnalysis();
  };

  // --- Rendu JSX ---
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.4 }}
      className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col h-full space-y-6"
    >
      {/* En-tête : titre et statut Ollama */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Assistant IA</h2>
        </div>
        <div className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${modelsReady ? "bg-primary/10 text-primary border border-primary/20" : "bg-destructive/10 text-destructive border border-destructive/20"}`}>
          {ollamaStatus}
        </div>
      </div>

      {/* AI Lock banner */}
      {aiLock.locked && aiLock.lock?.user_id !== user?.id && (
        <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <Lock className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-400 font-medium">
            IA utilisée par <span className="font-bold">{aiLock.lock?.username}</span> sur "{aiLock.lock?.project_name}"
          </p>
        </div>
      )}

      {/* --- Zone de configuration scrollable --- */}
      <div className="space-y-6 flex-1 overflow-y-auto pr-2 custom-scrollbar">
        {/* Sélecteurs : modèle LLM, langue et modèle Whisper */}
        <div className="space-y-3">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5" /> Modèle & Langue
          </label>

          <div className="flex flex-col gap-3">
            {/* Modele LLM */}
            <div className="bg-secondary/30 p-3 rounded-lg border border-border">
              <span className="text-[9px] font-bold text-muted-foreground uppercase mb-1.5 flex items-center gap-1.5">Modèle LLM <InfoTip text="L'IA qui analyse la transcription et cree les chapitres thematiques. Plus le modele est gros, meilleure est l'analyse mais plus c'est lent." /></span>
              <Select
                value={config.ollamaModel}
                onValueChange={(v) => updateConfig({ ollamaModel: v })}
                disabled={isProcessing}
              >
                <SelectTrigger className="h-auto w-full border-0 bg-transparent p-0 text-xs font-semibold text-foreground shadow-none focus:ring-0 focus:ring-offset-0">
                  <SelectValue placeholder="Chargement..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {availableModels.map((m: string) => (
                    <SelectItem key={m} value={m} className="text-xs font-mono cursor-pointer">
                      {m}
                    </SelectItem>
                  ))}
                  {availableModels.length === 0 && (
                    <SelectItem value="__loading" disabled className="text-xs text-muted-foreground">
                      Chargement...
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Langue */}
              <div className="bg-secondary/30 p-3 rounded-lg border border-border">
                <span className="text-[9px] font-bold text-muted-foreground uppercase mb-1.5 flex items-center gap-1.5">Langue <InfoTip text="La langue principale parlee dans la video. Aide Whisper a mieux reconnaitre les mots." /></span>
                <Select
                  value={config.language}
                  onValueChange={(v) => updateConfig({ language: v })}
                  disabled={isProcessing}
                >
                  <SelectTrigger className="h-auto w-full border-0 bg-transparent p-0 text-xs font-semibold text-foreground shadow-none focus:ring-0 focus:ring-offset-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="fr" className="text-xs cursor-pointer">Fran&ccedil;ais</SelectItem>
                    <SelectItem value="en" className="text-xs cursor-pointer">Anglais</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Whisper */}
              <div className="bg-secondary/30 p-3 rounded-lg border border-border">
                <span className="text-[9px] font-bold text-muted-foreground uppercase mb-1.5 flex items-center gap-1.5">Whisper <InfoTip text="Le modele de reconnaissance vocale. Large V3 = meilleure qualite (accents, patois). Large V3 Turbo = plus rapide mais legerement moins precis." /></span>
                <Select
                  value={config.whisperModel}
                  onValueChange={(v) => updateConfig({ whisperModel: v as any })}
                  disabled={isProcessing}
                >
                  <SelectTrigger className="h-auto w-full border-0 bg-transparent p-0 text-xs font-semibold text-foreground shadow-none focus:ring-0 focus:ring-offset-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="base" className="text-xs cursor-pointer">Base</SelectItem>
                    <SelectItem value="small" className="text-xs cursor-pointer">Small</SelectItem>
                    <SelectItem value="medium" className="text-xs cursor-pointer">Medium</SelectItem>
                    <SelectItem value="large-v3" className="text-xs cursor-pointer">Large V3</SelectItem>
                    <SelectItem value="large-v3-turbo" className="text-xs cursor-pointer">Large V3 Turbo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        {/* Zone de texte : consignes de découpage personnalisées */}
        <div className="space-y-3">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Settings2 className="w-3.5 h-3.5" /> Consignes de découpage <InfoTip text="Dites a l'IA comment decouper votre video. Ex: 'Fais un chapitre par theme aborde', 'Ignore les silences', 'Concentre-toi sur les anecdotes'..." />
          </label>
          <textarea
            value={config.context}
            onChange={(e) => updateConfig({ context: e.target.value })}
            placeholder="Ex: 'Podcast tech, coupe tous les silences et concentre-toi sur les questions du public...'"
            className="w-full h-32 bg-secondary/10 text-xs text-foreground p-3 rounded-lg border border-border focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-muted-foreground/30 leading-relaxed resize-none"
          />
        </div>

        {/* Zone de texte : vocabulaire de domaine pour Whisper */}
        <div className="space-y-3">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <MessageSquareText className="w-3.5 h-3.5" /> Vocabulaire Whisper <InfoTip text="Ajoutez ici les mots rares que Whisper pourrait mal reconnaitre : noms propres, noms de lieux, patois, termes techniques, mots en langue regionale... Cela ameliore beaucoup la precision de la transcription." />
          </label>
          <textarea
            value={config.whisperPrompt}
            onChange={(e) => updateConfig({ whisperPrompt: e.target.value })}
            placeholder="Mots-clés et vocabulaire de domaine pour améliorer la reconnaissance vocale (noms propres, patois, termes techniques...)"
            className="w-full h-24 bg-secondary/10 text-xs text-foreground p-3 rounded-lg border border-border focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-muted-foreground/30 leading-relaxed resize-none"
          />
          <p className="text-[9px] text-muted-foreground/50">
            Liste de mots, noms de lieux, patois ou termes techniques pour guider la transcription.
          </p>
        </div>

        {/* Encart informatif : description du workflow IA */}
        <div className="p-4 bg-primary/5 rounded-xl border border-primary/10 flex gap-4">
          <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary shrink-0">
            <Brain className="w-4 h-4" />
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed font-medium">
            L'IA va extraire l'audio, transcrire la voix et générer automatiquement des chapitres thématiques.
          </p>
        </div>
      </div>

      {/* --- Pied de panneau : barre de progression ou bouton de lancement --- */}
      <div className="pt-4 border-t border-border mt-auto">
        {isProcessing ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground">
              <span className="text-primary animate-pulse uppercase tracking-wider">{progressMessage}</span>
              <span className="font-mono">{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                className="h-full bg-primary"
              />
            </div>
          </div>
        ) : (
          <Button
            onClick={handleStart}
            disabled={videoFiles.length === 0 || !modelsReady || (aiLock.locked && aiLock.lock?.user_id !== user?.id)}
            className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-bold uppercase tracking-wide rounded-lg"
          >
            <span className="flex items-center gap-2">
              {aiLock.locked && aiLock.lock?.user_id !== user?.id ? (
                <>
                  <Lock className="w-4 h-4" />
                  IA indisponible
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Lancer l'analyse
                </>
              )}
            </span>
          </Button>
        )}
      </div>
    </motion.div>
  );
};

export default AIAnalysisPanel;

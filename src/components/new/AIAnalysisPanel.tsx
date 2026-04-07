/**
 * AIANALYSISPANEL.TSX : Panneau de configuration et lancement de l'analyse IA
 *
 * Ce fichier contient le composant qui permet à l'utilisateur de :
 * 1. Configurer les paramètres de l'analyse IA (modèle LLM, langue, modèle Whisper)
 * 2. Écrire des consignes personnalisées pour guider le découpage
 * 3. Ajouter du vocabulaire spécifique pour améliorer la reconnaissance vocale
 * 4. Lancer le workflow complet d'analyse
 *
 * Le workflow d'analyse se déroule en 3 étapes :
 * - Extraction audio : on extrait la piste son du fichier vidéo
 * - Transcription : Whisper (IA de reconnaissance vocale) convertit l'audio en texte
 * - Analyse sémantique : un LLM (via Ollama) analyse la transcription et découpe
 *   la vidéo en chapitres thématiques
 *
 * Le panneau affiche aussi la progression en temps réel pendant le traitement.
 */

// useState : pour gérer les états locaux (modèles disponibles, statut Ollama, etc.)
// useEffect : pour exécuter du code au montage (vérification Ollama, polling de la queue)
import { useState, useEffect } from "react";

// Icônes utilisées dans le panneau
// Brain : cerveau (IA), Sparkles : étoiles (lancement), Settings2 : engrenage (config),
// MessageSquareText : bulle de texte (vocabulaire), Lock : cadenas (verrouillage),
// HelpCircle : point d'interrogation (info-bulle), Clock : horloge (file d'attente)
import { Brain, Sparkles, Settings2, MessageSquareText, Lock, HelpCircle, Clock } from "lucide-react";

// Framer Motion : bibliothèque d'animations React (animations d'entrée du panneau)
import { motion } from "framer-motion";

// Store global Zustand de l'application (état vidéo, config, progression)
import { useStore } from "@/store/useStore";

// Store d'authentification (informations de l'utilisateur connecté)
import { useAuthStore } from "@/store/useAuthStore";

// Composant bouton du design system
import { Button } from "@/components/ui/button";

// Module API : contient les appels HTTP vers le serveur backend
import api from "@/api";

// Composants de sélection (dropdown) du design system shadcn/ui
// Select : conteneur du menu déroulant
// SelectTrigger : le bouton qui ouvre le menu
// SelectContent : le contenu du menu déroulant
// SelectItem : chaque option dans le menu
// SelectValue : affiche la valeur sélectionnée
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";

/**
 * Composant InfoTip : petite info-bulle d'aide (icône "?" avec texte au survol).
 * Utilisé à côté des labels pour expliquer chaque paramètre à l'utilisateur.
 *
 * @param text - Le texte explicatif à afficher dans la bulle
 */
const InfoTip = ({ text }: { text: string }) => {
  // show : contrôle l'affichage de la bulle (visible au survol de la souris)
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {/* Icône point d'interrogation */}
      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60 cursor-help hover:text-primary transition-colors" />
      {/* Bulle de texte positionnée au-dessus de l'icône */}
      {show && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-popover border border-border rounded-lg text-[11px] text-foreground leading-relaxed w-60 shadow-xl z-50">
          {text}
        </span>
      )}
    </span>
  );
};

/**
 * Composant principal du panneau d'analyse IA.
 * Gère la configuration, la vérification d'Ollama, et le lancement de l'analyse.
 */
const AIAnalysisPanel = () => {
  // --- Extraction de l'état global depuis le store Zustand ---
  // videoFiles : fichiers vidéo importés par l'utilisateur
  // config : configuration actuelle (modèle, langue, prompts, etc.)
  // updateConfig : fonction pour modifier la configuration
  // processingStep : étape actuelle du traitement ("idle", "transcribing", etc.)
  // progress : pourcentage de progression (0-100)
  // progressMessage : message textuel décrivant l'action en cours
  const {
    videoFiles,
    config,
    updateConfig,
    processingStep,
    progress,
    progressMessage,
  } = useStore();

  // Récupère les informations de l'utilisateur connecté
  const { user } = useAuthStore();

  // --- États locaux ---
  // modelsReady : null = pas encore vérifié, true = modèles trouvés, false = aucun modèle
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);

  // availableModels : liste des noms de modèles LLM disponibles dans Ollama
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // ollamaStatus : texte affiché dans le badge de statut (ex: "Ollama prêt", "Erreur Ollama")
  const [ollamaStatus, setOllamaStatus] = useState<string>("Vérification...");

  // queueState : état de la file d'attente IA sur le serveur
  // locked = true si l'IA est actuellement occupée par une tâche
  // lock = informations sur la tâche en cours (qui l'a lancée, etc.)
  const [queueState, setQueueState] = useState<{ locked: boolean; lock: any; queue?: any }>({ locked: false, lock: null });

  /**
   * Effet exécuté au montage du composant.
   * Il effectue deux vérifications :
   *
   * 1. checkModels : vérifie si Ollama (serveur local de LLM) est lancé
   *    et quels modèles sont disponibles. Si aucun modèle n'est trouvé,
   *    l'utilisateur ne pourra pas lancer l'analyse.
   *
   * 2. checkQueue : interroge le serveur pour connaître l'état de la file
   *    d'attente IA (est-ce qu'un autre utilisateur utilise déjà l'IA ?).
   *
   * Un polling toutes les 15 secondes est aussi mis en place pour la queue,
   * ainsi qu'un listener WebSocket pour les mises à jour en temps réel.
   */
  useEffect(() => {
    // Vérifie si Ollama est lancé et récupère la liste des modèles disponibles
    const checkModels = async () => {
      try {
        // Appel via l'API Electron pour vérifier si Ollama tourne
        const running = await (window as any).electron.checkOllama();
        if (running) {
          // Récupère la liste des modèles installés
          const models = await (window as any).electron.listOllamaModels();
          setAvailableModels(models);
          setModelsReady(models.length > 0);
          setOllamaStatus(models.length > 0 ? "Ollama prêt" : "Aucun modèle trouvé");

          // Si le modèle actuellement sélectionné n'existe plus dans la liste,
          // on sélectionne automatiquement le premier modèle disponible
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

    // Interroge le serveur pour l'état de la file d'attente IA
    const checkQueue = async () => {
      try {
        const status = await api.getAiStatus();
        setQueueState(status);
      } catch { /* On ignore les erreurs réseau silencieusement */ }
    };

    // Exécution immédiate des deux vérifications
    checkModels();
    checkQueue();

    // Polling : on re-vérifie l'état de la queue toutes les 15 secondes
    const interval = setInterval(checkQueue, 15000);

    // Écoute les mises à jour WebSocket de la queue en temps réel
    // (plus réactif que le polling seul)
    const unsubQueue = api.onQueueUpdate((data: any) => {
      if (data.queue) {
        setQueueState(prev => ({
          ...prev,
          locked: !!data.queue.currentTask,
          lock: data.queue.currentTask,
          queue: data.queue
        }));
      }
    });

    // Nettoyage : on arrête le polling et le listener WebSocket au démontage
    return () => { clearInterval(interval); unsubQueue(); };
  }, []);

  /**
   * Détermine si un traitement est en cours.
   * Quand c'est le cas, les sélecteurs sont désactivés pour empêcher
   * l'utilisateur de changer la configuration en plein milieu d'une analyse.
   */
  const isProcessing =
    processingStep !== "idle" &&
    processingStep !== "ready" &&
    processingStep !== "done" &&
    processingStep !== "error";

  /**
   * Lance le workflow d'analyse complet.
   * Cette fonction déclenche la chaîne : extraction audio -> transcription -> analyse IA.
   * Elle ne fait rien si aucune vidéo n'est chargée.
   */
  const handleStart = async () => {
    if (videoFiles.length === 0) return;
    // triggerAnalysis() est la fonction du store qui orchestre tout le workflow
    await useStore.getState().triggerAnalysis();
  };

  // --- Rendu JSX ---
  return (
    // Animation d'entrée : le panneau glisse depuis la droite avec un léger fondu
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.4 }}
      className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col h-full space-y-6"
    >
      {/* ===== En-tête du panneau : titre "Assistant IA" + badge statut Ollama ===== */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Assistant IA</h2>
        </div>
        {/* Badge coloré indiquant le statut d'Ollama (vert = prêt, rouge = erreur) */}
        <div className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${modelsReady ? "bg-primary/10 text-primary border border-primary/20" : "bg-destructive/10 text-destructive border border-destructive/20"}`}>
          {ollamaStatus}
        </div>
      </div>

      {/* ===== Bannière d'avertissement si l'IA est utilisée par un autre utilisateur ===== */}
      {/* S'affiche uniquement si la queue est verrouillée ET que ce n'est pas nous qui l'avons verrouillée */}
      {queueState.locked && queueState.lock?.user_id !== user?.id && (
        <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <Clock className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-400 font-medium">
            IA occupée{queueState.lock?.username ? <> par <span className="font-bold">{queueState.lock.username}</span></> : ''}
            {queueState.queue?.totalPending > 0 ? ` · ${queueState.queue.totalPending} tâche(s) en attente` : ''}
          </p>
        </div>
      )}

      {/* ===== Zone de configuration scrollable ===== */}
      {/* flex-1 + overflow-y-auto : cette zone prend tout l'espace disponible et scroll si nécessaire */}
      <div className="space-y-6 flex-1 overflow-y-auto pr-2 custom-scrollbar">

        {/* --- Sélecteurs : modèle LLM, langue et modèle Whisper --- */}
        <div className="space-y-3">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5" /> Modèle & Langue
          </label>

          <div className="flex flex-col gap-3">
            {/* Sélecteur du modèle LLM (ex: llama3, mistral, etc.) */}
            <div className="bg-secondary/30 p-3 rounded-lg border border-border">
              <span className="text-[9px] font-bold text-muted-foreground uppercase mb-1.5 flex items-center gap-1.5">Modèle LLM <InfoTip text="L'IA qui analyse la transcription et cree les chapitres thematiques. Plus le modele est gros, meilleure est l'analyse mais plus c'est lent." /></span>
              <Select
                value={config.ollamaModel}
                onValueChange={(v) => updateConfig({ ollamaModel: v })}
                disabled={isProcessing} // Désactivé pendant le traitement
              >
                <SelectTrigger className="h-auto w-full border-0 bg-transparent p-0 text-xs font-semibold text-foreground shadow-none focus:ring-0 focus:ring-offset-0">
                  <SelectValue placeholder="Chargement..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {/* On affiche chaque modèle trouvé dans Ollama */}
                  {availableModels.map((m: string) => (
                    <SelectItem key={m} value={m} className="text-xs font-mono cursor-pointer">
                      {m}
                    </SelectItem>
                  ))}
                  {/* Message de chargement si la liste est vide */}
                  {availableModels.length === 0 && (
                    <SelectItem value="__loading" disabled className="text-xs text-muted-foreground">
                      Chargement...
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Grille 2 colonnes pour la langue et le modèle Whisper */}
            <div className="grid grid-cols-2 gap-3">
              {/* Sélecteur de la langue de la vidéo */}
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

              {/* Sélecteur du modèle Whisper (qualité de la transcription) */}
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
                    {/* Les modèles vont du plus léger (base) au plus précis (large-v3) */}
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

        {/* --- Zone de texte : consignes de découpage personnalisées --- */}
        {/* L'utilisateur peut donner des instructions à l'IA pour guider le découpage */}
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

        {/* --- Zone de texte : vocabulaire spécifique pour Whisper --- */}
        {/* Permet d'ajouter des mots rares que Whisper pourrait mal transcrire */}
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

        {/* --- Encart informatif : résumé du workflow IA --- */}
        {/* Petit bloc d'information expliquant ce que l'IA va faire */}
        <div className="p-4 bg-primary/5 rounded-xl border border-primary/10 flex gap-4">
          <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary shrink-0">
            <Brain className="w-4 h-4" />
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed font-medium">
            L'IA va extraire l'audio, transcrire la voix et générer automatiquement des chapitres thématiques.
          </p>
        </div>
      </div>

      {/* ===== Pied du panneau : barre de progression ou bouton de lancement ===== */}
      {/* mt-auto : pousse ce bloc tout en bas du panneau grâce au flexbox */}
      <div className="pt-4 border-t border-border mt-auto">
        {/* Si un traitement est en cours, on affiche la barre de progression */}
        {isProcessing ? (
          <div className="space-y-3">
            {/* Message de progression + pourcentage */}
            <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground">
              <span className="text-primary animate-pulse uppercase tracking-wider">{progressMessage}</span>
              <span className="font-mono">{Math.round(progress)}%</span>
            </div>
            {/* Barre de progression animée */}
            <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                className="h-full bg-primary"
              />
            </div>
          </div>
        ) : (
          /* Sinon, on affiche le bouton pour lancer l'analyse */
          <Button
            onClick={handleStart}
            disabled={videoFiles.length === 0 || !modelsReady}
            className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-bold uppercase tracking-wide rounded-lg"
          >
            <span className="flex items-center gap-2">
              {/* Si l'IA est occupée par quelqu'un d'autre, on indique que la tâche sera mise en file d'attente */}
              {queueState.locked && queueState.lock?.user_id !== user?.id ? (
                <>
                  <Clock className="w-4 h-4" />
                  Lancer (file d'attente)
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

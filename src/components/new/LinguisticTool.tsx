/**
 * =============================================================================
 * Fichier : LinguisticTool.tsx
 * Rôle    : Outil de transcription linguistique (collectage patois/vernaculaire)
 *
 *           Cet outil est conçu pour les ethnolinguistes et collecteurs.
 *           Il permet de traiter des enregistrements de terrain où un meneur
 *           pose des questions en français et des informateurs répondent
 *           dans leur patois/langue régionale. Fonctionnalités :
 *
 *           - Upload d'un fichier audio ou vidéo
 *           - Traitement automatique via le pipeline linguistique côté serveur
 *           - Affichage des séquences : phrase FR du meneur + variantes patois
 *           - Transcription phonétique IPA (Allosaurus) de chaque variante
 *           - Écoute individuelle de chaque clip audio
 *           - Édition du texte français et de l'IPA
 *           - Renommage des locuteurs (intervenants)
 *           - Export en JSON ou CSV
 *           - Historique des transcriptions linguistiques passées
 * =============================================================================
 */

// ── Imports ──
import { useState, useCallback, useRef, useEffect } from "react"
import { Upload, BookOpen, Loader2, Play, Pause, Download, ArrowLeft, ChevronDown, Pencil, RotateCcw, Globe2, Check, Users, User } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { Button } from "@/components/ui/button"
import api from "@/api"
import type { LinguisticSequence, AlfPoint } from "@/types"
import AlfPointSelector from "./AlfPointSelector"
import { ipaToRousselot } from "@/lib/alf-notation"

const ACCEPTED_EXTENSIONS = ".mp4,.mov,.avi,.mkv,.webm,.mts,.wav,.mp3,.flac,.ogg,.m4a,.aac"
const ALL_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mts', 'wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac']

type ToolStatus = 'idle' | 'uploading' | 'queued' | 'extracting-audio' | 'diarizing' | 'transcribing' | 'segmenting' | 'phonetizing' | 'extracting-clips' | 'done' | 'error'

interface LinguisticToolProps {
  onBack: () => void
  initialProject?: any
}

const LinguisticTool = ({ onBack, initialProject }: LinguisticToolProps) => {
  // Upload
  const [uploadedFile, setUploadedFile] = useState<{ path: string; name: string; duration: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Mode de l'outil :
  //  - 'round-table' : tour de table classique (un meneur FR + N intervenants en patois)
  //  - 'single'      : enregistrement solo d'une personne qui parle directement en patois
  // null = pas encore choisi → on affiche l'ecran de selection au demarrage
  const [mode, setMode] = useState<'round-table' | 'single' | null>(null)

  // Config
  const [whisperModel, setWhisperModel] = useState('large-v3')
  const [language, setLanguage] = useState('fr')
  const [numSpeakers, setNumSpeakers] = useState(10)
  // Point d'enquete ALF (optionnel) : permet d'enrichir l'analyse avec les
  // attestations historiques de l'Atlas Linguistique de la France au point
  // geographique correspondant a l'enregistrement.
  const [alfPoint, setAlfPoint] = useState<AlfPoint | null>(null)
  // Axes de focalisation : contexte libre injecte dans les prompts Ollama
  // pour adapter l'analyse (ex: "vocabulaire de peche en mer Vendee").
  const [focusContext, setFocusContext] = useState('')
  // Mode relance : modal pour saisir un nouveau contexte sur un projet existant
  const [showRelaunch, setShowRelaunch] = useState(false)
  const [relaunchContext, setRelaunchContext] = useState('')
  const [relaunching, setRelaunching] = useState(false)

  // Processing
  const [status, setStatus] = useState<ToolStatus>('idle')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [queuePosition, setQueuePosition] = useState(0)

  // Results
  const [linguisticId, setLinguisticId] = useState<string | null>(null)
  const [sequences, setSequences] = useState<LinguisticSequence[]>([])
  const [speakers, setSpeakers] = useState<string[]>([])
  const [leaderSpeaker, setLeaderSpeaker] = useState('')

  // Audio playback
  const [playingAudio, setPlayingAudio] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Editing
  const [editingFrench, setEditingFrench] = useState<number | null>(null)
  const [editingIpa, setEditingIpa] = useState<string | null>(null) // "seqIdx_varIdx"
  const [editingRousselot, setEditingRousselot] = useState<string | null>(null) // "seqIdx_varIdx"

  // Validation atlas moderne
  const [validating, setValidating] = useState(false)
  const [validatedCount, setValidatedCount] = useState<number | null>(null)

  const isProcessing = ['uploading', 'queued', 'extracting-audio', 'diarizing', 'transcribing', 'segmenting', 'phonetizing', 'extracting-clips'].includes(status)

  // ── Load initial project ──
  useEffect(() => {
    if (!initialProject) return

    // Recuperer le filePath original depuis les donnees du projet
    const origPath = initialProject.data?.linguisticItems?.[0]?.filePath || initialProject.data?.filePath || ''

    if (initialProject.data?.linguisticId) {
      // Projet termine → charger les resultats
      api.getLinguistic(initialProject.data.linguisticId).then((result: any) => {
        setLinguisticId(initialProject.data.linguisticId)
        setSequences(result.sequences || [])
        setSpeakers(result.speakers || [])
        setLeaderSpeaker(result.leader_speaker || '')
        setUploadedFile({ path: origPath, name: result.filename, duration: result.duration || 0 })
        setStatus('done')
      }).catch(() => {})
    } else if (initialProject.status === 'processing') {
      // Projet en cours
      setUploadedFile({ path: origPath, name: initialProject.name || 'Audio', duration: 0 })
      setStatus('transcribing')
      setProgressMessage('Traitement en cours...')
      // Chercher le taskId dans la queue pour ce projet
      // Le WebSocket reprendra le suivi automatiquement quand le complete arrivera
    }
  }, [initialProject])

  // ── WebSocket listeners ──
  // Ecoute meme sans taskId (pour les projets en cours ouverts depuis l'accueil)
  useEffect(() => {
    if (!taskId && status !== 'transcribing') return

    let isDone = false
    const projectId = initialProject?.id

    const unsubProgress = api.onLinguisticProgress((data: any) => {
      if (isDone) return
      if (taskId && data.taskId !== taskId) return
      // Si pas de taskId mais projet en cours, accepter le premier event qu'on recoit
      if (!taskId) setTaskId(data.taskId)
      setStatus(data.step as ToolStatus)
      setProgress(data.progress || 0)
      setProgressMessage(data.message || '')
    })

    const unsubComplete = api.onLinguisticComplete((data: any) => {
      if (taskId && data.taskId !== taskId) return
      // Verifier que c'est bien notre projet
      if (projectId && data.projectId && data.projectId !== projectId) return
      isDone = true
      setStatus('done')
      setLinguisticId(data.linguisticId)
      api.getLinguistic(data.linguisticId).then((result: any) => {
        setSequences(result.sequences || [])
        setSpeakers(result.speakers || [])
        setLeaderSpeaker(result.leader_speaker || '')
      }).catch(() => {})
    })

    const unsubQueueCompleted = api.onQueueTaskCompleted((data: any) => {
      if (isDone) return
      if (taskId && data.taskId !== taskId) return
      isDone = true
      setStatus('done')
      // Chercher le linguisticId dans les projets
      if (data.result?.linguisticId) {
        setLinguisticId(data.result.linguisticId)
        api.getLinguistic(data.result.linguisticId).then((result: any) => {
          setSequences(result.sequences || [])
          setSpeakers(result.speakers || [])
          setLeaderSpeaker(result.leader_speaker || '')
        }).catch(() => {})
      }
    })

    const unsubStarted = api.onQueueTaskStarted((data: any) => {
      if (data.taskId !== taskId) return
      setStatus('extracting-audio')
      setQueuePosition(0)
    })

    const unsubFailed = api.onQueueTaskFailed((data: any) => {
      if (data.taskId !== taskId) return
      setStatus('error')
      setProgressMessage(data.error || 'Erreur inconnue')
    })

    return () => { unsubProgress(); unsubComplete(); unsubQueueCompleted(); unsubStarted(); unsubFailed() }
  }, [taskId])

  // ── Upload ──
  const handleFiles = useCallback(async (files: File[]) => {
    const valid = files.filter(f => {
      const ext = f.name.split('.').pop()?.toLowerCase()
      return ext && ALL_EXTENSIONS.includes(ext)
    })
    if (valid.length === 0) return

    setStatus('uploading')
    try {
      const result = await api.uploadMedia(valid[0])
      setUploadedFile({ path: result.path || result.id, name: result.name, duration: result.duration || 0 })
      setStatus('idle')
    } catch {
      setStatus('error')
      setProgressMessage('Erreur upload')
    }
  }, [])

  // ── Start analysis ──
  const handleStart = async () => {
    if (!uploadedFile) return
    setStatus('queued')
    try {
      const result = await api.startLinguistic(uploadedFile.path, uploadedFile.name, {
        whisperModel, language,
        numSpeakers: mode === 'single' ? 1 : numSpeakers,
        mode: mode || 'round-table',
        alfPointId: alfPoint?.id ?? null,
        alfPointInfo: alfPoint ? { num_alf: alfPoint.num_alf, commune: alfPoint.commune, dept: alfPoint.dept_code } : null,
        focusContext,
      })
      setTaskId(result.taskId)
      setQueuePosition(result.position)
    } catch (err: any) {
      setStatus('error')
      setProgressMessage(err.message || 'Erreur')
    }
  }

  // ── Audio playback ──
  const playAudio = (url: string) => {
    if (audioRef.current) {
      audioRef.current.pause()
    }
    if (playingAudio === url) {
      setPlayingAudio(null)
      return
    }
    const audio = new Audio(url)
    audio.onended = () => setPlayingAudio(null)
    audio.play()
    audioRef.current = audio
    setPlayingAudio(url)
  }

  // ── Save edits ──
  const saveFrenchText = async (seqIdx: number, text: string) => {
    if (!linguisticId) return
    await api.updateLinguisticSequence(linguisticId, seqIdx, { french_text: text })
    setSequences(prev => prev.map((s, i) => i === seqIdx ? { ...s, french_text: text } : s))
    setEditingFrench(null)
  }

  const saveIpa = async (seqIdx: number, varIdx: number, ipa: string) => {
    if (!linguisticId) return
    const result = await api.updateLinguisticSequence(linguisticId, seqIdx, { variant_idx: varIdx, ipa })
    if (result.sequences) setSequences(result.sequences)
    setEditingIpa(null)
  }

  const resetIpa = async (seqIdx: number, varIdx: number) => {
    const original = sequences[seqIdx]?.variants[varIdx]?.ipa_original
    if (original !== undefined) {
      await saveIpa(seqIdx, varIdx, original)
    }
  }

  // Sauvegarde de la notation ALF (Rousselot) — independante de l'IPA.
  // L'utilisateur peut corriger l'une ou l'autre des deux notations sans
  // affecter l'autre (les deux sont stockees separement en DB).
  const saveRousselot = async (seqIdx: number, varIdx: number, rousselot: string) => {
    if (!linguisticId) return
    const result = await api.updateLinguisticSequence(linguisticId, seqIdx, { variant_idx: varIdx, rousselot })
    if (result.sequences) setSequences(result.sequences)
    setEditingRousselot(null)
  }

  const resetRousselot = async (seqIdx: number, varIdx: number) => {
    // Reset = reconvertit depuis l'IPA actuel (pas d'historique stocké pour le moment)
    const ipa = sequences[seqIdx]?.variants[varIdx]?.ipa
    if (ipa !== undefined) {
      await saveRousselot(seqIdx, varIdx, ipaToRousselot(ipa))
    }
  }

  // Valide la transcription en l'ajoutant a l'atlas dialectal moderne.
  // Toutes les variantes (locuteurs) deviennent des attestations historiques
  // datees, geolocalisees au point ALF si saisi, en double notation.
  const handleValidateToAtlas = async () => {
    if (!linguisticId || validating) return
    setValidating(true)
    try {
      const result = await api.validateLinguisticToAtlas(linguisticId)
      setValidatedCount(result.count)
    } catch (e: any) {
      console.error('Erreur validation atlas:', e)
    } finally {
      setValidating(false)
    }
  }

  const renameSpeaker = async (oldName: string) => {
    const newName = prompt(`Renommer "${oldName}" en :`, oldName)
    if (!newName || newName === oldName || !linguisticId) return
    const result = await api.renameLinguisticSpeaker(linguisticId, oldName, newName)
    if (result.sequences) setSequences(result.sequences)
    if (result.speakers) setSpeakers(result.speakers)
    if (result.leader_speaker) setLeaderSpeaker(result.leader_speaker)
  }

  // ── Format time ──
  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  // ── Step label ──
  const stepLabel = (s: ToolStatus) => {
    switch (s) {
      case 'extracting-audio': return 'Extraction audio'
      case 'diarizing': return 'Identification locuteurs'
      case 'transcribing': return 'Transcription Whisper'
      case 'segmenting': return 'Segmentation sequences'
      case 'phonetizing': return 'Transcription phonetique (IPA)'
      case 'extracting-clips': return 'Extraction extraits audio'
      case 'queued': return "File d'attente"
      default: return 'Traitement'
    }
  }

  // ── Render ──
  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={onBack} className="p-2 rounded-lg hover:bg-secondary transition-colors">
          <ArrowLeft className="w-5 h-5 text-muted-foreground" />
        </button>
        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
          <BookOpen className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-foreground">Transcription linguistique</h1>
          <p className="text-xs text-muted-foreground">Segmentation francais / langue vernaculaire + transcription IPA</p>
        </div>
      </div>

      {/* Selecteur de mode (ecran d'accueil de l'outil) */}
      {mode === null && (
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          className="space-y-3"
        >
          <p className="text-xs text-muted-foreground mb-4">
            Quel type d'enregistrement souhaites-tu traiter ?
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Mode tour de table */}
            <button
              onClick={() => setMode('round-table')}
              className="text-left p-6 bg-card border-2 border-border hover:border-emerald-500 rounded-xl transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-3 group-hover:bg-emerald-500/20">
                <Users className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="text-sm font-bold text-foreground mb-1">Tour de table</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Un meneur dit chaque phrase en français, plusieurs intervenants la repetent
                a tour de role en patois.
              </p>
              <p className="text-[10px] text-muted-foreground">
                → L'outil decoupe en sequences (phrase FR + variantes patois par locuteur),
                produit IPA + ALF pour chaque variante.
              </p>
            </button>

            {/* Mode audio solo */}
            <button
              onClick={() => setMode('single')}
              className="text-left p-6 bg-card border-2 border-border hover:border-emerald-500 rounded-xl transition-all group"
            >
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-3 group-hover:bg-emerald-500/20">
                <User className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="text-sm font-bold text-foreground mb-1">Audio solo</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Une seule personne s'enregistre, parlant directement en patois (sans meneur FR).
              </p>
              <p className="text-[10px] text-muted-foreground">
                → L'outil transcrit toute la duree, decoupe par phrases naturelles,
                produit IPA + ALF.
              </p>
            </button>
          </div>
        </motion.div>
      )}

      {/* Upload zone (apparait apres choix du mode) */}
      {mode !== null && !uploadedFile && status !== 'uploading' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          className="cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragging(false) }}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(Array.from(e.dataTransfer.files)) }}
        >
          <input ref={fileInputRef} type="file" accept={ACCEPTED_EXTENSIONS} onChange={(e) => {
            if (e.target.files) handleFiles(Array.from(e.target.files))
            e.target.value = ''
          }} className="hidden" />
          <div className={`border-2 border-dashed rounded-lg p-10 text-center transition-all bg-card/50 ${
            isDragging ? 'border-emerald-500 bg-emerald-500/5 scale-[1.02]' : 'border-border hover:border-emerald-500'
          }`}>
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <Upload className="w-7 h-7 text-emerald-400" />
              </div>
              <p className="text-foreground font-medium text-lg">Deposer un enregistrement ici</p>
              <p className="text-muted-foreground text-sm">Audio ou video avec phrases en francais et repetitions en langue vernaculaire</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Uploading */}
      {status === 'uploading' && (
        <div className="flex items-center gap-3 p-6 bg-card border border-border rounded-xl">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          <span className="text-sm text-foreground">Upload en cours...</span>
        </div>
      )}

      {/* File uploaded + Config */}
      {uploadedFile && status === 'idle' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: file info */}
            <div className="lg:col-span-2">
              <div className="p-4 bg-card border border-border rounded-xl flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <BookOpen className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{uploadedFile.name}</p>
                  <p className="text-xs text-muted-foreground">{fmtTime(uploadedFile.duration)}</p>
                </div>
              </div>
            </div>

            {/* Right: config */}
            <div className="space-y-4">
              <div className="bg-card border border-border rounded-xl p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <BookOpen className="w-3.5 h-3.5" /> Configuration
                </h3>
                {/* Champ "nombre de locuteurs" : seulement en mode tour de table */}
                {mode === 'round-table' && (
                  <div>
                    <label className="text-[10px] font-bold uppercase text-muted-foreground">Nombre de locuteurs</label>
                    <input type="number" min={2} max={20} value={numSpeakers} onChange={(e) => setNumSpeakers(parseInt(e.target.value) || 10)}
                      className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-xs text-foreground" />
                    <p className="text-[9px] text-muted-foreground mt-1">Meneur + intervenants (ex: 1 meneur + 9 locuteurs = 10)</p>
                  </div>
                )}
                {/* Indicateur mode (informatif, non editable une fois lance) */}
                <div className="text-[10px] text-muted-foreground">
                  Mode : <span className="font-bold text-emerald-400">
                    {mode === 'single' ? 'Audio solo (1 personne)' : 'Tour de table'}
                  </span>
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-muted-foreground">Modele Whisper</label>
                  <select value={whisperModel} onChange={(e) => setWhisperModel(e.target.value)}
                    className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-xs text-foreground">
                    <option value="large-v3">Large V3</option>
                    <option value="medium">Medium</option>
                    <option value="small">Small</option>
                  </select>
                </div>
                {/* Axes de focalisation : aide Ollama a accepter du vocabulaire specifique */}
                <div>
                  <label className="text-[10px] font-bold uppercase text-muted-foreground">Axes de focalisation</label>
                  <textarea
                    value={focusContext}
                    onChange={(e) => setFocusContext(e.target.value)}
                    placeholder="Ex: vocabulaire de cuisine paysanne ; collectage en patois limousin ; termes de la peche cotiere..."
                    rows={3}
                    className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-xs text-foreground resize-none placeholder:text-muted-foreground/40"
                  />
                  <p className="text-[9px] text-muted-foreground mt-1">Contexte libre — aide a reconnaitre le vocabulaire specifique. Optionnel.</p>
                </div>
              </div>

              <Button onClick={handleStart} className="w-full h-10 bg-emerald-600 hover:bg-emerald-700 text-white font-bold uppercase tracking-wide rounded-lg text-xs">
                <BookOpen className="w-4 h-4 mr-2" /> Lancer l'analyse
              </Button>
            </div>
          </div>

          {/* Selection du point d'enquete ALF (optionnel mais recommande) */}
          <div className="mt-6 bg-card border border-border rounded-xl p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2 mb-3">
              <BookOpen className="w-3.5 h-3.5" /> Localisation ALF (optionnel)
            </h3>
            <p className="text-[11px] text-muted-foreground mb-3">
              Indiquer la zone geographique de l'enregistrement permet de recuperer les attestations
              historiques de l'Atlas Linguistique de la France (1900) pour comparer avec les
              prononciations actuelles.
            </p>
            <AlfPointSelector
              selectedPointId={alfPoint?.id ?? null}
              onSelect={setAlfPoint}
            />
          </div>
        </motion.div>
      )}

      {/* Processing */}
      {isProcessing && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
          <div className="p-4 bg-card border border-border rounded-xl">
            <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground mb-2">
              <span className="text-emerald-400 animate-pulse uppercase tracking-wider">{stepLabel(status)}</span>
              <span className="font-mono">{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} className="h-full bg-emerald-500" />
            </div>
            {progressMessage && <p className="text-[10px] text-muted-foreground mt-2">{progressMessage}</p>}
          </div>
        </motion.div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-xl">
          <p className="text-sm text-destructive font-medium">{progressMessage || 'Erreur'}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => { setStatus('idle'); setProgressMessage('') }}>
            Reessayer
          </Button>
        </div>
      )}

      {/* Results */}
      {status === 'done' && sequences.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
          {/* Header with export + leader selector */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold text-foreground">{sequences.length} sequences</h2>
              {speakers.length > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Meneur :</span>
                  <select
                    value={leaderSpeaker}
                    onChange={async (e) => {
                      const newLeader = e.target.value
                      setLeaderSpeaker(newLeader)
                      if (linguisticId) await api.updateLinguisticLeader(linguisticId, newLeader)
                    }}
                    className="bg-secondary border border-border rounded px-2 py-0.5 text-xs"
                  >
                    {speakers.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              {/* Relancer SANS re-uploader, en injectant un nouveau contexte */}
              {linguisticId && (
                <Button
                  variant="outline" size="sm"
                  onClick={() => { setRelaunchContext(focusContext); setShowRelaunch(true) }}
                  className="text-xs gap-1.5 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                  title="Relancer l'analyse sur le meme audio avec un nouveau contexte de focalisation"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Relancer avec contexte
                </Button>
              )}
              {uploadedFile && (
                <Button variant="outline" size="sm" className="text-xs gap-1.5"
                  onClick={() => {
                    setStatus('idle')
                    setSequences([])
                    setSpeakers([])
                    setLinguisticId(null)
                    setProgress(0)
                    setTaskId(null)
                  }}>
                  <RotateCcw className="w-3.5 h-3.5" /> Recommencer
                </Button>
              )}
              {linguisticId && (
                <>
                  {/* Validation atlas moderne : pousse les attestations en DB partagee */}
                  <Button
                    variant="outline" size="sm"
                    onClick={handleValidateToAtlas}
                    disabled={validating}
                    className="text-xs gap-1.5 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                    title="Ajouter ces attestations a l'atlas moderne (geolocalise, double notation)"
                  >
                    {validating
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : validatedCount !== null
                        ? <Check className="w-3.5 h-3.5" />
                        : <Globe2 className="w-3.5 h-3.5" />}
                    {validatedCount !== null ? `Publie (${validatedCount})` : 'Valider et publier'}
                  </Button>
                  <a href={api.getLinguisticExportUrl(linguisticId, 'json')} download>
                    <Button variant="outline" size="sm" className="text-xs gap-1.5">
                      <Download className="w-3.5 h-3.5" /> JSON
                    </Button>
                  </a>
                  <a href={api.getLinguisticExportUrl(linguisticId, 'csv')} download>
                    <Button variant="outline" size="sm" className="text-xs gap-1.5">
                      <Download className="w-3.5 h-3.5" /> CSV
                    </Button>
                  </a>
                </>
              )}
            </div>
          </div>

          {/* Sequence cards */}
          <div className="space-y-4">
            {sequences.map((seq, si) => (
              <div key={seq.id} className="bg-card border border-border rounded-xl overflow-hidden">
                {/* French phrase */}
                <div className="p-4 bg-secondary/30 border-b border-border flex items-start gap-3">
                  <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 rounded px-1.5 py-0.5 shrink-0">
                    #{si + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    {editingFrench === si ? (
                      <input
                        autoFocus
                        defaultValue={seq.french_text}
                        onBlur={(e) => saveFrenchText(si, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                        className="w-full bg-secondary border border-border rounded px-2 py-1 text-sm text-foreground"
                      />
                    ) : (
                      <p className="text-sm font-medium text-foreground cursor-pointer hover:text-emerald-400"
                        onClick={() => setEditingFrench(si)} title="Cliquer pour modifier">
                        {seq.french_text || '(phrase francaise)'}
                      </p>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {fmtTime(seq.french_audio.start)} - {fmtTime(seq.french_audio.end)}
                    </span>
                  </div>
                  {linguisticId && (
                    <button onClick={() => playAudio(api.getLinguisticAudioUrl(linguisticId, `seq_${si}_fr.wav`))}
                      className="p-1.5 rounded-lg hover:bg-secondary transition-colors shrink-0">
                      {playingAudio?.includes(`seq_${si}_fr`) ? <Pause className="w-4 h-4 text-emerald-400" /> : <Play className="w-4 h-4 text-muted-foreground" />}
                    </button>
                  )}
                </div>

                {/* Variants */}
                {seq.variants.length > 0 ? (
                  <div className="divide-y divide-border/50">
                    {seq.variants.map((v, vi) => {
                      const editKey = `${si}_${vi}`
                      // Notation ALF Rousselot : si pas stockee, on la calcule a la volee
                      // depuis l'IPA. Au prochain enregistrement modifie elle sera persistee.
                      const rousselot = v.rousselot ?? (v.ipa ? ipaToRousselot(v.ipa) : '')
                      return (
                        <div key={vi} className="p-3 flex items-start gap-3 hover:bg-secondary/20 transition-colors">
                          {/* Speaker */}
                          <span
                            className="text-[10px] font-bold text-primary cursor-pointer hover:underline shrink-0 w-20 truncate"
                            onClick={() => renameSpeaker(v.speaker)}
                            title="Cliquer pour renommer"
                          >{v.speaker}</span>

                          {/* Double notation : ALF (mise en avant) + IPA (reference) */}
                          <div className="flex-1 min-w-0 space-y-1">
                            {/* ALF Rousselot — affichage principal en avant */}
                            <div className="flex items-baseline gap-2">
                              <span className="text-[9px] font-bold uppercase text-emerald-400 shrink-0 w-9">ALF</span>
                              {editingRousselot === editKey ? (
                                <input
                                  autoFocus
                                  defaultValue={rousselot}
                                  onBlur={(e) => saveRousselot(si, vi, e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                  className="flex-1 bg-secondary border border-border rounded px-2 py-1 text-sm font-mono text-foreground"
                                />
                              ) : (
                                <p
                                  className="flex-1 text-sm font-mono font-semibold text-foreground cursor-pointer hover:text-emerald-400"
                                  onClick={() => setEditingRousselot(editKey)}
                                  title="Cliquer pour modifier la notation ALF"
                                >
                                  {rousselot || '(pas de transcription ALF)'}
                                </p>
                              )}
                            </div>
                            {/* IPA — reference moderne, plus discret */}
                            <div className="flex items-baseline gap-2">
                              <span className="text-[9px] font-bold uppercase text-muted-foreground shrink-0 w-9">IPA</span>
                              {editingIpa === editKey ? (
                                <input
                                  autoFocus
                                  defaultValue={v.ipa}
                                  onBlur={(e) => saveIpa(si, vi, e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                  className="flex-1 bg-secondary border border-border rounded px-2 py-1 text-sm font-mono text-foreground"
                                />
                              ) : (
                                <p
                                  className="flex-1 text-xs font-mono text-foreground/60 cursor-pointer hover:text-foreground"
                                  onClick={() => setEditingIpa(editKey)}
                                  title="Cliquer pour modifier l'IPA"
                                >
                                  {v.ipa ? `/${v.ipa}/` : '(pas d\'IPA)'}
                                </p>
                              )}
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              {fmtTime(v.audio.start)} - {fmtTime(v.audio.end)}
                            </span>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 shrink-0">
                            {v.ipa !== v.ipa_original && v.ipa_original && (
                              <button onClick={() => resetIpa(si, vi)} className="p-1 rounded hover:bg-secondary" title="Reset IPA original">
                                <RotateCcw className="w-3 h-3 text-muted-foreground" />
                              </button>
                            )}
                            {v.rousselot && v.rousselot !== ipaToRousselot(v.ipa || '') && (
                              <button onClick={() => resetRousselot(si, vi)} className="p-1 rounded hover:bg-secondary" title="Recalculer ALF depuis l'IPA">
                                <RotateCcw className="w-3 h-3 text-emerald-400" />
                              </button>
                            )}
                            {linguisticId && v.audio_extract && (
                              <button onClick={() => playAudio(api.getLinguisticAudioUrl(linguisticId, v.audio_extract!))}
                                className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                                {playingAudio?.includes(v.audio_extract!) ? <Pause className="w-4 h-4 text-emerald-400" /> : <Play className="w-4 h-4 text-muted-foreground" />}
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="p-3 text-xs text-muted-foreground italic">Aucune variante vernaculaire</div>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Done but no sequences */}
      {status === 'done' && sequences.length === 0 && (
        <div className="p-6 bg-card border border-border rounded-xl text-center">
          <p className="text-muted-foreground">Aucune sequence detectee. Verifiez que l'enregistrement contient des phrases en francais suivies de repetitions en langue vernaculaire.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setStatus('idle')}>
            Reessayer
          </Button>
        </div>
      )}

      {/* Modal Relancer avec contexte */}
      <AnimatePresence>
        {showRelaunch && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => !relaunching && setShowRelaunch(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="bg-card border border-border rounded-xl p-6 w-full max-w-lg space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div>
                <h3 className="text-sm font-bold text-foreground mb-1">Relancer l'analyse</h3>
                <p className="text-[11px] text-muted-foreground">
                  On reprend le meme audio mais on relance les etapes de classification (Whisper sera refait).
                  Ajoute un contexte specifique si l'analyse precedente n'etait pas pertinente.
                </p>
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase text-muted-foreground">Axes de focalisation</label>
                <textarea
                  value={relaunchContext}
                  onChange={(e) => setRelaunchContext(e.target.value)}
                  placeholder="Ex: termes de cuisine paysanne ; outils agricoles ; lexique de la vigne..."
                  rows={4}
                  className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-xs text-foreground resize-none placeholder:text-muted-foreground/40"
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowRelaunch(false)} disabled={relaunching}>
                  Annuler
                </Button>
                <Button
                  size="sm"
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  disabled={relaunching}
                  onClick={async () => {
                    if (!linguisticId) return
                    setRelaunching(true)
                    try {
                      const token = localStorage.getItem('clipr-auth-token')
                      const res = await fetch(`/api/linguistic/${linguisticId}/relaunch`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                        body: JSON.stringify({ focusContext: relaunchContext })
                      })
                      const data = await res.json()
                      if (!res.ok) throw new Error(data.error || 'Echec relance')
                      // On bascule en etat queued + on met a jour le focusContext local
                      setFocusContext(relaunchContext)
                      setTaskId(data.taskId)
                      setQueuePosition(data.position)
                      setStatus('queued')
                      setSequences([])
                      setShowRelaunch(false)
                    } catch (e: any) {
                      alert(e.message)
                    } finally {
                      setRelaunching(false)
                    }
                  }}
                >
                  {relaunching ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
                  Relancer
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default LinguisticTool

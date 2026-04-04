/**
 * LINGUISTICTOOL.TSX : Outil de transcription linguistique (patois)
 *
 * Permet d'uploader un fichier audio/video, de segmenter par sequences
 * (francais + variantes patois), de generer l'IPA via Allosaurus,
 * et d'editer/exporter les resultats.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import { Upload, BookOpen, Loader2, Play, Pause, Download, ArrowLeft, ChevronDown, Pencil, RotateCcw } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { Button } from "@/components/ui/button"
import api from "@/api"
import type { LinguisticSequence } from "@/types"

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

  // Config
  const [whisperModel, setWhisperModel] = useState('large-v3')
  const [language, setLanguage] = useState('fr')
  const [numSpeakers, setNumSpeakers] = useState(10)

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

  const isProcessing = ['uploading', 'queued', 'extracting-audio', 'diarizing', 'transcribing', 'segmenting', 'phonetizing', 'extracting-clips'].includes(status)

  // ── Load initial project ──
  useEffect(() => {
    if (initialProject?.data?.linguisticId) {
      api.getLinguistic(initialProject.data.linguisticId).then((result: any) => {
        setLinguisticId(initialProject.data.linguisticId)
        setSequences(result.sequences || [])
        setSpeakers(result.speakers || [])
        setLeaderSpeaker(result.leader_speaker || '')
        setUploadedFile({ path: '', name: result.filename, duration: result.duration || 0 })
        setStatus('done')
      }).catch(() => {})
    }
  }, [initialProject])

  // ── WebSocket listeners ──
  useEffect(() => {
    if (!taskId) return

    let isDone = false

    const unsubProgress = api.onLinguisticProgress((data: any) => {
      if (isDone || data.taskId !== taskId) return
      setStatus(data.step as ToolStatus)
      setProgress(data.progress || 0)
      setProgressMessage(data.message || '')
    })

    const unsubComplete = api.onLinguisticComplete((data: any) => {
      if (data.taskId !== taskId) return
      isDone = true
      setStatus('done')
      setLinguisticId(data.linguisticId)
      api.getLinguistic(data.linguisticId).then((result: any) => {
        setSequences(result.sequences || [])
        setSpeakers(result.speakers || [])
        setLeaderSpeaker(result.leader_speaker || '')
      }).catch(() => {})
    })

    // Backup : ecouter aussi queue:task-completed au cas ou linguistic:complete est perdu
    const unsubQueueCompleted = api.onQueueTaskCompleted((data: any) => {
      if (data.taskId !== taskId || isDone) return
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
        whisperModel, language, numSpeakers
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

      {/* Upload zone */}
      {!uploadedFile && status !== 'uploading' && (
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
                <div>
                  <label className="text-[10px] font-bold uppercase text-muted-foreground">Nombre de locuteurs</label>
                  <input type="number" min={2} max={20} value={numSpeakers} onChange={(e) => setNumSpeakers(parseInt(e.target.value) || 10)}
                    className="w-full mt-1 bg-secondary border border-border rounded-lg px-3 py-2 text-xs text-foreground" />
                  <p className="text-[9px] text-muted-foreground mt-1">Meneur + intervenants (ex: 1 meneur + 9 locuteurs = 10)</p>
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
              </div>

              <Button onClick={handleStart} className="w-full h-10 bg-emerald-600 hover:bg-emerald-700 text-white font-bold uppercase tracking-wide rounded-lg text-xs">
                <BookOpen className="w-4 h-4 mr-2" /> Lancer l'analyse
              </Button>
            </div>
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
              {linguisticId && (
                <>
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
                      return (
                        <div key={vi} className="p-3 flex items-start gap-3 hover:bg-secondary/20 transition-colors">
                          {/* Speaker */}
                          <span
                            className="text-[10px] font-bold text-primary cursor-pointer hover:underline shrink-0 w-20 truncate"
                            onClick={() => renameSpeaker(v.speaker)}
                            title="Cliquer pour renommer"
                          >{v.speaker}</span>

                          {/* IPA */}
                          <div className="flex-1 min-w-0">
                            {editingIpa === editKey ? (
                              <input
                                autoFocus
                                defaultValue={v.ipa}
                                onBlur={(e) => saveIpa(si, vi, e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                className="w-full bg-secondary border border-border rounded px-2 py-1 text-sm font-mono text-foreground"
                              />
                            ) : (
                              <p className="text-sm font-mono text-foreground/80 cursor-pointer hover:text-foreground"
                                onClick={() => setEditingIpa(editKey)} title="Cliquer pour modifier l'IPA">
                                {v.ipa ? `/${v.ipa}/` : '(pas d\'IPA)'}
                              </p>
                            )}
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
    </div>
  )
}

export default LinguisticTool

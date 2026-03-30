/**
 * TRANSCRIPTIONTOOL.TSX : Outil de transcription audio standalone
 *
 * Permet d'uploader un fichier audio ou vidéo, de le transcrire avec Whisper
 * via la file d'attente IA, et d'afficher/exporter le résultat.
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Mic, ArrowLeft, Upload, Loader2, Copy, Download, Trash2,
  CheckCircle2, AlertCircle, Clock, HelpCircle, FileText, Music, Files
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select"
import api from "@/api"
import type { TranscriptSegment, TranscriptionHistoryItem } from "@/types"

const ACCEPTED_EXTENSIONS = '.mp4,.mov,.avi,.mkv,.webm,.mts,.wav,.mp3,.flac,.ogg,.m4a,.aac'
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac']
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mts']
const ALL_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]

interface TranscriptionToolProps {
  onBack: () => void
}

type ToolStatus = 'idle' | 'uploading' | 'queued' | 'extracting-audio' | 'transcribing' | 'done' | 'error'

// Batch file item
interface BatchItem {
  id: string
  file: File
  filename: string
  status: 'pending' | 'uploading' | 'uploaded' | 'queued' | 'extracting-audio' | 'transcribing' | 'done' | 'error'
  progress: number
  progressMessage: string
  taskId?: string
  filePath?: string
  transcriptionId?: string
  error?: string
  liveSegments: TranscriptSegment[]
}

const InfoTip = ({ text }: { text: string }) => {
  const [show, setShow] = useState(false)
  return (
    <span className="relative inline-flex" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60 cursor-help hover:text-primary transition-colors" />
      {show && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-popover border border-border rounded-lg text-[11px] text-foreground leading-relaxed w-60 shadow-xl z-50">
          {text}
        </span>
      )}
    </span>
  )
}

const TranscriptionTool = ({ onBack }: TranscriptionToolProps) => {
  // Upload state
  const [file, setFile] = useState<File | null>(null)
  const [uploadedFile, setUploadedFile] = useState<{ path: string; name: string; duration: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Batch state
  const [batchItems, setBatchItems] = useState<BatchItem[]>([])
  const [batchMode, setBatchMode] = useState(false)
  const [batchProcessing, setBatchProcessing] = useState(false)

  // Derived batch state
  const allTaskIds = batchItems.map(item => item.taskId).filter((id): id is string => !!id)
  const batchDoneCount = batchItems.filter(item => item.status === 'done').length
  const batchAllDone = batchItems.length > 0 && batchItems.every(item => item.status === 'done' || item.status === 'error')

  // Config
  const [whisperModel, setWhisperModel] = useState<string>('large-v3')
  const [language, setLanguage] = useState<string>('fr')
  const [whisperPrompt, setWhisperPrompt] = useState<string>('')

  // Processing state
  const [status, setStatus] = useState<ToolStatus>('idle')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [queuePosition, setQueuePosition] = useState<number>(0)
  const [progress, setProgress] = useState<number>(0)
  const [progressMessage, setProgressMessage] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')

  // Result
  const [transcriptionId, setTranscriptionId] = useState<string | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([])
  const [copied, setCopied] = useState(false)

  // History
  const [history, setHistory] = useState<TranscriptionHistoryItem[]>([])
  const [showHistory, setShowHistory] = useState(false)

  // Load history on mount
  useEffect(() => {
    api.getTranscriptionHistory().then(setHistory).catch(() => {})
  }, [])

  // WebSocket listeners
  useEffect(() => {
    if (allTaskIds.length === 0 && !taskId) return

    const unsubProgress = api.onTranscriptionProgress((data: any) => {
      if (batchMode) {
        if (!allTaskIds.includes(data.taskId)) return
        setBatchItems(prev => prev.map(item =>
          item.taskId === data.taskId
            ? { ...item, status: data.step as BatchItem["status"], progress: data.progress || 0, progressMessage: data.message || "" }
            : item
        ))
      } else {
        if (data.taskId !== taskId) return
        setStatus(data.step as ToolStatus)
        setProgress(data.progress || 0)
        setProgressMessage(data.message || "")
      }
    })

    const unsubSegment = api.onTranscriptionSegment((data: any) => {
      if (batchMode) {
        if (!allTaskIds.includes(data.taskId)) return
        setBatchItems(prev => prev.map(item =>
          item.taskId === data.taskId
            ? { ...item, liveSegments: [...item.liveSegments, data.segment] }
            : item
        ))
      } else {
        if (data.taskId !== taskId) return
        setLiveSegments(prev => [...prev, data.segment])
      }
    })

    const unsubComplete = api.onTranscriptionComplete((data: any) => {
      if (batchMode) {
        if (!allTaskIds.includes(data.taskId)) return
        setBatchItems(prev => prev.map(item =>
          item.taskId === data.taskId
            ? { ...item, status: "done", progress: 100, transcriptionId: data.transcriptionId }
            : item
        ))
        api.getTranscriptionHistory().then(setHistory).catch(() => {})
      } else {
        if (data.taskId !== taskId) return
        setStatus("done")
        setTranscriptionId(data.transcriptionId)
        api.getTranscription(data.transcriptionId).then((result: any) => {
          setSegments(result.segments)
        }).catch(() => {})
        api.getTranscriptionHistory().then(setHistory).catch(() => {})
      }
    })

    const unsubQueueStarted = api.onQueueTaskStarted((data: any) => {
      if (batchMode) {
        if (!allTaskIds.includes(data.taskId)) return
        setBatchItems(prev => prev.map(item =>
          item.taskId === data.taskId ? { ...item, status: "extracting-audio", progress: 0 } : item
        ))
      } else {
        if (data.taskId !== taskId) return
        setStatus("extracting-audio")
        setQueuePosition(0)
      }
    })

    const unsubQueueFailed = api.onQueueTaskFailed((data: any) => {
      if (batchMode) {
        if (!allTaskIds.includes(data.taskId)) return
        setBatchItems(prev => prev.map(item =>
          item.taskId === data.taskId ? { ...item, status: "error", error: data.error || "Erreur inconnue" } : item
        ))
      } else {
        if (data.taskId !== taskId) return
        setStatus("error")
        setErrorMessage(data.error || "Erreur inconnue")
      }
    })

    const unsubQueueUpdate = api.onQueueUpdate((data: any) => {
      if (batchMode) {
        setBatchItems(prev => prev.map(item => {
          if (!item.taskId) return item
          const myTask = data.queue?.userTasks?.find((t: any) => t.id === item.taskId)
          if (myTask && myTask.status === "pending") return { ...item, status: "queued", progress: 0 }
          return item
        }))
      } else {
        if (!taskId) return
        const myTask = data.queue?.userTasks?.find((t: any) => t.id === taskId)
        if (myTask && myTask.status === "pending") {
          setQueuePosition(myTask.position || 0)
          setStatus("queued")
        }
      }
    })

    return () => {
      unsubProgress()
      unsubSegment()
      unsubComplete()
      unsubQueueStarted()
      unsubQueueFailed()
      unsubQueueUpdate()
    }
  }, [allTaskIds.join(","), batchMode, taskId])

  // Handle file selection (single or multiple)
  const handleFilesSelect = useCallback(async (selectedFiles: File[]) => {
    const validFiles = selectedFiles.filter(f => {
      const ext = f.name.split('.').pop()?.toLowerCase() || ''
      return ALL_EXTENSIONS.includes(ext)
    })

    if (validFiles.length === 0) {
      setErrorMessage('Format non supporté. Utilisez: ' + ALL_EXTENSIONS.join(', '))
      setStatus('error')
      return
    }

    // Multiple files -> batch mode
    if (validFiles.length > 1) {
      const items: BatchItem[] = validFiles.map((f, i) => ({
        id: 'file-' + Date.now() + '-' + i,
        file: f,
        filename: f.name,
        status: 'pending' as const,
        progress: 0,
        progressMessage: '',
        liveSegments: []
      }))
      setBatchItems(items)
      setBatchMode(true)
      setStatus('idle')
      setErrorMessage('')
      return
    }

    // Single file -> existing flow
    const selectedFile = validFiles[0]
    setFile(selectedFile)
    setBatchMode(false)
    setStatus('uploading')
    setErrorMessage('')

    try {
      const result = await api.uploadMedia(selectedFile)
      setUploadedFile({ path: result.path, name: result.name, duration: result.duration })
      setStatus('idle')
    } catch (err: any) {
      setStatus('error')
      setErrorMessage(err.message || "Erreur d'upload")
    }
  }, [])

  // Legacy single-file handler
  const handleFileSelect = useCallback(async (selectedFile: File) => {
    handleFilesSelect([selectedFile])
  }, [handleFilesSelect])

  // Remove a batch item
  const removeBatchItem = (id: string) => {
    setBatchItems(prev => {
      const next = prev.filter(i => i.id !== id)
      if (next.length <= 1) {
        if (next.length === 1) handleFileSelect(next[0].file)
        setBatchMode(false)
        return []
      }
      return next
    })
  }

  // Start batch transcription
  const handleBatchStart = async () => {
    if (batchItems.length === 0) return
    setBatchProcessing(true)

    // Upload files sequentially
    const updatedItems = [...batchItems]
    for (let i = 0; i < updatedItems.length; i++) {
      const item = updatedItems[i]
      setBatchItems(prev => prev.map(bi =>
        bi.id === item.id ? { ...bi, status: 'uploading' as const } : bi
      ))
      try {
        const result = await api.uploadMedia(item.file)
        updatedItems[i] = { ...updatedItems[i], status: 'uploaded' as const, filePath: result.path, filename: result.name }
        setBatchItems(prev => prev.map(bi =>
          bi.id === item.id ? { ...bi, status: 'uploaded' as const, filePath: result.path, filename: result.name } : bi
        ))
      } catch (err: any) {
        updatedItems[i] = { ...updatedItems[i], status: 'error' as const, error: err.message || "Erreur d'upload" }
        setBatchItems(prev => prev.map(bi =>
          bi.id === item.id ? { ...bi, status: 'error' as const, error: err.message || "Erreur d'upload" } : bi
        ))
      }
    }

    // Start batch transcription for successfully uploaded files
    const uploaded = updatedItems.filter(i => i.filePath && i.status !== 'error')
    if (uploaded.length === 0) {
      setBatchProcessing(false)
      return
    }

    try {
      const files = uploaded.map(i => ({ filePath: i.filePath!, filename: i.filename }))
      const result = await api.startTranscriptionBatch(files, { whisperModel, language, whisperPrompt })
      setBatchItems(prev => prev.map(item => {
        const taskInfo = result.tasks.find((t: any) => t.filename === item.filename)
        if (taskInfo) return { ...item, taskId: taskInfo.taskId, status: 'queued' as const }
        return item
      }))
    } catch (err: any) {
      setBatchItems(prev => prev.map(item =>
        item.status === 'uploaded' ? { ...item, status: 'error' as const, error: err.message } : item
      ))
      setBatchProcessing(false)
    }
  }

  // Drag & drop handlers
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) handleFilesSelect(files)
  }, [handleFilesSelect])

  // Start transcription
  const handleStart = async () => {
    if (!uploadedFile) return

    setStatus('queued')
    setProgress(0)
    setProgressMessage('')
    setLiveSegments([])
    setSegments([])
    setTranscriptionId(null)

    try {
      const result = await api.startTranscription(uploadedFile.path, uploadedFile.name, {
        whisperModel,
        language,
        whisperPrompt
      })
      setTaskId(result.taskId)
      setQueuePosition(result.position)
    } catch (err: any) {
      setStatus('error')
      setErrorMessage(err.message || 'Erreur')
    }
  }

  // Reset to start over
  const handleReset = () => {
    setFile(null)
    setUploadedFile(null)
    setStatus('idle')
    setTaskId(null)
    setProgress(0)
    setProgressMessage('')
    setErrorMessage('')
    setTranscriptionId(null)
    setSegments([])
    setLiveSegments([])
    setCopied(false)
  }

  // Copy transcript to clipboard
  const handleCopy = () => {
    const text = segments.map(s => s.text).join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Load a past transcription
  const handleLoadHistory = async (item: TranscriptionHistoryItem) => {
    try {
      const result = await api.getTranscription(item.id)
      setSegments(result.segments)
      setTranscriptionId(item.id)
      setUploadedFile({ path: '', name: item.filename, duration: item.duration || 0 })
      setStatus('done')
      setShowHistory(false)
    } catch { /* ignore */ }
  }

  const handleDeleteHistory = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api.deleteTranscription(id)
    setHistory(prev => prev.filter(h => h.id !== id))
  }

  const isProcessing = batchProcessing || ['uploading', 'queued', 'extracting-audio', 'transcribing'].includes(status)

  // Format time
  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  return (
    <div className="max-w-4xl mx-auto w-full pt-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={onBack} className="p-2 rounded-lg hover:bg-secondary transition-colors">
          <ArrowLeft className="w-5 h-5 text-muted-foreground" />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Mic className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">Transcription audio</h1>
            <p className="text-xs text-muted-foreground">Transcrire un ou plusieurs fichiers audio/vidéo avec Whisper</p>
          </div>
        </div>
        {history.length > 0 && (
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="ml-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <Clock className="w-3.5 h-3.5" />
            Historique ({history.length})
          </button>
        )}
      </div>

      {/* History panel */}
      <AnimatePresence>
        {showHistory && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 overflow-hidden"
          >
            <div className="bg-card border border-border rounded-xl p-4 space-y-2">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Transcriptions récentes</h3>
              {history.map((item) => (
                <div
                  key={item.id}
                  onClick={() => handleLoadHistory(item)}
                  className="group flex items-center gap-3 p-2.5 rounded-lg hover:bg-secondary/50 cursor-pointer transition-colors"
                >
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">{item.filename}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(item.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {item.duration ? ` · ${fmtTime(item.duration)}` : ''}
                      {' · '}{item.whisper_model} · {item.language.toUpperCase()}
                    </p>
                  </div>
                  <button
                    onClick={(e) => handleDeleteHistory(e, item.id)}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Upload + Result */}
        <div className="lg:col-span-2 space-y-6">
          {/* Upload zone */}
          {!uploadedFile && !batchMode && status !== 'done' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`relative p-10 border-2 border-dashed rounded-2xl text-center cursor-pointer transition-all ${
                isDragging
                  ? 'border-primary bg-primary/5 scale-[1.01]'
                  : 'border-border hover:border-primary/50 hover:bg-secondary/30'
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_EXTENSIONS}
                multiple
                onChange={(e) => e.target.files && e.target.files.length > 0 && handleFilesSelect(Array.from(e.target.files))}
                className="hidden"
              />
              {status === 'uploading' ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-10 h-10 text-primary animate-spin" />
                  <p className="text-sm font-medium text-foreground">Upload en cours...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <Upload className="w-7 h-7 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Glissez un ou plusieurs fichiers audio/vidéo</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      WAV, MP3, FLAC, OGG, M4A, AAC, MP4, MOV, AVI, MKV, WebM, MTS
                    </p>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* Batch file list */}
          {batchMode && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-card border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <Files className="w-3.5 h-3.5" />
                  {batchItems.length} fichiers sélectionnés
                </h3>
                {!batchProcessing && !batchAllDone && (
                  <button onClick={() => { setBatchMode(false); setBatchItems([]); setBatchProcessing(false) }} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    Annuler
                  </button>
                )}
              </div>

              {/* Overall batch progress */}
              {batchProcessing && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="text-primary animate-pulse font-bold uppercase tracking-wider">Traitement en cours</span>
                    <span className="font-mono">{batchDoneCount}/{batchItems.length}</span>
                  </div>
                  <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${batchItems.length > 0 ? (batchDoneCount / batchItems.length) * 100 : 0}%` }}
                      className="h-full bg-primary"
                    />
                  </div>
                </div>
              )}

              {batchAllDone && (
                <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  <p className="text-xs font-medium text-green-400">
                    Toutes les transcriptions sont terminées ! Consultez l'historique.
                  </p>
                </div>
              )}

              {/* File list */}
              <div className="max-h-[400px] overflow-y-auto space-y-1.5 custom-scrollbar">
                {batchItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-secondary/30 border border-border/50">
                    <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                      {item.status === 'done' ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : item.status === 'error' ? (
                        <AlertCircle className="w-4 h-4 text-destructive" />
                      ) : item.status === 'uploading' || item.status === 'extracting-audio' || item.status === 'transcribing' ? (
                        <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      ) : item.status === 'queued' ? (
                        <Clock className="w-4 h-4 text-amber-500" />
                      ) : (
                        <Music className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">{item.filename}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {item.status === 'pending' && 'En attente'}
                        {item.status === 'uploading' && 'Upload...'}
                        {item.status === 'uploaded' && 'Prêt'}
                        {item.status === 'queued' && 'Dans la file'}
                        {item.status === 'extracting-audio' && `Extraction audio... ${Math.round(item.progress)}%`}
                        {item.status === 'transcribing' && `Transcription... ${Math.round(item.progress)}%`}
                        {item.status === 'done' && 'Terminé'}
                        {item.status === 'error' && (item.error || 'Erreur')}
                      </p>
                    </div>
                    {/* Individual progress bar */}
                    {(item.status === 'extracting-audio' || item.status === 'transcribing') && (
                      <div className="w-16 h-1 bg-secondary rounded-full overflow-hidden shrink-0">
                        <div className="h-full bg-primary transition-all" style={{ width: `${item.progress}%` }} />
                      </div>
                    )}
                    {!batchProcessing && item.status === 'pending' && (
                      <button onClick={() => removeBatchItem(item.id)} className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-all shrink-0">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* File info + processing */}
          {uploadedFile && status !== 'done' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-card border border-border rounded-xl p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center">
                  <Music className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">{uploadedFile.name}</p>
                  {uploadedFile.duration > 0 && (
                    <p className="text-xs text-muted-foreground">{fmtTime(uploadedFile.duration)}</p>
                  )}
                </div>
                {!isProcessing && (
                  <button onClick={handleReset} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    Changer
                  </button>
                )}
              </div>

              {/* Progress */}
              {isProcessing && (
                <div className="space-y-3">
                  {status === 'queued' && (
                    <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                      <Clock className="w-4 h-4 text-amber-500 animate-pulse" />
                      <p className="text-xs font-medium text-amber-400">
                        En attente — position {queuePosition} dans la file
                      </p>
                    </div>
                  )}
                  {(status === 'extracting-audio' || status === 'transcribing') && (
                    <>
                      <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground">
                        <span className="text-primary animate-pulse uppercase tracking-wider">
                          {status === 'extracting-audio' ? 'Extraction audio' : 'Transcription'}
                        </span>
                        <span className="font-mono">{Math.round(progress)}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                          className="h-full bg-primary"
                        />
                      </div>
                      {/* Live transcript preview */}
                      {liveSegments.length > 0 && (
                        <div className="bg-secondary/50 rounded-lg p-3 border border-border mt-2">
                          <div className="flex items-center gap-2 mb-1.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                            <span className="text-[9px] font-bold uppercase text-muted-foreground">En direct</span>
                          </div>
                          <div className="space-y-0.5">
                            {liveSegments.slice(-3).map((seg, i) => (
                              <p key={i} className="text-[11px] text-foreground/80 italic leading-relaxed">
                                "{seg.text}"
                              </p>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {/* Error state */}
          {status === 'error' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-destructive/5 border border-destructive/20 rounded-xl p-5 text-center">
              <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
              <p className="text-sm font-semibold text-destructive mb-1">Erreur</p>
              <p className="text-xs text-muted-foreground mb-4">{errorMessage}</p>
              <Button variant="destructive" size="sm" onClick={handleReset}>Réessayer</Button>
            </motion.div>
          )}

          {/* Result */}
          {status === 'done' && segments.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-card border border-border rounded-xl overflow-hidden">
              {/* Toolbar */}
              <div className="flex items-center justify-between p-4 border-b border-border">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  <span className="text-sm font-semibold text-foreground">
                    {segments.length} segments
                    {uploadedFile?.name && <span className="text-muted-foreground font-normal"> — {uploadedFile.name}</span>}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={handleCopy} className="text-xs gap-1.5">
                    {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copié' : 'Copier'}
                  </Button>
                  {transcriptionId && (
                    <>
                      <a href={api.getTranscriptionExportUrl(transcriptionId, 'txt')} download>
                        <Button variant="ghost" size="sm" className="text-xs gap-1.5">
                          <Download className="w-3.5 h-3.5" /> .txt
                        </Button>
                      </a>
                      <a href={api.getTranscriptionExportUrl(transcriptionId, 'srt')} download>
                        <Button variant="ghost" size="sm" className="text-xs gap-1.5">
                          <Download className="w-3.5 h-3.5" /> .srt
                        </Button>
                      </a>
                    </>
                  )}
                  <Button variant="outline" size="sm" onClick={handleReset} className="text-xs">
                    Nouvelle transcription
                  </Button>
                </div>
              </div>

              {/* Transcript text */}
              <div className="max-h-[500px] overflow-y-auto p-4 space-y-1.5 custom-scrollbar">
                {segments.map((seg, i) => (
                  <div key={i} className="flex gap-3 hover:bg-secondary/30 rounded-lg p-1.5 -mx-1.5 transition-colors">
                    <span className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5 w-16 text-right">
                      {fmtTime(seg.start)}
                    </span>
                    <p className="text-xs text-foreground leading-relaxed">{seg.text}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </div>

        {/* Right: Config panel */}
        <div className="space-y-6">
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="bg-card border border-border rounded-xl p-5 space-y-5"
          >
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Mic className="w-3.5 h-3.5" /> Configuration
            </h3>

            {/* Whisper model */}
            <div className="space-y-2">
              <span className="text-[9px] font-bold text-muted-foreground uppercase flex items-center gap-1.5">
                Modèle Whisper
                <InfoTip text="Le modèle de reconnaissance vocale. Large V3 = meilleure qualité. Large V3 Turbo = plus rapide." />
              </span>
              <Select value={whisperModel} onValueChange={setWhisperModel} disabled={isProcessing}>
                <SelectTrigger className="h-9 text-xs">
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

            {/* Language */}
            <div className="space-y-2">
              <span className="text-[9px] font-bold text-muted-foreground uppercase flex items-center gap-1.5">
                Langue
                <InfoTip text="La langue principale parlée dans le fichier audio." />
              </span>
              <Select value={language} onValueChange={setLanguage} disabled={isProcessing}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="fr" className="text-xs cursor-pointer">Français</SelectItem>
                  <SelectItem value="en" className="text-xs cursor-pointer">Anglais</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Vocabulary prompt */}
            <div className="space-y-2">
              <span className="text-[9px] font-bold text-muted-foreground uppercase flex items-center gap-1.5">
                Vocabulaire
                <InfoTip text="Ajoutez des mots rares pour améliorer la reconnaissance : noms propres, termes techniques, patois..." />
              </span>
              <textarea
                value={whisperPrompt}
                onChange={(e) => setWhisperPrompt(e.target.value)}
                placeholder="Noms propres, termes techniques..."
                disabled={isProcessing}
                className="w-full h-20 bg-secondary/10 text-xs text-foreground p-2.5 rounded-lg border border-border focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-muted-foreground/30 resize-none"
              />
            </div>
            {/* Launch button */}
            {batchMode ? (
              <Button
                onClick={handleBatchStart}
                disabled={batchProcessing || batchItems.length === 0 || batchAllDone}
                className="w-full h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold uppercase tracking-wide rounded-lg text-xs"
              >
                <span className="flex items-center gap-2">
                  <Files className="w-4 h-4" />
                  {batchProcessing ? `En cours (${batchDoneCount}/${batchItems.length})...` : `Transcrire ${batchItems.length} fichiers`}
                </span>
              </Button>
            ) : (
              <Button
                onClick={handleStart}
                disabled={!uploadedFile || isProcessing}
                className="w-full h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold uppercase tracking-wide rounded-lg text-xs"
              >
                <span className="flex items-center gap-2">
                  <Mic className="w-4 h-4" />
                  {isProcessing ? "En cours..." : "Lancer la transcription"}
                </span>
              </Button>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  )
}

export default TranscriptionTool

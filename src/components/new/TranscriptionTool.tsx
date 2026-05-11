/**
 * =============================================================================
 * Fichier : TranscriptionTool.tsx
 * Rôle    : Outil de transcription audio/vidéo standalone.
 *
 *           Cet outil est indépendant de la segmentation vidéo IA. Il permet :
 *           - D'uploader un ou plusieurs fichiers audio/vidéo (mode batch)
 *           - De configurer le modèle Whisper, la langue, et le prompt
 *           - De suivre la progression en temps réel via WebSocket
 *           - D'afficher les segments transcrits avec horodatage
 *           - D'identifier les locuteurs (diarisation + noms par Ollama)
 *           - De renommer les locuteurs manuellement
 *           - D'exporter en TXT ou SRT (sous-titres)
 *           - De copier la transcription dans le presse-papier
 *           - De gérer un historique des transcriptions passées
 *
 *           Le traitement tourne côté serveur via la file d'attente IA.
 *           Le composant écoute les événements WebSocket pour mettre à jour
 *           l'interface en temps réel (progression, segments reçus, etc.)
 * =============================================================================
 */

// ── Imports React ──
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"  // Animations fluides
import {
  Mic, ArrowLeft, Upload, Loader2, Copy, Download, Trash2,
  CheckCircle2, AlertCircle, Clock, HelpCircle, FileText, Music, Files, Pencil, X, Check, Brain,
  RotateCcw, Cloud, Search, ChevronDown, Trash
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select"
import api from "@/api"
import SemanticAnalysis from "@/components/new/SemanticAnalysis"
import GridLayout, { Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "react-resizable/css/styles.css"
import type { TranscriptSegment, TranscriptionHistoryItem } from "@/types"

// Extensions de fichiers acceptées par l'outil
const ACCEPTED_EXTENSIONS = '.mp4,.mov,.avi,.mkv,.webm,.mts,.wav,.mp3,.flac,.ogg,.m4a,.aac'
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac']
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mts']
const ALL_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]

/** Props du composant : callback pour revenir en arrière + projet initial optionnel */
interface TranscriptionToolProps {
  onBack: () => void
  initialProject?: any
}

/** Étapes possibles du traitement (machine à états) */
type ToolStatus = 'idle' | 'uploading' | 'queued' | 'extracting-audio' | 'transcribing' | 'diarizing' | 'identifying-speakers' | 'done' | 'error'

/** Élément d'un batch de transcriptions (un fichier = un BatchItem) */
interface BatchItem {
  id: string
  file: File
  filename: string
  status: 'pending' | 'uploading' | 'uploaded' | 'queued' | 'extracting-audio' | 'transcribing' | 'diarizing' | 'identifying-speakers' | 'done' | 'error'
  progress: number
  progressMessage: string
  taskId?: string
  filePath?: string
  transcriptionId?: string
  error?: string
  liveSegments: TranscriptSegment[]
}

/** Petit composant d'info-bulle (tooltip) au survol d'un icône "?" */
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

/**
 * Composant principal de l'outil de transcription.
 * Gère tout le workflow : upload → configuration → traitement → résultats → export.
 */
const TranscriptionTool = ({ onBack, initialProject }: TranscriptionToolProps) => {
  // ── État upload ──
  const [file, setFile] = useState<File | null>(null)
  const [uploadedFile, setUploadedFile] = useState<{ path: string; name: string; duration: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Import de fichier texte (.txt/.docx/.pdf) → transcription synthetique + analyse
  const textInputRef = useRef<HTMLInputElement>(null)
  const [textImporting, setTextImporting] = useState(false)
  const [textImportError, setTextImportError] = useState<string | null>(null)

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
  // Affichage du panneau d'analyse semantique (nuage de mots, frequences, themes)
  const [showSemanticAnalysis, setShowSemanticAnalysis] = useState(false)

  // Project mode state (when opened from home page project card)
  const [projectItems, setProjectItems] = useState<any[]>(initialProject?.data?.transcriptionItems || [])
  const [selectedItem, setSelectedItem] = useState<any | null>(null)
  const [selectedItemSegments, setSelectedItemSegments] = useState<TranscriptSegment[]>([])
  const [selectedItemLoading, setSelectedItemLoading] = useState(false)
  const [projectName, setProjectName] = useState(initialProject?.name || '')
  const [editingProjectName, setEditingProjectName] = useState(false)
  const [projectNameEdit, setProjectNameEdit] = useState('')

  // WebSocket listeners
  useEffect(() => {
    if (allTaskIds.length === 0 && !taskId) return

    let isDone = false
    const unsubProgress = api.onTranscriptionProgress((data: any) => {
      if (isDone) return // Ignore post-save diarization progress
      if (batchMode) {
        if (!allTaskIds.includes(data.taskId)) return
        setBatchItems(prev => prev.map(item => {
          if (item.status === 'done') return item
          return item.taskId === data.taskId
            ? { ...item, status: data.step as BatchItem["status"], progress: data.progress || 0, progressMessage: data.message || "" }
            : item
        }))
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
      isDone = true
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

    // Refresh segments when diarization completes (speakers added post-save)
    const unsubDiarization = api.onDiarizationComplete((data: any) => {
      if (data.transcriptionId) {
        api.getTranscription(data.transcriptionId).then((result: any) => {
          if (result.segments) setSegments(result.segments)
        }).catch(() => {})
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
      unsubDiarization()
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

  /**
   * Importe un fichier texte (.txt/.docx/.pdf) : extrait le texte cote serveur,
   * cree une transcription synthetique (decoupee par paragraphes) puis l'affiche
   * comme une transcription normale → analyse semantique disponible.
   */
  const handleTextImport = useCallback(async (selected: File) => {
    setTextImportError(null)
    setTextImporting(true)
    try {
      const form = new FormData()
      form.append('file', selected)
      const token = localStorage.getItem('clipr-auth-token')
      const res = await fetch('/api/text/import', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Echec import')

      // Bascule directement sur la transcription importee (comme apres un Whisper)
      const transcription = await api.getTranscription(data.transcriptionId)
      setTranscriptionId(data.transcriptionId)
      setSegments(transcription.segments || [])
      setStatus('done')
      setShowSemanticAnalysis(true) // ouvre direct l'analyse, c'est le but
    } catch (e: any) {
      setTextImportError(e.message || 'Echec import')
    } finally {
      setTextImporting(false)
    }
  }, [])

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

  // Listen for transcription:complete events for this project
  useEffect(() => {
    if (!initialProject) return
    const unsub = api.onTranscriptionComplete((data: any) => {
      if (data.projectId !== initialProject.id) return
      setProjectItems(prev => prev.map((item: any) =>
        item.filename === data.filename
          ? { ...item, status: 'done', transcriptionId: data.transcriptionId, duration: data.duration }
          : item
      ))
    })
    return unsub
  }, [initialProject?.id])

  // Load a single project item's transcript
  const handleLoadProjectItem = async (item: any) => {
    if (!item.transcriptionId) return
    setSelectedItem(item)
    setSelectedItemLoading(true)
    setSelectedItemSegments([])
    try {
      const result = await api.getTranscription(item.transcriptionId)
      setSelectedItemSegments(result.segments || [])
    } catch { /* ignore */ }
    finally { setSelectedItemLoading(false) }
  }

  // Rename project
  const handleProjectRename = async () => {
    if (!initialProject || !projectNameEdit.trim()) return
    try {
      await api.renameProject(initialProject.id, projectNameEdit.trim())
      setProjectName(projectNameEdit.trim())
    } catch { /* ignore */ }
    setEditingProjectName(false)
  }

  // Load a past transcription
  const isProcessing = batchProcessing || ['uploading', 'queued', 'extracting-audio', 'transcribing', 'diarizing', 'identifying-speakers'].includes(status)

  // Format time
  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  // ── Vue projet : liste de fichiers ──
  if (initialProject && !selectedItem) {
    const doneCount = projectItems.filter((i: any) => i.status === 'done').length
    const allDone = projectItems.length > 0 && projectItems.every((i: any) => i.status === 'done' || i.status === 'error')

    return (
      <div className="max-w-4xl mx-auto w-full pt-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5 text-muted-foreground" />
          </button>
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Mic className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              {editingProjectName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    value={projectNameEdit}
                    onChange={(e) => setProjectNameEdit(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleProjectRename(); if (e.key === 'Escape') setEditingProjectName(false) }}
                    className="text-lg font-bold text-foreground bg-secondary/50 border border-primary/30 rounded px-2 py-0.5 outline-none focus:ring-1 focus:ring-primary w-full"
                    autoFocus
                  />
                  <button onClick={handleProjectRename} className="p-1 text-green-500 hover:text-green-400 shrink-0"><Check className="w-4 h-4" /></button>
                  <button onClick={() => setEditingProjectName(false)} className="p-1 text-muted-foreground hover:text-foreground shrink-0"><X className="w-4 h-4" /></button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-bold text-foreground truncate">{projectName}</h1>
                  <button onClick={() => { setProjectNameEdit(projectName); setEditingProjectName(true) }} className="p-1 text-muted-foreground/50 hover:text-foreground transition-colors shrink-0">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {doneCount}/{projectItems.length} fichier{projectItems.length > 1 ? 's' : ''} transcrit{doneCount > 1 ? 's' : ''}
                {!allDone && <span className="text-amber-400"> · En cours...</span>}
              </p>
            </div>
          </div>
        </div>

        {/* File list */}
        <div className="space-y-3">
          {projectItems.map((item: any, i: number) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              onClick={() => item.status === 'done' && item.transcriptionId && handleLoadProjectItem(item)}
              className={`bg-card border rounded-xl p-4 flex items-center gap-4 transition-all ${
                item.status === 'done' && item.transcriptionId
                  ? 'border-border hover:border-primary/50 hover:bg-secondary/30 cursor-pointer'
                  : 'border-border/50 opacity-80'
              }`}
            >
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                item.status === 'done' ? 'bg-green-500/10' : item.status === 'error' ? 'bg-destructive/10' : 'bg-amber-500/10'
              }`}>
                {item.status === 'done' ? (
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                ) : item.status === 'error' ? (
                  <AlertCircle className="w-5 h-5 text-destructive" />
                ) : (
                  <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground truncate">{item.filename}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {item.status === 'done' && item.duration ? fmtTime(item.duration) + ' · ' : ''}
                  {item.status === 'done' ? 'Terminé — cliquer pour voir' : item.status === 'error' ? 'Erreur' : 'Transcription en cours...'}
                </p>
              </div>
              {item.status === 'done' && item.transcriptionId && (
                <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {/* Lien direct stylise comme un bouton. Un vrai <button> imbrique dans
                      <a> intercepte le clic et empeche le download — d'ou le <span>. */}
                  <a href={api.getTranscriptionExportUrl(item.transcriptionId, 'txt')} download onClick={(e) => e.stopPropagation()}
                     className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-colors">
                    <Download className="w-3 h-3" /> .txt
                  </a>
                  <a href={api.getTranscriptionExportUrl(item.transcriptionId, 'srt')} download onClick={(e) => e.stopPropagation()}
                     className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-colors">
                    <Download className="w-3 h-3" /> .srt
                  </a>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    )
  }

  // ── Vue projet : mode NLE si analyse semantique activee ──
  if (initialProject && selectedItem && selectedItemSegments.length > 0 && showSemanticAnalysis) {
    return (
      <TranscriptionResult
        segments={selectedItemSegments}
        transcriptionId={selectedItem.transcriptionId}
        uploadedFileName={selectedItem.filename}
        copied={copied}
        onCopy={handleCopy}
        onReset={() => setShowSemanticAnalysis(false)}
        onSegmentsUpdate={setSelectedItemSegments}
        ollamaModel="qwen2.5:14b"
        projectId={initialProject?.id}
        savedSemanticResult={initialProject?.data?.semanticAnalysis}
      />
    )
  }

  if (initialProject && selectedItem) {
    return (
      <div className="max-w-4xl mx-auto w-full pt-8">
        <div className="flex items-center gap-4 mb-8">
          <button onClick={() => { setSelectedItem(null); setSelectedItemSegments([]) }} className="p-2 rounded-lg hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5 text-muted-foreground" />
          </button>
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-foreground truncate">{selectedItem.filename}</h1>
              <p className="text-xs text-muted-foreground">{projectName}</p>
            </div>
          </div>
          {selectedItem.transcriptionId && !selectedItemLoading && (
            <div className="flex items-center gap-2 shrink-0">
              <a href={api.getTranscriptionExportUrl(selectedItem.transcriptionId, 'txt')} download
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-colors">
                <Download className="w-3.5 h-3.5" /> .txt
              </a>
              <a href={api.getTranscriptionExportUrl(selectedItem.transcriptionId, 'srt')} download
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-colors">
                <Download className="w-3.5 h-3.5" /> .srt
              </a>
              <button
                onClick={() => setShowSemanticAnalysis(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 text-xs font-medium transition-colors"
              >
                <Brain className="w-3.5 h-3.5" /> Analyse semantique
              </button>
            </div>
          )}
        </div>

        {selectedItemLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="max-h-[600px] overflow-y-auto p-4 space-y-1.5 custom-scrollbar">
              {selectedItemSegments.map((seg, i) => {
                const prevSpeaker = i > 0 ? selectedItemSegments[i - 1].speaker : null
                const showSpeaker = seg.speaker && seg.speaker !== prevSpeaker
                return (
                  <div key={i}>
                    {showSpeaker && (
                      <div className="mt-3 mb-1 first:mt-0">
                        <span
                          className="text-[10px] font-bold uppercase tracking-wider text-primary cursor-pointer hover:underline"
                          title="Cliquer pour renommer ce locuteur"
                          onClick={() => {
                            const tid = selectedItem?.transcriptionId
                            const newName = prompt(`Renommer "${seg.speaker}" en :`, seg.speaker || '')
                            if (newName && newName !== seg.speaker && tid) {
                              api.renameSpeaker(tid, seg.speaker!, newName).then((result) => {
                                if (result.segments) setSelectedItemSegments(result.segments)
                              }).catch(() => {})
                            }
                          }}
                        >{seg.speaker}</span>
                      </div>
                    )}
                    <div className="flex gap-3 hover:bg-secondary/30 rounded-lg p-1.5 -mx-1.5 transition-colors">
                      <span className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5 w-16 text-right">
                        {fmtTime(seg.start)}
                      </span>
                      <p className="text-xs text-foreground leading-relaxed">{seg.text}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Mode NLE plein ecran : active par le bouton "Analyse semantique" ──
  if (status === 'done' && segments.length > 0 && showSemanticAnalysis) {
    return (
      <TranscriptionResult
        segments={segments}
        transcriptionId={transcriptionId}
        uploadedFileName={uploadedFile?.name}
        copied={copied}
        onCopy={handleCopy}
        onReset={() => setShowSemanticAnalysis(false)}
        onSegmentsUpdate={setSegments}
        ollamaModel="qwen2.5:14b"
      />
    )
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
            <h1 className="text-lg font-bold text-foreground">Transcription audio/video</h1>
            <p className="text-xs text-muted-foreground">Transcrire un ou plusieurs fichiers audio/vidéo avec Whisper</p>
          </div>
        </div>
      </div>

      <div className={`grid gap-6 ${status === 'done' ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-3'}`}>
        {/* Left: Upload + Result (pleine largeur quand resultats affiches) */}
        <div className={`${status === 'done' ? '' : 'lg:col-span-2'} space-y-6`}>
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

          {/* ── Import de texte (.txt/.docx/.pdf) → analyse sans audio ── */}
          {!uploadedFile && !batchMode && status !== 'done' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-center gap-3 -mt-3">
              <span className="text-xs text-muted-foreground">ou</span>
              <input
                ref={textInputRef}
                type="file"
                accept=".txt,.docx,.pdf"
                onChange={(e) => e.target.files?.[0] && handleTextImport(e.target.files[0])}
                className="hidden"
              />
              <button
                type="button"
                disabled={textImporting}
                onClick={() => textInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-colors disabled:opacity-50"
              >
                {textImporting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extraction...</>
                  : <><Upload className="w-3.5 h-3.5" /> Importer un texte (.txt / .docx / .pdf)</>}
              </button>
            </motion.div>
          )}
          {textImportError && (
            <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-xs text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {textImportError}
            </div>
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
                        {item.status === 'diarizing' && `Identification locuteurs... ${Math.round(item.progress)}%`}
                        {item.status === 'identifying-speakers' && 'Detection des noms...'}
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
                  {(status === 'extracting-audio' || status === 'transcribing' || status === 'diarizing' || status === 'identifying-speakers') && (
                    <>
                      <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground">
                        <span className="text-primary animate-pulse uppercase tracking-wider">
                          {status === 'extracting-audio' ? 'Extraction audio' : status === 'diarizing' ? 'Identification locuteurs' : status === 'identifying-speakers' ? 'Detection noms' : 'Transcription'}
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

          {/* Result — transcript simple avec bouton pour passer en mode analyse plein ecran */}
          {status === 'done' && segments.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-card border border-border rounded-xl overflow-hidden">
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
                    {copied ? 'Copie' : 'Copier'}
                  </Button>
                  {transcriptionId && (
                    <>
                      {/* asChild : le Button rend l'anchor en lui appliquant ses styles
                          (Radix Slot), evite le <button> imbrique qui intercepte le clic. */}
                      <Button asChild variant="ghost" size="sm" className="text-xs gap-1.5">
                        <a href={api.getTranscriptionExportUrl(transcriptionId, 'txt')} download><Download className="w-3.5 h-3.5" /> .txt</a>
                      </Button>
                      <Button asChild variant="ghost" size="sm" className="text-xs gap-1.5">
                        <a href={api.getTranscriptionExportUrl(transcriptionId, 'srt')} download><Download className="w-3.5 h-3.5" /> .srt</a>
                      </Button>
                    </>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setShowSemanticAnalysis(true)} className="text-xs gap-1.5 border-primary/30 text-primary hover:bg-primary/10">
                    <Brain className="w-3.5 h-3.5" /> Analyse semantique
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleReset} className="text-xs">Nouvelle transcription</Button>
                </div>
              </div>
              <div className="max-h-[500px] overflow-y-auto p-4 space-y-1.5 custom-scrollbar">
                {segments.map((seg, i) => {
                  const prevSpeaker = i > 0 ? segments[i - 1].speaker : null
                  const showSpeaker = seg.speaker && seg.speaker !== prevSpeaker
                  return (
                    <div key={i}>
                      {showSpeaker && (
                        <div className="mt-3 mb-1 first:mt-0">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-primary cursor-pointer hover:underline"
                            onClick={(e) => {
                              e.stopPropagation()
                              const newName = prompt(`Renommer "${seg.speaker}" en :`, seg.speaker || '')
                              if (newName && newName !== seg.speaker && transcriptionId) {
                                api.renameSpeaker(transcriptionId, seg.speaker!, newName).then((r: any) => { if (r.segments) setSegments(r.segments) }).catch(() => {})
                              }
                            }}
                          >{seg.speaker}</span>
                        </div>
                      )}
                      <div className="flex gap-3 hover:bg-secondary/30 rounded-lg p-1.5 -mx-1.5 transition-colors">
                        <span className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5 w-16 text-right">{fmtTime(seg.start)}</span>
                        <p className="text-xs text-foreground leading-relaxed">{seg.text}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}
        </div>

        {/* Right: Config panel — masque quand les resultats sont affiches */}
        {status !== 'done' && (
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
                  {status === 'diarizing' ? "Identification locuteurs..." :
                   status === 'identifying-speakers' ? "Detection noms..." :
                   status === 'extracting-audio' ? "Extraction audio..." :
                   status === 'transcribing' ? `Transcription... ${Math.round(progress)}%` :
                   status === 'queued' ? "En file d'attente..." :
                   isProcessing ? "En cours..." : "Lancer la transcription"}
                </span>
              </Button>
            )}
          </motion.div>
        </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// SOUS-COMPOSANT : Resultat de transcription plein ecran
// 3 panneaux redimensionnables (react-grid-layout) comme l'editeur NLE :
// - Transcription (texte avec speakers et timestamps)
// - Nuage de mots (SVG interactif)
// - Frequences & Analyse IA (tableau + themes/sentiment/insights)
// ============================================================

import { computeWordFrequencies, getWordCloudData, getSpeakers } from '@/lib/word-frequency'
import { exportAnalysisPDF } from '@/lib/export-pdf'
import type { WordFrequency as WordFreqType } from '@/types'

const RESULT_STORAGE_KEY = 'clipr-transcription-result-layout'
const RESULT_COLS = 12
const RESULT_ROW_HEIGHT = 80
const RESULT_GAP = 6

/** Disposition par defaut : 4 panneaux redimensionnables
 * - transcript : texte avec speakers (gauche)
 * - wordcloud : nuage de mots interactif (haut droite)
 * - frequencies : tableau de frequences par locuteur (milieu droite)
 * - analysis : analyse IA themes/sentiment/insights (bas droite)
 */
const DEFAULT_RESULT_LAYOUT: Layout[] = [
  { i: 'transcript', x: 0, y: 0, w: 5, h: 7, minW: 3, minH: 3 },
  { i: 'wordcloud', x: 5, y: 0, w: 7, h: 3, minW: 3, minH: 2 },
  { i: 'frequencies', x: 5, y: 3, w: 7, h: 2, minW: 3, minH: 2 },
  { i: 'analysis', x: 5, y: 5, w: 7, h: 2, minW: 3, minH: 2 },
]

function TranscriptionResult({
  segments,
  transcriptionId,
  uploadedFileName,
  copied,
  onCopy,
  onReset,
  onSegmentsUpdate,
  ollamaModel,
  projectId,
  savedSemanticResult,
}: {
  segments: TranscriptSegment[]
  transcriptionId: string | null
  uploadedFileName?: string
  copied: boolean
  onCopy: () => void
  onReset: () => void
  onSegmentsUpdate: (segs: TranscriptSegment[]) => void
  ollamaModel: string
  /** ID du projet pour sauvegarder les resultats */
  projectId?: string
  /** Resultats deja sauvegardes dans le projet (evite de relancer Ollama) */
  savedSemanticResult?: any
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [resultLayout, setResultLayout] = useState<Layout[]>(() => {
    try {
      const saved = localStorage.getItem(RESULT_STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length === 4) return parsed
      }
    } catch {}
    return DEFAULT_RESULT_LAYOUT
  })

  // Mots exclus par l'utilisateur (retires du tableau et du nuage)
  const [excludedWords, setExcludedWords] = useState<Set<string>>(new Set())

  // Mot selectionne pour la navigation dans le transcript
  const [highlightedWord, setHighlightedWord] = useState<string | null>(null)
  const [highlightIndex, setHighlightIndex] = useState(0) // quelle occurrence

  // Recherche dans le transcript
  const [transcriptSearch, setTranscriptSearch] = useState('')

  // Refs pour scroller vers les segments du transcript
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  // Ref vers le SVG du nuage de mots pour l'export PDF
  const wordCloudSvgRef = useRef<SVGElement | null>(null)

  // Donnees calculees pour le nuage et le tableau (instantane, cote client)
  // Filtre les mots exclus par l'utilisateur
  const allFrequencies = useMemo(() => computeWordFrequencies(segments), [segments])
  const frequencies = useMemo(() => allFrequencies.filter(f => !excludedWords.has(f.word)), [allFrequencies, excludedWords])
  const speakers = useMemo(() => getSpeakers(segments), [segments])
  const cloudData = useMemo(() => getWordCloudData(frequencies), [frequencies])

  // Trouver toutes les occurrences d'un mot dans les segments (indices)
  const highlightOccurrences = useMemo(() => {
    if (!highlightedWord) return []
    const word = highlightedWord.toLowerCase()
    const indices: number[] = []
    segments.forEach((seg, i) => {
      if (seg.text.toLowerCase().includes(word)) indices.push(i)
    })
    return indices
  }, [highlightedWord, segments])

  // Naviguer vers la prochaine occurrence du mot dans le transcript
  const navigateToWord = useCallback((word: string) => {
    if (highlightedWord === word) {
      // Meme mot : passer a l'occurrence suivante
      const nextIdx = (highlightIndex + 1) % Math.max(1, highlightOccurrences.length)
      setHighlightIndex(nextIdx)
      // Scroller vers le segment
      const segIdx = highlightOccurrences[nextIdx]
      if (segIdx !== undefined) {
        const el = transcriptScrollRef.current?.querySelector(`[data-seg-index="${segIdx}"]`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } else {
      // Nouveau mot : commencer a la premiere occurrence
      setHighlightedWord(word)
      setHighlightIndex(0)
      // On attend le prochain render pour scroller (les occurrences vont etre recalculees)
      setTimeout(() => {
        const wordLower = word.toLowerCase()
        let firstIdx = -1
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].text.toLowerCase().includes(wordLower)) { firstIdx = i; break }
        }
        if (firstIdx >= 0) {
          const el = transcriptScrollRef.current?.querySelector(`[data-seg-index="${firstIdx}"]`)
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }, 50)
    }
  }, [highlightedWord, highlightIndex, highlightOccurrences, segments])

  // Exclure un mot du tableau et du nuage
  const excludeWord = useCallback((word: string) => {
    setExcludedWords(prev => new Set([...prev, word]))
    if (highlightedWord === word) setHighlightedWord(null)
  }, [highlightedWord])

  // Ajouter un mot exclu de nouveau (le remettre)
  const includeWord = useCallback((word: string) => {
    setExcludedWords(prev => { const next = new Set(prev); next.delete(word); return next })
  }, [])

  // Analyse IA — utilise les resultats sauvegardes si disponibles, sinon lance Ollama
  const [semanticResult, setSemanticResult] = useState<any>(savedSemanticResult || null)
  const [semanticLoading, setSemanticLoading] = useState(false)
  const [semanticError, setSemanticError] = useState<string | null>(null)
  const semanticLoaded = useRef(!!savedSemanticResult)

  // Lancer l'analyse Ollama uniquement si pas deja sauvegardee
  useEffect(() => {
    if (semanticLoaded.current) return
    semanticLoaded.current = true
    setSemanticLoading(true)
    api.semanticAnalyze(segments, ollamaModel)
      .then((data) => {
        setSemanticResult(data.semanticAnalysis)
        // Sauvegarder les resultats dans le projet pour ne pas relancer Ollama
        // On charge d'abord les donnees existantes pour ne pas les ecraser
        if (projectId) {
          api.loadProjectById(projectId).then((project: any) => {
            if (project?.data) {
              api.saveProject({ id: projectId, ...project.data, semanticAnalysis: data.semanticAnalysis }).catch(() => {})
            }
          }).catch(() => {})
        }
      })
      .catch((err) => setSemanticError(err.message))
      .finally(() => setSemanticLoading(false))
  }, [segments, ollamaModel, projectId])

  // Mesurer la largeur du conteneur
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.offsetWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleLayoutChange = useCallback((newLayout: Layout[]) => {
    setResultLayout(newLayout)
    localStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(newLayout))
  }, [])

  const resetLayout = useCallback(() => {
    setResultLayout([...DEFAULT_RESULT_LAYOUT])
    localStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(DEFAULT_RESULT_LAYOUT))
  }, [])

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  // Export PDF avec tout le contenu (analyse + nuage + frequences + transcript)
  const [exportingPdf, setExportingPdf] = useState(false)
  const handleExportPDF = async () => {
    setExportingPdf(true)
    try {
      await exportAnalysisPDF({
        title: uploadedFileName || 'Transcription',
        filename: uploadedFileName,
        segments,
        frequencies,
        speakers,
        semanticResult,
        wordCloudSvg: wordCloudSvgRef.current,
      })
    } catch (err) {
      console.error('Erreur export PDF:', err)
    }
    setExportingPdf(false)
  }

  return (
    <div ref={containerRef} className="relative min-h-[calc(100vh-3.5rem)]">
      {width > 0 && (
        <GridLayout
          layout={resultLayout}
          cols={RESULT_COLS}
          rowHeight={RESULT_ROW_HEIGHT}
          width={width}
          margin={[RESULT_GAP, RESULT_GAP]}
          containerPadding={[RESULT_GAP, RESULT_GAP]}
          onLayoutChange={handleLayoutChange}
          draggableHandle=".panel-drag-handle"
          isResizable
          isDraggable
          useCSSTransforms
          resizeHandles={['se', 'sw', 'ne', 'nw', 'e', 'w', 'n', 's']}
        >
          {/* ── Panneau 1 : Transcription (avec surlignage et recherche) ── */}
          <div key="transcript" className="h-full">
            <div className="h-full bg-card border border-border rounded-xl overflow-hidden flex flex-col">
              <div className="panel-drag-handle flex items-center justify-between px-4 py-2 border-b border-border cursor-move bg-secondary/20">
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Transcription</span>
                  <span className="text-[9px] text-muted-foreground/60">{segments.length} seg.</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={onCopy} className="h-6 text-[10px] gap-1 px-2">
                    {copied ? <CheckCircle2 className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copie' : 'Copier'}
                  </Button>
                  {transcriptionId && (
                    <>
                      <Button asChild variant="ghost" size="sm" className="h-6 text-[10px] gap-1 px-2">
                        <a href={api.getTranscriptionExportUrl(transcriptionId, 'txt')} download><Download className="w-3 h-3" /> .txt</a>
                      </Button>
                      <Button asChild variant="ghost" size="sm" className="h-6 text-[10px] gap-1 px-2">
                        <a href={api.getTranscriptionExportUrl(transcriptionId, 'srt')} download><Download className="w-3 h-3" /> .srt</a>
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="sm" onClick={handleExportPDF} disabled={exportingPdf} className="h-6 text-[10px] gap-1 px-2 text-primary">
                    {exportingPdf ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} PDF
                  </Button>
                  <Button variant="ghost" size="sm" onClick={onReset} className="h-6 text-[10px] px-2">Retour</Button>
                </div>
              </div>
              {/* Barre de recherche dans le transcript */}
              <div className="px-3 py-1.5 border-b border-border/50 flex items-center gap-2">
                <Search className="w-3 h-3 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  value={transcriptSearch}
                  onChange={e => { setTranscriptSearch(e.target.value); if (e.target.value) navigateToWord(e.target.value) }}
                  placeholder="Rechercher dans le texte..."
                  className="flex-1 text-[10px] bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40"
                />
                {transcriptSearch && (
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] text-muted-foreground">{highlightOccurrences.length} trouvé{highlightOccurrences.length > 1 ? 's' : ''}</span>
                    <button onClick={() => navigateToWord(transcriptSearch)} className="p-0.5 hover:bg-secondary rounded" title="Occurrence suivante">
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    </button>
                    <button onClick={() => { setTranscriptSearch(''); setHighlightedWord(null) }} className="p-0.5 hover:bg-secondary rounded">
                      <X className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                )}
              </div>
              {/* Contenu du transcript avec surlignage */}
              <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto p-4 space-y-1.5 custom-scrollbar">
                {segments.map((seg, i) => {
                  const prevSpeaker = i > 0 ? segments[i - 1].speaker : null
                  const showSpeaker = seg.speaker && seg.speaker !== prevSpeaker
                  const isHighlighted = highlightedWord && seg.text.toLowerCase().includes(highlightedWord.toLowerCase())
                  const isCurrentOccurrence = highlightOccurrences[highlightIndex] === i
                  return (
                    <div key={i} data-seg-index={i}>
                      {showSpeaker && (
                        <div className="mt-3 mb-1 first:mt-0">
                          <span
                            className="text-[10px] font-bold uppercase tracking-wider text-primary cursor-pointer hover:underline"
                            title="Cliquer pour renommer ce locuteur"
                            onClick={(e) => {
                              e.stopPropagation()
                              const newName = prompt(`Renommer "${seg.speaker}" en :`, seg.speaker || '')
                              if (newName && newName !== seg.speaker && transcriptionId) {
                                api.renameSpeaker(transcriptionId, seg.speaker!, newName).then((result: any) => {
                                  if (result.segments) onSegmentsUpdate(result.segments)
                                }).catch(() => {})
                              }
                            }}
                          >{seg.speaker}</span>
                        </div>
                      )}
                      <div className={`flex gap-3 rounded-lg p-1.5 -mx-1.5 transition-colors ${
                        isCurrentOccurrence ? 'bg-primary/20 ring-1 ring-primary/40' :
                        isHighlighted ? 'bg-primary/10' :
                        'hover:bg-secondary/30'
                      }`}>
                        <span className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5 w-16 text-right">
                          {fmtTime(seg.start)}
                        </span>
                        <p className="text-xs text-foreground leading-relaxed">
                          {highlightedWord ? highlightText(seg.text, highlightedWord) : seg.text}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* ── Panneau 2 : Nuage de mots ── */}
          <div key="wordcloud" className="h-full">
            <div className="h-full bg-card border border-border rounded-xl overflow-hidden flex flex-col">
              <div className="panel-drag-handle flex items-center gap-2 px-4 py-2 border-b border-border cursor-move bg-secondary/20">
                <Cloud className="w-3.5 h-3.5 text-primary" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Nuage de mots</span>
              </div>
              <div className="flex-1 overflow-hidden p-2">
                <WordCloudPanel data={cloudData} frequencies={frequencies} speakers={speakers} onWordClick={navigateToWord} svgRef={wordCloudSvgRef} />
              </div>
            </div>
          </div>

          {/* ── Panneau 3 : Tableau de frequences par locuteur ── */}
          <div key="frequencies" className="h-full">
            <div className="h-full bg-card border border-border rounded-xl overflow-hidden flex flex-col">
              <div className="panel-drag-handle flex items-center gap-2 px-4 py-2 border-b border-border cursor-move bg-secondary/20">
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Frequences</span>
                <span className="text-[9px] text-muted-foreground/60">{frequencies.length} mots</span>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                <FrequencyTablePanel
                  frequencies={frequencies}
                  speakers={speakers}
                  onWordClick={navigateToWord}
                  onWordExclude={excludeWord}
                  highlightedWord={highlightedWord}
                />
              </div>
            </div>
          </div>

          {/* ── Panneau 4 : Analyse IA (themes, sentiment, insights) ── */}
          <div key="analysis" className="h-full">
            <div className="h-full bg-card border border-border rounded-xl overflow-hidden flex flex-col">
              <div className="panel-drag-handle flex items-center gap-2 px-4 py-2 border-b border-border cursor-move bg-secondary/20">
                <Brain className="w-3.5 h-3.5 text-primary" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Analyse IA</span>
                {semanticLoading && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                <AnalysisIAPanel result={semanticResult} loading={semanticLoading} error={semanticError} />
              </div>
            </div>
          </div>
        </GridLayout>
      )}

      {/* Bouton reset layout */}
      <div className="sticky bottom-0 flex justify-end p-2 pointer-events-none">
        <Button
          variant="ghost" size="sm" onClick={resetLayout}
          className="h-6 px-2 gap-1 text-[9px] text-muted-foreground/40 hover:text-muted-foreground uppercase tracking-wider font-bold pointer-events-auto"
          title="Reinitialiser la disposition"
        >
          <RotateCcw className="w-3 h-3" /> Reset
        </Button>
      </div>
    </div>
  )
}

// ── Sous-composant : Nuage de mots SVG (d3-cloud) ──
// @ts-ignore
import cloudLayout from 'd3-cloud'

const SPEAKER_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']

function WordCloudPanel({ data, frequencies, speakers, onWordClick, svgRef }: {
  data: { text: string; value: number }[]
  frequencies: WordFreqType[]
  speakers: string[]
  onWordClick?: (word: string) => void
  svgRef?: React.MutableRefObject<SVGElement | null>
}) {
  const [words, setWords] = useState<any[]>([])
  const [hoveredWord, setHoveredWord] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 500, h: 300 })

  // Couleur par mot selon le speaker dominant
  const wordColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const freq of frequencies) {
      let maxSpeaker = '', maxCount = 0
      for (const [speaker, count] of Object.entries(freq.speakers)) {
        if (count > maxCount) { maxCount = count; maxSpeaker = speaker }
      }
      const idx = speakers.indexOf(maxSpeaker)
      map.set(freq.word, SPEAKER_COLORS[idx >= 0 ? idx % SPEAKER_COLORS.length : 0])
    }
    return map
  }, [frequencies, speakers])

  // Mesurer le conteneur
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    update()
    const obs = new ResizeObserver(update)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Calculer le layout d3-cloud
  useEffect(() => {
    if (data.length === 0 || size.w < 100) return
    const maxVal = Math.max(...data.map(d => d.value))
    const minVal = Math.min(...data.map(d => d.value))
    const scale = (val: number) => {
      if (maxVal === minVal) return 18
      return 10 + ((val - minVal) / (maxVal - minVal)) * Math.min(42, size.w / 14)
    }

    cloudLayout()
      .size([size.w, size.h])
      .words(data.map(d => ({ text: d.text, size: scale(d.value) })))
      .padding(3)
      .rotate(() => (Math.random() > 0.7 ? 90 : 0))
      .fontSize((d: any) => d.size)
      .on('end', (laid: any[]) => setWords(laid.map(w => ({
        text: w.text, size: w.size, x: w.x, y: w.y, rotate: w.rotate,
        color: wordColorMap.get(w.text!) || SPEAKER_COLORS[0]
      }))))
      .start()
  }, [data, size, wordColorMap])

  const hoveredFreq = hoveredWord ? frequencies.find(f => f.word === hoveredWord) : null

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {speakers.length > 0 && (
        <div className="absolute top-1 left-2 flex items-center gap-2 z-10">
          {speakers.map((s, i) => (
            <div key={s} className="flex items-center gap-1 text-[8px] text-muted-foreground">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }} />
              {s}
            </div>
          ))}
        </div>
      )}
      <svg ref={(el) => { if (svgRef) svgRef.current = el }} viewBox={`${-size.w/2} ${-size.h/2} ${size.w} ${size.h}`} className="w-full h-full">
        {words.map((w, i) => (
          <text
            key={`${w.text}-${i}`}
            textAnchor="middle"
            transform={`translate(${w.x},${w.y}) rotate(${w.rotate})`}
            fontSize={w.size}
            fill={w.color}
            opacity={hoveredWord && hoveredWord !== w.text ? 0.2 : 1}
            className="cursor-pointer transition-opacity duration-150 select-none"
            style={{ fontWeight: w.size > 25 ? 700 : 500 }}
            onMouseEnter={() => setHoveredWord(w.text)}
            onMouseLeave={() => setHoveredWord(null)}
            onClick={() => onWordClick?.(w.text)}
          >{w.text}</text>
        ))}
      </svg>
      {hoveredFreq && (
        <div className="absolute top-1 right-1 bg-card border border-border rounded-lg p-2 shadow-lg text-[10px] z-20 max-w-[200px]">
          <div className="font-bold text-foreground mb-1">« {hoveredFreq.word} »</div>
          <div className="text-muted-foreground">Prononce {hoveredFreq.total} fois au total</div>
          {/* Detail par locuteur si plusieurs personnes utilisent ce mot */}
          {Object.keys(hoveredFreq.speakers).length > 1 && (
            <div className="mt-1.5 pt-1.5 border-t border-border/50 space-y-0.5">
              <div className="text-[9px] text-muted-foreground/60 uppercase font-bold mb-0.5">Par locuteur</div>
              {Object.entries(hoveredFreq.speakers).map(([s, c]) => (
                <div key={s} className="flex justify-between gap-3"><span className="text-muted-foreground">{s}</span><span className="font-mono font-bold">{c} fois</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Sous-composant : Tableau de frequences ──
function FrequencyTablePanel({ frequencies, speakers, onWordClick, onWordExclude, highlightedWord }: {
  frequencies: WordFreqType[]; speakers: string[]
  onWordClick?: (word: string) => void
  onWordExclude?: (word: string) => void
  highlightedWord?: string | null
}) {
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState<string>('total')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const filtered = useMemo(() => {
    let list = frequencies
    if (search) list = list.filter(f => f.word.includes(search.toLowerCase()))
    return [...list].sort((a, b) => {
      const va = sortCol === 'word' ? a.word : sortCol === 'total' ? a.total : (a.speakers[sortCol] || 0)
      const vb = sortCol === 'word' ? b.word : sortCol === 'total' ? b.total : (b.speakers[sortCol] || 0)
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [frequencies, search, sortCol, sortDir])

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="relative mb-2">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
        <input type="text" placeholder="Rechercher..." value={search} onChange={e => setSearch(e.target.value)}
          className="w-full pl-7 pr-2 py-1.5 text-[10px] bg-secondary/50 border border-border rounded-lg outline-none focus:ring-1 focus:ring-primary text-foreground" />
      </div>
      <div className="flex-1 overflow-auto rounded-lg border border-border">
        <table className="w-full text-[10px]">
          <thead className="bg-secondary/50 sticky top-0">
            <tr>
              <th className="text-left px-2 py-1.5 font-semibold text-muted-foreground cursor-pointer" onClick={() => handleSort('word')}>Mot</th>
              <th className="text-right px-2 py-1.5 font-semibold text-muted-foreground cursor-pointer" onClick={() => handleSort('total')}>Total</th>
              {speakers.map(s => (
                <th key={s} className="text-right px-2 py-1.5 font-semibold text-muted-foreground cursor-pointer truncate max-w-[80px]" onClick={() => handleSort(s)}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((f, i) => (
              <tr
                key={f.word}
                className={`group border-t border-border/50 cursor-pointer transition-colors ${
                  highlightedWord === f.word ? 'bg-primary/20' :
                  i % 2 ? 'bg-secondary/10 hover:bg-secondary/30' : 'hover:bg-secondary/30'
                }`}
                onClick={() => onWordClick?.(f.word)}
                title={`Cliquer pour trouver "${f.word}" dans le texte`}
              >
                <td className="px-2 py-1 font-medium text-foreground flex items-center gap-1">
                  {f.word}
                  {onWordExclude && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onWordExclude(f.word) }}
                      className="opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5 rounded"
                      title="Exclure ce mot"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </td>
                <td className="px-2 py-1 text-right font-mono font-bold text-primary">{f.total}</td>
                {speakers.map(s => (
                  <td key={s} className="px-2 py-1 text-right font-mono text-muted-foreground">{f.speakers[s] || 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[9px] text-muted-foreground mt-1">{filtered.length} mots</div>
    </div>
  )
}

// ── Sous-composant : Analyse IA (themes, sentiment, insights) ──
function AnalysisIAPanel({ result, loading, error }: { result: any; loading: boolean; error: string | null }) {
  if (loading) return (
    <div className="flex flex-col items-center justify-center py-12 gap-2">
      <Loader2 className="w-6 h-6 text-primary animate-spin" />
      <p className="text-[10px] text-muted-foreground">Analyse semantique en cours...</p>
    </div>
  )
  if (error) return (
    <div className="flex flex-col items-center justify-center py-12 gap-2">
      <AlertCircle className="w-6 h-6 text-destructive" />
      <p className="text-[10px] text-destructive">{error}</p>
    </div>
  )
  if (!result) return (
    <div className="flex items-center justify-center py-12 text-[10px] text-muted-foreground">Chargement...</div>
  )

  const sentimentColor: Record<string, string> = {
    positif: 'bg-green-500/10 text-green-400', negatif: 'bg-red-500/10 text-red-400',
    mixte: 'bg-amber-500/10 text-amber-400', neutre: 'bg-zinc-500/10 text-zinc-400',
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Themes</h3>
        <div className="flex flex-wrap gap-1.5">
          {result.themes?.map((t: string, i: number) => (
            <span key={i} className="px-2 py-0.5 bg-primary/10 text-primary border border-primary/20 rounded-full text-[9px] font-medium">{t}</span>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Sentiment</h3>
        <div className="flex items-start gap-2">
          <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold capitalize ${sentimentColor[result.sentiment?.label] || sentimentColor.neutre}`}>{result.sentiment?.label}</span>
          <p className="text-[10px] text-muted-foreground leading-relaxed">{result.sentiment?.explanation}</p>
        </div>
      </div>
      <div>
        <h3 className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Points cles</h3>
        <ul className="space-y-1.5">
          {result.insights?.map((ins: string, i: number) => (
            <li key={i} className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
              <span className="text-primary font-bold shrink-0">{i + 1}.</span>
              <span className="leading-relaxed">{ins}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ── Utilitaire : surligner un mot dans un texte ──
// Retourne un tableau de JSX avec le mot en surbrillance
function highlightText(text: string, word: string): React.ReactNode {
  if (!word) return text
  const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const parts = text.split(regex)
  return parts.map((part, i) =>
    regex.test(part) ? <mark key={i} className="bg-primary/30 text-foreground rounded px-0.5">{part}</mark> : part
  )
}

export default TranscriptionTool

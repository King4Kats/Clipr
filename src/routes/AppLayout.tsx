/**
 * APPLAYOUT.TSX : Layout principal de l'application (shell)
 *
 * Contient les elements communs a toutes les pages authentifiees :
 * - Header (barre de navigation sticky)
 * - SetupWizard (modal de configuration au premier lancement)
 * - ShareDialog (modal de partage de projet)
 * - Listeners WebSocket (progression, transcription, analyse)
 * - Raccourcis clavier globaux (Ctrl+Z / Ctrl+Shift+Z)
 *
 * Les pages enfants sont rendues via <Outlet /> de React Router.
 */

import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useStore } from '@/store/useStore'
import { useAuthStore } from '@/store/useAuthStore'
import api from '@/api'

import Header from '@/components/new/Header'
import ShareDialog from '@/components/ShareDialog'
import SupportChat from '@/components/SupportChat'

import { AnimatePresence } from 'framer-motion'
import { Loader2 } from 'lucide-react'

export default function AppLayout() {
  const { user } = useAuthStore()
  const {
    processingStep,
    addTranscriptSegment,
    setProcessing,
    setSegments,
    setTranscript,
    setAudioPaths,
    loadHistory,
  } = useStore()

  const [setupChecked, setSetupChecked] = useState(false)
  const [sharingProjectId, setSharingProjectId] = useState<string | null>(null)
  const [sharingProjectName, setSharingProjectName] = useState('')

  // Charge l'historique au montage. Le SetupWizard a ete supprime — les
  // utilisateurs n'ont pas a voir les details techniques (Ollama, ffmpeg, etc.)
  useEffect(() => {
    setSetupChecked(true)
    loadHistory()
  }, [loadHistory])

  // Raccourcis clavier : Ctrl+Z (annuler) / Ctrl+Shift+Z (retablir)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          useStore.getState().redo()
        } else {
          useStore.getState().undo()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // WebSocket event listeners (project-scoped)
  useEffect(() => {
    if (!(window as any).electron) return

    const unsubProgress = (window as any).electron.onProgress((data: any) => {
      if (!useStore.getState().activeProjectId) return
      const step = data.step || processingStep
      setProcessing(step, data.progress, data.message)
    })

    const unsubSegment = (window as any).electron.onTranscriptSegment((segment: any) => {
      if (!useStore.getState().activeProjectId) return
      addTranscriptSegment(segment as any)
    })

    const unsubComplete = (window as any).electron.onAnalysisComplete((data: any) => {
      if (!useStore.getState().activeProjectId) return
      if (data.segments) setSegments(data.segments)
      if (data.transcript) setTranscript(data.transcript)
      if (data.audioPaths) setAudioPaths(data.audioPaths)
      setProcessing('done', 100, 'Analyse terminee !')
      loadHistory()
    })

    const unsubError = (window as any).electron.onAnalysisError((data: any) => {
      if (!useStore.getState().activeProjectId) return
      setProcessing('error', 0, data.message || "Erreur d'analyse")
      loadHistory()
    })

    return () => {
      unsubProgress()
      unsubSegment()
      unsubComplete()
      unsubError()
    }
  }, [processingStep, setProcessing, addTranscriptSegment, setSegments, setTranscript, setAudioPaths, loadHistory])

  // Listen for share events from child routes (e.g. HomePage project cards)
  useEffect(() => {
    const handleShare = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.projectId) {
        setSharingProjectId(detail.projectId)
        setSharingProjectName(detail.projectName || '')
      }
    }
    window.addEventListener('clipr:share', handleShare)
    return () => window.removeEventListener('clipr:share', handleShare)
  }, [])

  if (!setupChecked) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background font-sans selection:bg-primary/20">
      <Header
        onShare={(projectId: string, projectName: string) => {
          setSharingProjectId(projectId)
          setSharingProjectName(projectName)
        }}
      />

      <Outlet />

      <AnimatePresence>
        {sharingProjectId && (
          <ShareDialog
            projectId={sharingProjectId}
            projectName={sharingProjectName}
            onClose={() => setSharingProjectId(null)}
          />
        )}
      </AnimatePresence>

      {/* Bouton flottant + panneau de support (visible uniquement si connecte) */}
      <SupportChat />
    </div>
  )
}

/**
 * TRANSCRIPTIONPAGE.TSX : Page de l'outil de transcription audio/video
 *
 * Wrapper autour du composant TranscriptionTool.
 * Si un projectId est present dans l'URL, charge le projet depuis l'API
 * avant d'afficher l'outil. Sinon, affiche l'outil vide (nouveau projet).
 *
 * Routes : /transcription et /transcription/:projectId
 */

import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import api from '@/api'
import TranscriptionTool from '@/components/new/TranscriptionTool'

export default function TranscriptionPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [initialProject, setInitialProject] = useState<any>(undefined)
  const [loading, setLoading] = useState(!!projectId)

  useEffect(() => {
    if (!projectId) {
      setInitialProject(undefined)
      setLoading(false)
      return
    }

    setLoading(true)
    api.loadProjectById(projectId)
      .then((project: any) => {
        if (project) {
          setInitialProject(project)
        } else {
          navigate('/', { replace: true })
        }
      })
      .catch(() => navigate('/', { replace: true }))
      .finally(() => setLoading(false))
  }, [projectId, navigate])

  if (loading) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-10 h-10 text-primary animate-spin" />
        </div>
      </main>
    )
  }

  return (
    <TranscriptionTool
      onBack={() => navigate('/')}
      initialProject={initialProject}
    />
  )
}

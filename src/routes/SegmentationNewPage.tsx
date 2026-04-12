/**
 * SEGMENTATIONNEWPAGE.TSX : Page de creation d'un nouveau projet de segmentation
 *
 * Affiche la zone d'upload video (drag & drop).
 * Une fois les fichiers uploades et le projet cree, redirige
 * automatiquement vers /project/:projectId.
 *
 * Route : /segmentation/new
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store/useStore'
import UploadZone from '@/components/new/UploadZone'
import { Scissors } from 'lucide-react'

export default function SegmentationNewPage() {
  const navigate = useNavigate()
  const { videoFiles, activeProjectId } = useStore()

  // Once files are uploaded and project created, redirect to project page
  useEffect(() => {
    if (videoFiles.length > 0 && activeProjectId) {
      navigate('/project/' + activeProjectId, { replace: true })
    }
  }, [videoFiles.length, activeProjectId, navigate])

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      <div className="max-w-4xl mx-auto w-full pt-8">
        <div className="flex items-center gap-4 mb-8">
          <button onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-secondary transition-colors">
            <Scissors className="w-5 h-5 text-muted-foreground" />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Scissors className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">Segmentation d'interview video</h1>
              <p className="text-xs text-muted-foreground">Deposez une ou plusieurs videos pour lancer l'analyse IA</p>
            </div>
          </div>
        </div>
        <UploadZone />
      </div>
    </main>
  )
}

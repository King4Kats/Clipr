/**
 * WORDCLOUDEXPORTBUTTON.TSX : Bouton d'export du nuage de mots en image PNG
 *
 * Petit bouton discret pose dans le coin du nuage. Au clic, il propose deux
 * types de fichier :
 *   - fond blanc : pret a coller dans un document ou une presentation
 *   - fond transparent : pour un montage ou une affiche, ou l'arriere-plan
 *     du nuage doit se fondre dans le decor
 *
 * Le composant est partage par les deux endroits ou apparait un nuage de mots
 * (le panneau de l'outil Transcription et la fenetre d'analyse semantique de
 * l'outil Segmentation), pour que le comportement reste identique des deux cotes.
 */

import { useState, useEffect, useRef } from 'react'
import { ImageDown, Loader2 } from 'lucide-react'
import { exportWordCloudPNG } from '@/lib/export-image'

interface WordCloudExportButtonProps {
  /** Reference vers le SVG du nuage a exporter */
  svgRef: React.MutableRefObject<SVGElement | null>
  /** Nom de base du fichier (souvent le nom du media transcrit) */
  filename?: string
  /** Classe CSS de positionnement (le parent decide de l'emplacement) */
  className?: string
}

export default function WordCloudExportButton({
  svgRef,
  filename = 'nuage-de-mots',
  className = '',
}: WordCloudExportButtonProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Le message d'erreur disparait tout seul au bout de quelques secondes
  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 4000)
    return () => clearTimeout(t)
  }, [error])

  // Fermer le menu au clic ailleurs dans la page
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleExport = async (background: 'white' | 'transparent') => {
    setOpen(false)
    setError(null)

    const svg = svgRef.current
    if (!svg) {
      setError('Nuage introuvable')
      return
    }
    // Un nuage encore en cours de calcul n'a aucun mot a exporter
    if (svg.querySelectorAll('text').length === 0) {
      setError('Le nuage est vide')
      return
    }

    setBusy(true)
    try {
      await exportWordCloudPNG(svg, { filename, background })
    } catch (err: any) {
      console.error('Export du nuage en PNG echoue:', err)
      setError(err?.message || "L'export a echoue")
    }
    setBusy(false)
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        title="Exporter le nuage en image PNG"
        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageDown className="w-3.5 h-3.5" />}
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-40 w-52 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          <div className="px-3 py-2 text-[10px] text-muted-foreground border-b border-border">
            Exporter en image
          </div>
          <button
            onClick={() => handleExport('white')}
            className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-secondary transition-colors"
          >
            PNG — fond blanc
            <span className="block text-[10px] text-muted-foreground">Pour un document ou un diaporama</span>
          </button>
          <button
            onClick={() => handleExport('transparent')}
            className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-secondary transition-colors"
          >
            PNG — fond transparent
            <span className="block text-[10px] text-muted-foreground">Pour un montage ou une affiche</span>
          </button>
        </div>
      )}

      {error && (
        <div className="absolute right-0 top-7 z-40 whitespace-nowrap bg-card border border-red-500/40 text-red-400 text-[10px] rounded-lg px-2 py-1 shadow-xl">
          {error}
        </div>
      )}
    </div>
  )
}

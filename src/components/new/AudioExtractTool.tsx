/**
 * AUDIOEXTRACTTOOL.TSX : Outil "Extraction audio" (video → MP3)
 *
 * Cet outil fait une seule chose, mais bien : prendre un ou plusieurs fichiers
 * video et en sortir la piste sonore au format MP3, prete a telecharger.
 * C'est l'equivalent local et sans pub d'un FormatFactory pour la conversion
 * audio : les fichiers ne quittent jamais la machine.
 *
 * Deroulement pour chaque fichier :
 *   1. Upload vers le serveur (en un bloc, ou par morceaux si > 90 Mo)
 *   2. Le serveur lance FFmpeg et renvoie tout de suite un identifiant de tache
 *   3. On interroge l'avancement toutes les secondes (le tunnel Cloudflare
 *      coupe les requetes de plus de 100 s, on ne peut donc pas simplement
 *      attendre la fin de la conversion sur une seule requete)
 *   4. Une fois pret, le bouton de telechargement apparait
 *
 * Les fichiers sont traites les uns apres les autres pour ne pas saturer le CPU
 * de la machine, qui sert aussi a la transcription Whisper.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  Upload, Music, Loader2, Download, X, AlertCircle,
  CheckCircle2, ArrowLeft, FileVideo
} from 'lucide-react'
import api from '@/api'
import { Button } from '@/components/ui/button'

// Formats acceptes : videos courantes + fichiers audio (re-encodage / conversion)
const ACCEPTED_EXTENSIONS = [
  'mp4', 'avi', 'mov', 'mkv', 'mts', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv',
  'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp3',
]

// Debits proposes. 192 kbps est le reglage par defaut : la difference avec du
// 320 est inaudible sur de la parole, pour un fichier presque deux fois plus leger.
const BITRATES = [
  { value: 128, label: '128 kbps', hint: 'Leger — parole, archivage' },
  { value: 192, label: '192 kbps', hint: 'Equilibre — recommande' },
  { value: 320, label: '320 kbps', hint: 'Haute qualite — musique' },
]

/** Etat d'un fichier dans la liste de conversion. */
interface AudioItem {
  /** Cle locale unique (le nom de fichier peut etre en double) */
  key: string
  file: File
  status: 'attente' | 'upload' | 'conversion' | 'termine' | 'erreur'
  /** Progression 0-100 de l'etape en cours */
  progress: number
  jobId?: string
  filename?: string
  size?: number
  error?: string
}

/** Affiche une taille en octets sous forme lisible (Ko / Mo). */
function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
}

interface AudioExtractToolProps {
  onBack: () => void
}

const AudioExtractTool = ({ onBack }: AudioExtractToolProps) => {
  const [items, setItems] = useState<AudioItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [bitrate, setBitrate] = useState(192)
  const [channels, setChannels] = useState<1 | 2>(2)
  // Vrai tant qu'une conversion est en cours (on bloque les reglages et l'ajout)
  const [running, setRunning] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  // Permet d'arreter proprement le polling si le composant est demonte
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])

  /** Met a jour un seul item de la liste sans toucher aux autres. */
  const updateItem = useCallback((key: string, patch: Partial<AudioItem>) => {
    setItems(prev => prev.map(it => (it.key === key ? { ...it, ...patch } : it)))
  }, [])

  /** Ajoute les fichiers deposes/selectionnes a la file, en filtrant les formats. */
  const addFiles = useCallback((files: File[]) => {
    setGlobalError(null)
    const valid = files.filter(f => {
      const ext = f.name.split('.').pop()?.toLowerCase()
      return ext && ACCEPTED_EXTENSIONS.includes(ext)
    })

    if (valid.length === 0) {
      setGlobalError('Aucun fichier reconnu. Formats acceptes : ' + ACCEPTED_EXTENSIONS.join(', '))
      return
    }
    if (valid.length < files.length) {
      setGlobalError(`${files.length - valid.length} fichier(s) ignore(s) : format non pris en charge`)
    }

    setItems(prev => [
      ...prev,
      ...valid.map((file, i) => ({
        key: `${Date.now()}_${i}_${file.name}`,
        file,
        status: 'attente' as const,
        progress: 0,
      })),
    ])
  }, [])

  /**
   * Interroge le serveur jusqu'a ce que la conversion soit finie.
   * On attend une seconde entre deux appels : assez reactif pour l'utilisateur,
   * assez econome pour ne pas marteler le serveur.
   */
  const pollJob = useCallback(async (key: string, jobId: string) => {
    while (!cancelledRef.current) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const job = await api.getAudioJob(jobId)
        if (job.status === 'done') {
          updateItem(key, { status: 'termine', progress: 100, filename: job.filename, size: job.size })
          return
        }
        if (job.status === 'error') {
          updateItem(key, { status: 'erreur', error: job.error || 'La conversion a echoue' })
          return
        }
        updateItem(key, { status: 'conversion', progress: job.progress || 0 })
      } catch (err: any) {
        // Un blip reseau ne doit pas tuer la conversion : on reessaie au tour
        // suivant. Seule une erreur renvoyee par le serveur arrete la boucle.
        console.warn('[Audio] Lecture de l\'avancement echouee, nouvelle tentative :', err?.message)
      }
    }
  }, [updateItem])

  /** Traite toute la file, fichier par fichier. */
  const handleConvert = useCallback(async () => {
    const pending = items.filter(it => it.status === 'attente' || it.status === 'erreur')
    if (pending.length === 0) return

    setRunning(true)
    setGlobalError(null)

    for (const item of pending) {
      if (cancelledRef.current) break
      try {
        // 1. Upload (uploadFiles choisit tout seul entre envoi direct et chunks)
        updateItem(item.key, { status: 'upload', progress: 0, error: undefined })
        const uploaded = await api.uploadFiles([item.file], (pct) => {
          updateItem(item.key, { progress: Math.round(pct * 100) })
        })
        const fileId = uploaded[0]?.id
        if (!fileId) throw new Error("Le serveur n'a pas accepte le fichier")

        // 2. Lancement de la conversion cote serveur
        updateItem(item.key, { status: 'conversion', progress: 0 })
        const { jobId } = await api.extractMp3(fileId, item.file.name, bitrate, channels)
        updateItem(item.key, { jobId })

        // 3. Suivi jusqu'a la fin
        await pollJob(item.key, jobId)
      } catch (err: any) {
        updateItem(item.key, { status: 'erreur', error: err?.message || 'Erreur inconnue' })
      }
    }

    setRunning(false)
  }, [items, bitrate, channels, updateItem, pollJob])

  /** Telecharge un MP3 termine. */
  const handleDownload = (item: AudioItem) => {
    if (!item.filename) return
    // Nom propose a l'utilisateur : celui de sa video, avec l'extension .mp3
    const niceName = item.file.name.replace(/\.[^.]+$/, '') + '.mp3'
    api.downloadExport(api.getExportDownloadUrl(item.filename, niceName), niceName)
  }

  const handleDownloadAll = () => {
    items.filter(it => it.status === 'termine').forEach((it, i) => {
      // On espace les telechargements : certains navigateurs bloquent les
      // ouvertures simultanees de plusieurs fichiers
      setTimeout(() => handleDownload(it), i * 400)
    })
  }

  const removeItem = (key: string) => setItems(prev => prev.filter(it => it.key !== key))

  const doneCount = items.filter(it => it.status === 'termine').length
  const pendingCount = items.filter(it => it.status === 'attente' || it.status === 'erreur').length

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      {/* En-tete */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />
          Retour
        </Button>
      </div>

      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
          <Music className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Extraction audio</h1>
          <p className="text-xs text-muted-foreground">
            Recuperer la bande son d'une video sous forme de fichier MP3
          </p>
        </div>
      </div>

      {/* Zone de depot */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragging(false)
          if (running) return
          addFiles(Array.from(e.dataTransfer.files))
        }}
        onClick={() => { if (!running) fileInputRef.current?.click() }}
        className={`mt-6 border-2 border-dashed rounded-xl p-10 text-center transition-colors ${
          running ? 'opacity-60 cursor-not-allowed border-border' : 'cursor-pointer'
        } ${isDragging ? 'border-amber-500 bg-amber-500/5' : 'border-border hover:border-amber-500/50'}`}
      >
        <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm font-medium text-foreground">
          Glissez vos videos ici, ou cliquez pour les choisir
        </p>
        <p className="text-[11px] text-muted-foreground mt-1">
          MP4, MOV, AVI, MKV, MTS, WebM... et fichiers audio a reconvertir
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.map(e => '.' + e).join(',')}
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files || []))
            // On vide l'input pour pouvoir reselectionner le meme fichier
            e.target.value = ''
          }}
        />
      </motion.div>

      {globalError && (
        <div className="mt-3 flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <span>{globalError}</span>
        </div>
      )}

      {/* Reglages de qualite */}
      <div className="mt-6 bg-card border border-border rounded-xl p-4">
        <h2 className="text-xs font-semibold text-foreground mb-3">Qualite du MP3</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {BITRATES.map(b => (
            <button
              key={b.value}
              disabled={running}
              onClick={() => setBitrate(b.value)}
              className={`text-left p-3 rounded-lg border-2 transition-colors disabled:opacity-60 ${
                bitrate === b.value
                  ? 'border-amber-500 bg-amber-500/10'
                  : 'border-border hover:border-amber-500/40'
              }`}
            >
              <div className="text-sm font-bold text-foreground">{b.label}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{b.hint}</div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 mt-4">
          <span className="text-xs text-muted-foreground mr-1">Canaux :</span>
          {([2, 1] as const).map(c => (
            <button
              key={c}
              disabled={running}
              onClick={() => setChannels(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border-2 transition-colors disabled:opacity-60 ${
                channels === c
                  ? 'border-amber-500 bg-amber-500/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-amber-500/40'
              }`}
            >
              {c === 2 ? 'Stereo' : 'Mono (fichier plus leger)'}
            </button>
          ))}
        </div>
      </div>

      {/* Liste des fichiers */}
      {items.length > 0 && (
        <div className="mt-6 space-y-2">
          {items.map(item => (
            <div key={item.key} className="bg-card border border-border rounded-lg p-3">
              <div className="flex items-center gap-3">
                <FileVideo className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-foreground truncate">{item.file.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {item.status === 'attente' && 'En attente'}
                    {item.status === 'upload' && `Envoi au serveur — ${item.progress}%`}
                    {item.status === 'conversion' && `Conversion en MP3 — ${item.progress}%`}
                    {item.status === 'termine' && `Termine — ${formatSize(item.size)}`}
                    {item.status === 'erreur' && <span className="text-red-400">{item.error}</span>}
                  </div>
                </div>

                {(item.status === 'upload' || item.status === 'conversion') && (
                  <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
                )}
                {item.status === 'termine' && (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <Button size="sm" variant="ghost" className="gap-1.5 text-xs" onClick={() => handleDownload(item)}>
                      <Download className="w-3.5 h-3.5" />
                      MP3
                    </Button>
                  </>
                )}
                {!running && (
                  <button
                    onClick={() => removeItem(item.key)}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    title="Retirer de la liste"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Barre de progression */}
              {(item.status === 'upload' || item.status === 'conversion') && (
                <div className="mt-2 h-1 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-500 transition-all duration-300"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {items.length > 0 && (
        <div className="mt-5 flex items-center gap-3">
          <Button onClick={handleConvert} disabled={running || pendingCount === 0} className="gap-2">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Music className="w-4 h-4" />}
            {running ? 'Conversion en cours...' : `Extraire l'audio (${pendingCount})`}
          </Button>

          {doneCount > 1 && (
            <Button variant="ghost" onClick={handleDownloadAll} className="gap-2 text-xs">
              <Download className="w-4 h-4" />
              Tout telecharger ({doneCount})
            </Button>
          )}
        </div>
      )}

      <p className="mt-8 text-[10px] text-muted-foreground">
        Les MP3 produits restent disponibles au telechargement pendant 6 heures,
        puis sont supprimes automatiquement du serveur.
      </p>
    </main>
  )
}

export default AudioExtractTool

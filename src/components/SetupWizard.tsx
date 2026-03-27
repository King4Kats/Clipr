/**
 * SETUPWIZARD.TSX : Assistant de configuration initiale
 *
 * Panneau modal affiché au premier lancement de l'application.
 * Permet de vérifier et installer les dépendances (FFmpeg, modèles Whisper/LLM),
 * gérer les modèles Ollama, vérifier les mises à jour, exporter les logs
 * de diagnostic et accéder à la documentation.
 */

import { useState, useEffect } from 'react'
import type { UpdateStatus } from '../types'
import logo from '@/assets/Clipr.svg'

interface DependencyStatus {
  name: string
  installed: boolean
  version?: string
  installInstructions?: string
}

interface ModelProgress {
  type: 'whisper' | 'llm'
  progress: number
  message: string
}

interface SetupWizardProps {
  onComplete: () => void
}

// --- Composant utilitaire : Spinner de chargement inline ---
const Spinner = ({ className = 'w-5 h-5' }: { className?: string }) => (
  <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
)

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  // --- Etat : dépendances et téléchargement des modèles ---
  const [dependencies, setDependencies] = useState<DependencyStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<'whisper' | 'llm' | 'both' | null>(null)
  const [whisperProgress, setWhisperProgress] = useState({ progress: 0, message: '' })
  const [llmProgress, setLlmProgress] = useState({ progress: 0, message: '' })

  // --- Etat : mise à jour de l'application ---
  const [appVersion, setAppVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  // --- Etat : modèles Ollama ---
  const [ollamaRunning, setOllamaRunning] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [pullingModel, setPullingModel] = useState(false)
  const [pullModelName, setPullModelName] = useState('')
  const [pullResult, setPullResult] = useState<{ success: boolean; message: string } | null>(null)

  // --- Etat : diagnostic et export des logs ---
  const [installationId, setInstallationId] = useState('')
  const [isSendingLogs, setIsSendingLogs] = useState(false)
  const [logSendProgress, setLogSendProgress] = useState<{ percent: number; message: string } | null>(null)
  const [logSendResult, setLogSendResult] = useState<{ success: boolean; message: string } | null>(null)

  // Vérifie les dépendances installées (FFmpeg, Whisper, LLM) via l'API Electron
  const checkDependencies = async () => {
    setLoading(true)
    try {
      const deps = await window.electron.checkDependencies()
      setDependencies(deps)
    } catch (error) {
      // silently fail
    }
    setLoading(false)
  }

  // Rafraîchit la liste des modèles Ollama disponibles
  const refreshOllamaModels = async () => {
    try {
      const running = await window.electron.checkOllama()
      setOllamaRunning(running)
      if (running) {
        const models = await window.electron.listOllamaModels()
        setOllamaModels(models)
      } else {
        setOllamaModels([])
      }
    } catch {
      setOllamaRunning(false)
      setOllamaModels([])
    }
  }

  // Télécharge (pull) un modèle Ollama par son nom
  const handlePullModel = async () => {
    const name = pullModelName.trim()
    if (!name || pullingModel) return
    setPullingModel(true)
    setPullResult(null)
    try {
      const result = await window.electron.pullOllamaModel(name)
      setPullResult(result)
      if (result.success) {
        setPullModelName('')
        await refreshOllamaModels()
      }
    } catch (error: any) {
      setPullResult({ success: false, message: error.message || 'Erreur' })
    }
    setPullingModel(false)
  }

  // --- Effet d'initialisation : vérifie tout au montage et écoute les événements IPC ---
  useEffect(() => {
    checkDependencies()
    refreshOllamaModels()

    // Charger la version et l'ID d'installation
    window.electron.getAppVersion().then(setAppVersion)
    window.electron.getInstallationId().then(setInstallationId)

    // Listen for model download progress
    const unsubModelProgress = window.electron.onModelProgress((data: ModelProgress) => {
      if (data.type === 'whisper') {
        setWhisperProgress({ progress: data.progress, message: data.message })
      } else if (data.type === 'llm') {
        setLlmProgress({ progress: data.progress, message: data.message })
      }
    })

    // Listen for update status
    const unsubUpdate = window.electron.onUpdateStatus((status: UpdateStatus) => {
      setUpdateStatus(status)
    })

    // Listen for log send progress
    const unsubLogProgress = window.electron.onLogSendProgress((data) => {
      setLogSendProgress(data)
    })

    return () => {
      unsubModelProgress()
      unsubUpdate()
      unsubLogProgress()
    }
  }, [])

  // Vérifie si toutes les dépendances sont installées
  const allReady = dependencies.length > 0 && dependencies.every(d => d.installed)

  // --- Etat : erreur de téléchargement ---
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // Télécharge tous les modèles manquants (Whisper et/ou LLM) en parallèle
  const handleDownloadAll = async () => {
    const whisperDep = dependencies.find(d => d.name === 'Modèle Whisper')
    const llmDep = dependencies.find(d => d.name === 'Modèle IA')

    const needsWhisper = whisperDep && !whisperDep.installed
    const needsLlm = llmDep && !llmDep.installed

    if (!needsWhisper && !needsLlm) {
      onComplete()
      return
    }

    setDownloading('both')
    setDownloadError(null)

    try {
      const promises: Promise<any>[] = []

      if (needsWhisper) {
        promises.push(window.electron.installWhisper())
      }
      if (needsLlm) {
        promises.push(window.electron.installLLM())
      }

      const results = await Promise.all(promises)
      const failed = results.filter((r: any) => r && !r.success)
      if (failed.length > 0) {
        setDownloadError(failed.map((f: any) => f.message).join(' | '))
      }
      await checkDependencies()
    } catch (error: any) {
      setDownloadError(error.message || 'Erreur lors du telechargement')
    }

    setDownloading(null)
  }

  // Lance la vérification des mises à jour via l'auto-updater Electron
  const handleCheckUpdates = async () => {
    setUpdateStatus({ status: 'checking' })
    await window.electron.checkForUpdates()
  }

  // Applique la mise à jour téléchargée (redémarrage de l'application)
  const handleInstallUpdate = () => {
    window.electron.installUpdate()
  }

  // Exporte les logs de diagnostic vers un fichier
  const handleSendLogs = async () => {
    setIsSendingLogs(true)
    setLogSendResult(null)
    setLogSendProgress({ percent: 0, message: "Preparation de l'export..." })
    try {
      const result = await window.electron.sendLogs()
      setLogSendResult(result)
    } catch (error: any) {
      setLogSendResult({ success: false, message: `Erreur: ${error.message}` })
    }
    setIsSendingLogs(false)
    setLogSendProgress(null)
  }

  // Copie l'identifiant d'installation dans le presse-papiers
  const handleCopyId = () => {
    navigator.clipboard.writeText(installationId)
  }

  // --- Ecran de chargement affiché pendant la vérification initiale ---
  if (loading) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
        <div className="text-center">
          <Spinner className="w-12 h-12 mx-auto mb-4 text-primary" />
          <p className="text-muted-foreground">Verification de la configuration...</p>
        </div>
      </div>
    )
  }

  // Calcule la taille totale de téléchargement restante (en MB)
  const whisperSize = 142
  const llmSize = 2100
  const totalSize = (dependencies.find(d => d.name === 'Modèle Whisper')?.installed ? 0 : whisperSize) +
                   (dependencies.find(d => d.name === 'Modèle IA')?.installed ? 0 : llmSize)

  // Modèles Ollama suggérés pour un démarrage rapide
  const MODEL_SUGGESTIONS = ['qwen2.5:3b', 'llama3.2:3b', 'mistral:7b', 'phi3:mini']

  return (
    <div className="fixed inset-0 bg-background/98 backdrop-blur-sm flex items-center justify-center z-50 p-8">
      <div className="max-w-xl w-full bg-card rounded-xl shadow-2xl border border-border p-8 max-h-[90vh] overflow-y-auto custom-scrollbar">

        {/* --- Section : En-tête avec logo et titre --- */}
        <div className="text-center mb-8">
          <img src={logo} alt="Clipr" className="w-16 h-16 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-foreground mb-1">Clipr</h1>
          <p className="text-muted-foreground text-sm">
            {allReady ? 'Tout est pret !' : 'Configuration initiale requise'}
          </p>
        </div>

        {/* --- Section : Liste des dépendances (FFmpeg, Whisper, LLM) --- */}
        <div className="space-y-2.5 mb-6">
          {dependencies.map((dep) => {
            const isDownloading = (dep.name === 'Modèle Whisper' && (downloading === 'whisper' || downloading === 'both')) ||
                                  (dep.name === 'Modèle IA' && (downloading === 'llm' || downloading === 'both'))
            const progress = dep.name === 'Modèle Whisper' ? whisperProgress : llmProgress

            return (
              <div
                key={dep.name}
                className={`p-3.5 rounded-xl border transition-colors ${
                  dep.installed
                    ? 'bg-green-500/5 border-green-500/20'
                    : isDownloading
                    ? 'bg-primary/5 border-primary/20'
                    : 'bg-secondary/10 border-border'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {dep.installed ? (
                      <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                        <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    ) : isDownloading ? (
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                        <Spinner className="w-4 h-4 text-primary" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-lg bg-secondary/20 flex items-center justify-center">
                        <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </div>
                    )}
                    <div>
                      <p className="text-sm font-medium text-foreground">{dep.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {dep.installed
                          ? dep.version || 'Installe'
                          : isDownloading
                          ? progress.message || 'Telechargement...'
                          : dep.name === 'Modèle Whisper'
                          ? `${whisperSize} MB`
                          : dep.name === 'Modèle IA'
                          ? `${llmSize} MB`
                          : 'Non installe'}
                      </p>
                    </div>
                  </div>

                  {!dep.installed && !isDownloading && dep.name !== 'FFmpeg' && (
                    <span className="text-xs text-muted-foreground/60 italic">A telecharger</span>
                  )}
                </div>

                {/* Progress bar */}
                {isDownloading && progress.progress > 0 && (
                  <div className="mt-3">
                    <div className="h-1.5 bg-secondary/20 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-300"
                        style={{ width: `${progress.progress}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 text-right">{progress.progress}%</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Info download */}
        {!allReady && totalSize > 0 && !downloading && (
          <div className="mb-6 p-4 bg-primary/5 rounded-xl border border-primary/10">
            <p className="text-primary text-sm">
              Les modeles d'IA seront telecharges automatiquement ({(totalSize / 1024).toFixed(1)} GB).
              Cela peut prendre quelques minutes selon votre connexion.
            </p>
          </div>
        )}

        {/* --- Section : Gestion des modèles Ollama (statut, liste, téléchargement) --- */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Modeles Ollama</h2>
          <div className="p-4 rounded-xl border border-border bg-secondary/5 space-y-4">

            {/* Statut */}
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${ollamaRunning ? 'bg-green-500' : 'bg-destructive'}`} />
              <span className="text-sm text-foreground">
                {ollamaRunning ? 'Ollama actif' : 'Ollama non demarre'}
              </span>
              <button
                className="ml-auto text-xs text-primary hover:text-primary/80 transition-colors"
                onClick={refreshOllamaModels}
              >
                Rafraichir
              </button>
            </div>

            {/* Liste modeles installes */}
            {ollamaRunning && ollamaModels.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Modeles installes :</p>
                <div className="flex flex-wrap gap-1.5">
                  {ollamaModels.map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-mono font-medium bg-primary/10 text-primary border border-primary/20"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {ollamaRunning && ollamaModels.length === 0 && (
              <p className="text-xs text-yellow-500">Aucun modele installe. Telechargez-en un ci-dessous.</p>
            )}

            {/* Telecharger un modele */}
            {ollamaRunning && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Telecharger un modele :</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={pullModelName}
                    onChange={(e) => setPullModelName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handlePullModel()}
                    placeholder="ex: qwen2.5:3b, mistral:7b..."
                    className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
                    disabled={pullingModel}
                  />
                  <button
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                      pullingModel
                        ? 'bg-primary/30 text-primary/60 cursor-not-allowed'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'
                    }`}
                    onClick={handlePullModel}
                    disabled={pullingModel || !pullModelName.trim()}
                  >
                    {pullingModel ? (
                      <span className="flex items-center gap-2">
                        <Spinner className="w-4 h-4" />
                        Pull...
                      </span>
                    ) : (
                      'Pull'
                    )}
                  </button>
                </div>

                {/* Suggestions rapides */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {MODEL_SUGGESTIONS.map((suggestion) => {
                    const installed = ollamaModels.includes(suggestion)
                    return (
                      <button
                        key={suggestion}
                        className={`text-xs font-mono px-2 py-0.5 rounded-md transition-all ${
                          installed
                            ? 'bg-green-500/10 text-green-500 border border-green-500/20 cursor-default'
                            : 'bg-secondary/10 text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/20 border border-border'
                        }`}
                        onClick={() => { if (!installed) setPullModelName(suggestion) }}
                        disabled={installed}
                      >
                        {installed && '✓ '}{suggestion}
                      </button>
                    )
                  })}
                </div>

                {/* Resultat */}
                {pullResult && (
                  <p className={`mt-2 text-xs ${pullResult.success ? 'text-green-500' : 'text-destructive'}`}>
                    {pullResult.message}
                  </p>
                )}
              </div>
            )}

            {/* Ollama non disponible */}
            {!ollamaRunning && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Ollama doit etre installe et demarre pour utiliser les modeles d'IA.</p>
                <p>
                  Telechargez-le sur{' '}
                  <a
                    href="#"
                    className="text-primary hover:text-primary/80 underline underline-offset-2"
                    onClick={(e) => { e.preventDefault(); window.electron.openFolder('https://ollama.com/download') }}
                  >
                    ollama.com
                  </a>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* --- Section : Vérification et installation des mises à jour --- */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Mise a jour</h2>
          <div className={`p-4 rounded-xl border transition-colors ${
            updateStatus?.status === 'downloaded'
              ? 'bg-green-500/5 border-green-500/20'
              : updateStatus?.status === 'error'
              ? 'bg-destructive/5 border-destructive/20'
              : updateStatus?.status === 'downloading' || updateStatus?.status === 'available'
              ? 'bg-primary/5 border-primary/20'
              : 'bg-secondary/5 border-border'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {updateStatus?.status === 'downloaded' ? (
                  <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                    <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </div>
                ) : updateStatus?.status === 'not-available' ? (
                  <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                    <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : updateStatus?.status === 'checking' || updateStatus?.status === 'downloading' ? (
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Spinner className="w-4 h-4 text-primary" />
                  </div>
                ) : updateStatus?.status === 'error' ? (
                  <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center">
                    <svg className="w-4 h-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                  </div>
                ) : (
                  <div className="w-8 h-8 rounded-lg bg-secondary/20 flex items-center justify-center">
                    <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {updateStatus?.status === 'checking' && 'Verification...'}
                    {updateStatus?.status === 'available' && `Version ${updateStatus.version} disponible`}
                    {updateStatus?.status === 'downloading' && `Telechargement : ${updateStatus.percent}%`}
                    {updateStatus?.status === 'downloaded' && 'Mise a jour prete !'}
                    {updateStatus?.status === 'not-available' && 'Vous etes a jour'}
                    {updateStatus?.status === 'error' && 'Erreur de verification'}
                    {!updateStatus && `Version ${appVersion}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {updateStatus?.status === 'downloaded' && 'Veuillez redemarrer pour appliquer la mise a jour.'}
                    {updateStatus?.status === 'error' && updateStatus.message}
                    {updateStatus?.status === 'not-available' && `Version actuelle : ${appVersion}`}
                    {!updateStatus && 'Cliquez pour verifier les mises a jour.'}
                  </p>
                </div>
              </div>

              {updateStatus?.status === 'downloaded' ? (
                <button
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors whitespace-nowrap"
                  onClick={handleInstallUpdate}
                >
                  Redemarrer
                </button>
              ) : (
                <button
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary/20 text-foreground hover:bg-secondary/30 border border-border transition-colors whitespace-nowrap disabled:opacity-50"
                  onClick={handleCheckUpdates}
                  disabled={updateStatus?.status === 'checking' || updateStatus?.status === 'downloading'}
                >
                  Verifier
                </button>
              )}
            </div>

            {/* Progress bar MAJ */}
            {updateStatus?.status === 'downloading' && (
              <div className="mt-3">
                <div className="h-1.5 bg-secondary/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${updateStatus.percent}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1 text-right">{updateStatus.percent}%</p>
              </div>
            )}
          </div>
        </div>

        {/* --- Section : Diagnostic (ID d'installation et export des logs) --- */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Diagnostic</h2>
          <div className="p-4 rounded-xl border border-border bg-secondary/5">
            {/* ID d'installation */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs text-muted-foreground">ID d'installation</p>
                <p className="font-mono text-xs text-foreground/80">
                  {installationId ? installationId.substring(0, 8) + '...' : 'Chargement...'}
                </p>
              </div>
              <button
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={handleCopyId}
                title="Copier l'ID complet"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>

            {/* Bouton export logs */}
            <button
              className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                isSendingLogs
                  ? 'bg-primary/30 text-primary/60 cursor-not-allowed'
                  : 'bg-secondary/20 text-foreground hover:bg-secondary/30 border border-border'
              }`}
              onClick={handleSendLogs}
              disabled={isSendingLogs}
            >
              {isSendingLogs ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner className="w-4 h-4" />
                  {logSendProgress?.message || 'Export...'}
                </span>
              ) : (
                'Exporter les logs'
              )}
            </button>

            {/* Progress bar logs */}
            {isSendingLogs && logSendProgress && logSendProgress.percent > 0 && (
              <div className="mt-3">
                <div className="h-1.5 bg-secondary/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${logSendProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Resultat */}
            {logSendResult && !isSendingLogs && (
              <p className={`mt-3 text-xs ${logSendResult.success ? 'text-green-500' : 'text-destructive'}`}>
                {logSendResult.message}
              </p>
            )}
          </div>
        </div>

        {/* --- Section : Lien vers la documentation --- */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Documentation</h2>
          <button
            className="w-full py-2.5 px-4 rounded-xl text-sm font-medium transition-colors bg-secondary/10 hover:bg-secondary/20 text-foreground border border-border flex items-center justify-center gap-2"
            onClick={() => (window.electron as any).openDocumentation()}
          >
            <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            Ouvrir la documentation
          </button>
        </div>

        {/* Erreur de telechargement */}
        {downloadError && (
          <div className="mb-4 p-3 bg-destructive/5 border border-destructive/20 rounded-xl">
            <p className="text-destructive text-sm">{downloadError}</p>
          </div>
        )}

        {/* --- Section : Boutons d'action (installer les modèles / commencer / fermer) --- */}
        <div className="flex gap-3">
          {!allReady && (
            <button
              className="flex-1 py-3 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              onClick={handleDownloadAll}
              disabled={downloading !== null}
            >
              {downloading ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner className="w-4 h-4" />
                  Telechargement...
                </span>
              ) : (
                'Installer les modeles'
              )}
            </button>
          )}
          <button
            className={`flex-1 py-3 rounded-xl text-sm font-medium transition-colors disabled:opacity-50 ${
              allReady
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-secondary/20 text-foreground hover:bg-secondary/30 border border-border'
            }`}
            onClick={onComplete}
            disabled={downloading !== null}
          >
            {allReady ? 'Commencer' : 'Fermer'}
          </button>
        </div>

      </div>
    </div>
  )
}

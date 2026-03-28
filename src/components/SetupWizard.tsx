/**
 * SETUPWIZARD.TSX : Parametres et configuration
 * Version web/Docker : check dependencies Docker, gestion Ollama, MAJ via rebuild
 */

import { useState, useEffect } from 'react'
import logo from '@/assets/Clipr.svg'
import api from '@/api'

interface DependencyStatus { name: string; installed: boolean; version?: string }
interface SetupWizardProps { onComplete: () => void }

const Spinner = ({ className = 'w-5 h-5' }: { className?: string }) => (
  <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
)

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const [dependencies, setDependencies] = useState<DependencyStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [appVersion, setAppVersion] = useState('')

  // Ollama
  const [ollamaRunning, setOllamaRunning] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [pullingModel, setPullingModel] = useState(false)
  const [pullModelName, setPullModelName] = useState('')
  const [pullResult, setPullResult] = useState<{ success: boolean; message: string } | null>(null)

  // Update
  const [updateInfo, setUpdateInfo] = useState<any>(null)
  const [updating, setUpdating] = useState(false)

  const checkDependencies = async () => {
    setLoading(true)
    try { setDependencies(await api.checkDependencies()) } catch {}
    setLoading(false)
  }

  const refreshOllamaModels = async () => {
    try {
      const running = await api.checkOllama()
      setOllamaRunning(running)
      if (running) setOllamaModels(await api.listOllamaModels())
      else setOllamaModels([])
    } catch { setOllamaRunning(false); setOllamaModels([]) }
  }

  const handlePullModel = async () => {
    const name = pullModelName.trim()
    if (!name || pullingModel) return
    setPullingModel(true); setPullResult(null)
    try {
      const result = await api.pullOllamaModel(name)
      setPullResult(result)
      if (result.success) { setPullModelName(''); await refreshOllamaModels() }
    } catch (e: any) { setPullResult({ success: false, message: e.message }) }
    setPullingModel(false)
  }

  const handleCheckUpdate = async () => {
    try { setUpdateInfo(await api.checkForUpdates()) } catch (e: any) { setUpdateInfo({ error: e.message }) }
  }

  const handleUpdate = async () => {
    setUpdating(true)
    try {
      await api.installUpdate()
      // Le container va se rebuild — poll /api/health
      const pollHealth = setInterval(async () => {
        try {
          await fetch('/api/health')
          clearInterval(pollHealth)
          window.location.reload()
        } catch {}
      }, 3000)
    } catch { setUpdating(false) }
  }

  useEffect(() => {
    checkDependencies()
    refreshOllamaModels()
    api.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  const allReady = dependencies.length > 0 && dependencies.every(d => d.installed)
  const MODEL_SUGGESTIONS = ['qwen2.5:3b', 'llama3.2:3b', 'mistral:7b', 'phi3:mini']

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

  return (
    <div className="fixed inset-0 bg-background/98 backdrop-blur-sm flex items-center justify-center z-50 p-8">
      <div className="max-w-xl w-full bg-card rounded-xl shadow-2xl border border-border p-8 max-h-[90vh] overflow-y-auto custom-scrollbar">

        {/* Header */}
        <div className="text-center mb-8">
          <img src={logo} alt="Clipr" className="w-16 h-16 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-foreground mb-1">Clipr</h1>
          <p className="text-muted-foreground text-sm">
            {allReady ? 'Tout est pret !' : 'Configuration initiale'}
          </p>
        </div>

        {/* Dependencies */}
        <div className="space-y-2.5 mb-6">
          {dependencies.map((dep) => (
            <div key={dep.name} className={`p-3.5 rounded-xl border transition-colors ${dep.installed ? 'bg-green-500/5 border-green-500/20' : 'bg-secondary/10 border-border'}`}>
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${dep.installed ? 'bg-green-500/10' : 'bg-secondary/20'}`}>
                  {dep.installed ? (
                    <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    <svg className="w-4 h-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{dep.name}</p>
                  <p className="text-xs text-muted-foreground">{dep.installed ? dep.version || 'Installe' : 'Non disponible'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Ollama models */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Modeles Ollama</h2>
          <div className="p-4 rounded-xl border border-border bg-secondary/5 space-y-4">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${ollamaRunning ? 'bg-green-500' : 'bg-destructive'}`} />
              <span className="text-sm text-foreground">{ollamaRunning ? 'Ollama actif' : 'Ollama non demarre'}</span>
              <button className="ml-auto text-xs text-primary hover:text-primary/80" onClick={refreshOllamaModels}>Rafraichir</button>
            </div>

            {ollamaRunning && ollamaModels.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Modeles installes :</p>
                <div className="flex flex-wrap gap-1.5">
                  {ollamaModels.map(m => (
                    <span key={m} className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-mono font-medium bg-primary/10 text-primary border border-primary/20">{m}</span>
                  ))}
                </div>
              </div>
            )}

            {ollamaRunning && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Telecharger un modele :</p>
                <div className="flex gap-2">
                  <input type="text" value={pullModelName} onChange={(e) => setPullModelName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handlePullModel()} placeholder="ex: qwen2.5:3b" className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary" disabled={pullingModel} />
                  <button className={`px-4 py-2 rounded-lg text-sm font-medium ${pullingModel ? 'bg-primary/30 text-primary/60 cursor-not-allowed' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`} onClick={handlePullModel} disabled={pullingModel || !pullModelName.trim()}>
                    {pullingModel ? <span className="flex items-center gap-2"><Spinner className="w-4 h-4" />Pull...</span> : 'Pull'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {MODEL_SUGGESTIONS.map(s => {
                    const installed = ollamaModels.includes(s)
                    return (
                      <button key={s} className={`text-xs font-mono px-2 py-0.5 rounded-md ${installed ? 'bg-green-500/10 text-green-500 border border-green-500/20' : 'bg-secondary/10 text-muted-foreground hover:text-primary hover:bg-primary/10 border border-border'}`} onClick={() => !installed && setPullModelName(s)} disabled={installed}>
                        {installed && '✓ '}{s}
                      </button>
                    )
                  })}
                </div>
                {pullResult && <p className={`mt-2 text-xs ${pullResult.success ? 'text-green-500' : 'text-destructive'}`}>{pullResult.message}</p>}
              </div>
            )}
          </div>
        </div>

        {/* Mise a jour (Docker rebuild) */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Mise a jour</h2>
          <div className="p-4 rounded-xl border border-border bg-secondary/5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Version {appVersion || '...'}</p>
                {updateInfo?.available && <p className="text-xs text-primary">{updateInfo.commits} commit(s) disponible(s)</p>}
                {updateInfo && !updateInfo.available && !updateInfo.error && <p className="text-xs text-green-500">A jour</p>}
                {updateInfo?.error && <p className="text-xs text-destructive">{updateInfo.error}</p>}
              </div>
              <div className="flex gap-2">
                {updateInfo?.available && (
                  <button className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50" onClick={handleUpdate} disabled={updating}>
                    {updating ? <span className="flex items-center gap-2"><Spinner className="w-3 h-3" />MAJ...</span> : 'Mettre a jour'}
                  </button>
                )}
                <button className="px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary/20 text-foreground hover:bg-secondary/30 border border-border" onClick={handleCheckUpdate}>
                  Verifier
                </button>
              </div>
            </div>
            {updating && (
              <div className="text-xs text-primary animate-pulse">Rebuild Docker en cours... La page va se recharger automatiquement.</div>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Diagnostic</h2>
          <button className="w-full py-2 px-4 rounded-lg text-sm font-medium bg-secondary/20 text-foreground hover:bg-secondary/30 border border-border" onClick={() => api.exportLogs()}>
            Telecharger les logs
          </button>
        </div>

        {/* Documentation */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Documentation</h2>
          <button className="w-full py-2.5 px-4 rounded-xl text-sm font-medium bg-secondary/10 hover:bg-secondary/20 text-foreground border border-border flex items-center justify-center gap-2" onClick={() => window.open('/docs/', '_blank')}>
            <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
            Ouvrir la documentation
          </button>
        </div>

        {/* Action */}
        <button className={`w-full py-3 rounded-xl text-sm font-medium transition-colors ${allReady ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-secondary/20 text-foreground hover:bg-secondary/30 border border-border'}`} onClick={onComplete}>
          {allReady ? 'Commencer' : 'Fermer'}
        </button>
      </div>
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { useAuthStore } from '@/store/useAuthStore'
import { motion } from 'framer-motion'
import {
  Users, FolderKanban, HardDrive, Activity, RefreshCw,
  CheckCircle, XCircle, Lock, ScrollText, ArrowLeft, Cpu, Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'

interface SystemHealth {
  services: { ollama: boolean; ffmpeg: boolean }
  aiLock: any
  disk: { total: number; used: number; free: number }
  counts: { projects: number; users: number }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export default function AdminDashboard({ onBack }: { onBack: () => void }) {
  const { token } = useAuthStore()
  const [tab, setTab] = useState<'overview' | 'projects' | 'users' | 'logs'>('overview')
  const [system, setSystem] = useState<SystemHealth | null>(null)
  const [projects, setProjects] = useState<any[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [logTotal, setLogTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const headers = { 'Authorization': `Bearer ${token}` }

  const fetchSystem = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/system', { headers })
      if (res.ok) setSystem(await res.json())
    } catch {}
  }, [token])

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/projects', { headers })
      if (res.ok) setProjects(await res.json())
    } catch {}
  }, [token])

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users', { headers })
      if (res.ok) setUsers(await res.json())
    } catch {}
  }, [token])

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/logs?lines=200', { headers })
      if (res.ok) {
        const data = await res.json()
        setLogs(data.lines)
        setLogTotal(data.total)
      }
    } catch {}
  }, [token])

  const refreshAll = async () => {
    setLoading(true)
    await Promise.all([fetchSystem(), fetchProjects(), fetchUsers(), fetchLogs()])
    setLoading(false)
  }

  useEffect(() => { refreshAll() }, [])
  useEffect(() => {
    const interval = setInterval(fetchSystem, 30000)
    return () => clearInterval(interval)
  }, [fetchSystem])

  const diskPercent = system?.disk.total ? Math.round((system.disk.used / system.disk.total) * 100) : 0

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onBack} className="h-8 gap-1">
            <ArrowLeft className="w-4 h-4" /> Retour
          </Button>
          <h1 className="text-2xl font-black text-foreground">Administration</h1>
        </div>
        <Button variant="secondary" size="sm" onClick={refreshAll} disabled={loading} className="h-8 gap-2">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Rafraîchir
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {[
          { id: 'overview' as const, label: 'Vue d\'ensemble', icon: Activity },
          { id: 'projects' as const, label: 'Projets', icon: FolderKanban },
          { id: 'users' as const, label: 'Utilisateurs', icon: Users },
          { id: 'logs' as const, label: 'Logs', icon: ScrollText },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); if (t.id === 'logs') fetchLogs() }}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
              tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && system && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
          {/* Stats cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Utilisateurs" value={system.counts.users} icon={Users} />
            <StatCard label="Projets actifs" value={system.counts.projects} icon={FolderKanban} />
            <StatCard
              label="Espace disque"
              value={`${diskPercent}%`}
              subtitle={`${formatBytes(system.disk.used)} / ${formatBytes(system.disk.total)}`}
              icon={HardDrive}
              alert={diskPercent > 80}
            />
            <StatCard
              label="IA"
              value={system.aiLock ? 'Occupée' : 'Libre'}
              subtitle={system.aiLock ? `Par ${system.aiLock.username}` : undefined}
              icon={system.aiLock ? Lock : Cpu}
              alert={!!system.aiLock}
            />
          </div>

          {/* Services */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-foreground mb-4">Services</h3>
            <div className="grid grid-cols-2 gap-3">
              <ServiceStatus name="Ollama (LLM)" ok={system.services.ollama} />
              <ServiceStatus name="FFmpeg" ok={system.services.ffmpeg} />
            </div>
          </div>
        </motion.div>
      )}

      {tab === 'projects' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left p-3 font-semibold text-muted-foreground">Projet</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Propriétaire</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Type</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Statut</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Segments</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Mis à jour</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p: any) => (
                  <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="p-3 font-medium text-foreground">{p.name}</td>
                    <td className="p-3 text-muted-foreground">{p.owner_username || '—'}</td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        p.type === 'ai' ? 'bg-violet-500/10 text-violet-400' : 'bg-blue-500/10 text-blue-400'
                      }`}>{p.type}</span>
                    </td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        p.status === 'done' ? 'bg-green-500/10 text-green-400' :
                        p.status === 'processing' ? 'bg-amber-500/10 text-amber-400' :
                        'bg-zinc-500/10 text-zinc-400'
                      }`}>{p.status}</span>
                    </td>
                    <td className="p-3 text-muted-foreground font-mono">{p.data?.segments?.length || 0}</td>
                    <td className="p-3 text-muted-foreground">
                      {new Date(p.updated_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
                {projects.length === 0 && (
                  <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Aucun projet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {tab === 'users' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left p-3 font-semibold text-muted-foreground">Utilisateur</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Email</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Rôle</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Inscrit le</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u: any) => (
                  <tr key={u.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="p-3 font-medium text-foreground">{u.username}</td>
                    <td className="p-3 text-muted-foreground">{u.email}</td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        u.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-zinc-500/10 text-zinc-400'
                      }`}>{u.role}</span>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {tab === 'logs' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{logTotal} lignes au total — 200 dernières affichées</span>
            <Button variant="secondary" size="sm" onClick={fetchLogs} className="h-7 text-xs gap-1">
              <RefreshCw className="w-3 h-3" /> Actualiser
            </Button>
          </div>
          <div className="bg-zinc-950 border border-border rounded-xl p-4 h-[500px] overflow-y-auto font-mono text-[10px] leading-relaxed">
            {logs.map((line, i) => {
              const isError = line.includes('[ERROR]')
              const isWarn = line.includes('[WARN]')
              return (
                <div key={i} className={`${isError ? 'text-red-400' : isWarn ? 'text-amber-400' : 'text-zinc-400'}`}>
                  {line}
                </div>
              )
            })}
            {logs.length === 0 && <span className="text-zinc-600">Aucun log</span>}
          </div>
        </motion.div>
      )}
    </div>
  )
}

function StatCard({ label, value, subtitle, icon: Icon, alert }: {
  label: string; value: string | number; subtitle?: string; icon: any; alert?: boolean
}) {
  return (
    <div className={`bg-card border rounded-xl p-4 ${alert ? 'border-amber-500/30' : 'border-border'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className={`w-4 h-4 ${alert ? 'text-amber-500' : 'text-muted-foreground'}`} />
      </div>
      <p className="text-2xl font-black text-foreground">{value}</p>
      {subtitle && <p className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  )
}

function ServiceStatus({ name, ok }: { name: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between p-3 bg-secondary/20 rounded-lg">
      <span className="text-xs font-medium text-foreground">{name}</span>
      <div className="flex items-center gap-1.5">
        {ok ? (
          <>
            <CheckCircle className="w-3.5 h-3.5 text-green-500" />
            <span className="text-[10px] font-semibold text-green-500">Actif</span>
          </>
        ) : (
          <>
            <XCircle className="w-3.5 h-3.5 text-destructive" />
            <span className="text-[10px] font-semibold text-destructive">Inactif</span>
          </>
        )}
      </div>
    </div>
  )
}

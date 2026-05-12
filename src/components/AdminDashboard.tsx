/**
 * ADMINDASHBOARD.TSX — Tableau de bord d'administration de Clipr
 *
 * Ce fichier contient le panneau d'administration réservé aux utilisateurs
 * ayant le rôle "admin". Il permet de :
 * - Voir une vue d'ensemble du système (état des services, espace disque, etc.)
 * - Lister et ouvrir tous les projets de la plateforme
 * - Gérer les utilisateurs inscrits
 * - Consulter les logs du serveur en temps réel
 *
 * Les données sont récupérées via l'API backend (/api/admin/*) et rafraîchies
 * automatiquement toutes les 30 secondes pour la santé du système.
 */

// --- Imports ---
// useState : état local, useEffect : effets de bord (appels API au montage),
// useCallback : mémorise les fonctions pour éviter des re-rendus inutiles
import { useState, useEffect, useCallback, useRef } from 'react'
// Store Zustand contenant le token d'authentification JWT
import { useAuthStore } from '@/store/useAuthStore'
// Bibliothèque d'animation pour les transitions fluides entre onglets
import { motion } from 'framer-motion'
// Icônes SVG utilisées dans l'interface (chaque icône correspond à un élément visuel)
import {
  Users, FolderKanban, HardDrive, Activity, RefreshCw,
  CheckCircle, XCircle, Lock, ScrollText, ArrowLeft, Cpu, Trash2, ExternalLink, UserCheck,
  MessageCircle, Send, Paperclip, X, Loader2
} from 'lucide-react'
// Composant bouton réutilisable du design system de l'application
import { Button } from '@/components/ui/button'
// Module API centralisé pour les appels au backend
import api from '@/api'

/**
 * Interface décrivant la structure des données de santé du système.
 * C'est ce que le backend renvoie quand on appelle /api/admin/system.
 */
interface SystemHealth {
  // État des services externes : Ollama (IA) et FFmpeg (traitement vidéo)
  services: { ollama: boolean; ffmpeg: boolean }
  // Verrou IA : indique si un utilisateur utilise actuellement le modèle IA (null si libre)
  aiLock: any
  // Informations sur l'espace disque du serveur (en octets)
  disk: { total: number; used: number; free: number }
  // Compteurs globaux : nombre de projets et d'utilisateurs
  counts: { projects: number; users: number }
}

/**
 * Fonction utilitaire pour convertir un nombre d'octets en une chaîne lisible.
 * Par exemple : 1073741824 octets => "1 GB"
 * Elle utilise une échelle logarithmique en base 1024 (B, KB, MB, GB, TB).
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  // On calcule l'indice de l'unité appropriée via le logarithme
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * Composant principal du tableau de bord d'administration.
 *
 * Props :
 * - onBack : fonction appelée quand l'admin clique sur "Retour" pour revenir à l'app
 * - onLoadProject : fonction optionnelle pour ouvrir un projet directement depuis le dashboard
 */
export default function AdminDashboard({ onBack, onLoadProject }: { onBack: () => void; onLoadProject?: (projectData: any) => void }) {
  // Récupération du token JWT pour authentifier les requêtes API admin
  const { token } = useAuthStore()

  // Onglet actif : vue d'ensemble, projets, utilisateurs, inscriptions, support, logs
  const [tab, setTab] = useState<'overview' | 'projects' | 'users' | 'pending' | 'support' | 'logs'>('overview')

  // Données récupérées depuis le backend
  const [system, setSystem] = useState<SystemHealth | null>(null) // Santé du système
  const [projects, setProjects] = useState<any[]>([])              // Liste de tous les projets
  const [users, setUsers] = useState<any[]>([])                    // Liste de tous les utilisateurs
  const [pendingUsers, setPendingUsers] = useState<any[]>([])      // Inscriptions en attente de validation
  const [regSettings, setRegSettings] = useState<{ open: boolean; mailerConfigured: boolean; adminEmail: string | null } | null>(null)
  // Support : conversations + thread selectionne + composer
  const [supportConvs, setSupportConvs] = useState<any[]>([])
  const [supportTotalUnread, setSupportTotalUnread] = useState(0)
  const [supportSelectedUserId, setSupportSelectedUserId] = useState<string | null>(null)
  const [supportThread, setSupportThread] = useState<any[]>([])
  const [supportContent, setSupportContent] = useState('')
  const [supportFile, setSupportFile] = useState<File | null>(null)
  const [supportSending, setSupportSending] = useState(false)
  const supportFileRef = useRef<HTMLInputElement>(null)
  const supportScrollRef = useRef<HTMLDivElement>(null)
  const [logs, setLogs] = useState<string[]>([])                   // Lignes de log du serveur
  const [logTotal, setLogTotal] = useState(0)                      // Nombre total de lignes de log
  const [loading, setLoading] = useState(false)                    // Indicateur de chargement global

  // En-têtes HTTP avec le token Bearer pour les requêtes authentifiées
  const headers = { 'Authorization': `Bearer ${token}` }

  /**
   * Récupère les informations de santé du système (services, disque, compteurs).
   * Utilise useCallback pour que la fonction reste stable entre les rendus
   * (important pour le setInterval plus bas).
   */
  const fetchSystem = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/system', { headers })
      if (res.ok) setSystem(await res.json())
    } catch {}
  }, [token])

  /**
   * Récupère la liste complète de tous les projets de la plateforme.
   */
  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/projects', { headers })
      if (res.ok) setProjects(await res.json())
    } catch {}
  }, [token])

  /**
   * Récupère la liste complète de tous les utilisateurs inscrits.
   */
  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users', { headers })
      if (res.ok) setUsers(await res.json())
    } catch {}
  }, [token])

  /** Liste des inscriptions en attente de validation. */
  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users/pending', { headers })
      if (res.ok) setPendingUsers(await res.json())
    } catch {}
  }, [token])

  /** Etat actuel des inscriptions (ouvertes/fermees + config mailer). */
  const fetchRegSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/settings/registration', { headers })
      if (res.ok) setRegSettings(await res.json())
    } catch {}
  }, [token])

  /** Liste des conversations support + total non-lus admin. */
  const fetchSupportConvs = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/support/conversations', { headers })
      if (res.ok) {
        const data = await res.json()
        setSupportConvs(data.conversations || [])
        setSupportTotalUnread(data.totalUnread || 0)
      }
    } catch {}
  }, [token])

  /** Charge le fil d'un user et marque comme lu cote admin. */
  const fetchSupportThread = useCallback(async (userId: string) => {
    setSupportSelectedUserId(userId)
    try {
      const res = await fetch(`/api/admin/support/conversations/${userId}`, { headers })
      if (res.ok) {
        const data = await res.json()
        setSupportThread(data.messages || [])
        // Mark read
        await fetch(`/api/admin/support/conversations/${userId}/mark-read`, { method: 'POST', headers })
        await fetchSupportConvs()
      }
    } catch {}
  }, [token, fetchSupportConvs])

  /** Envoyer un message admin dans le fil selectionne. */
  const sendSupportMessage = async () => {
    if (!supportSelectedUserId || supportSending) return
    const trimmed = supportContent.trim()
    if (!trimmed && !supportFile) return
    setSupportSending(true)
    try {
      const form = new FormData()
      form.append('content', trimmed)
      if (supportFile) form.append('attachment', supportFile)
      const res = await fetch(`/api/admin/support/conversations/${supportSelectedUserId}/messages`, {
        method: 'POST', headers, body: form,
      })
      if (res.ok) {
        setSupportContent('')
        setSupportFile(null)
        if (supportFileRef.current) supportFileRef.current.value = ''
        await fetchSupportThread(supportSelectedUserId)
      }
    } catch {}
    finally { setSupportSending(false) }
  }

  // WS : ecoute des nouveaux messages support pour rafraichir liste + thread
  useEffect(() => {
    if (!token) return
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${wsProto}//${location.host}/ws`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'support:message') {
          fetchSupportConvs()
          if (supportSelectedUserId && msg.message?.user_id === supportSelectedUserId) {
            fetchSupportThread(supportSelectedUserId)
          }
        }
      } catch {}
    }
    return () => ws.close()
  }, [token, supportSelectedUserId, fetchSupportConvs, fetchSupportThread])

  // Auto-scroll bas du thread
  useEffect(() => {
    if (supportScrollRef.current) supportScrollRef.current.scrollTop = supportScrollRef.current.scrollHeight
  }, [supportThread])

  /** Approuve ou rejette une inscription en attente. */
  const decideUser = async (id: string, action: 'approve' | 'reject') => {
    try {
      const res = await fetch(`/api/admin/users/${id}/${action}`, { method: 'POST', headers })
      if (res.ok) { await fetchPending(); await fetchUsers() }
    } catch {}
  }

  /** Bascule le flag d'ouverture des inscriptions. */
  const toggleRegistration = async () => {
    if (!regSettings) return
    try {
      const res = await fetch('/api/admin/settings/registration', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ open: !regSettings.open }),
      })
      if (res.ok) await fetchRegSettings()
    } catch {}
  }

  /**
   * Récupère les 200 dernières lignes de logs du serveur.
   * Le backend renvoie aussi le nombre total de lignes disponibles.
   */
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

  /**
   * Rafraîchit toutes les données en parallèle (système, projets, utilisateurs, logs).
   * Promise.all exécute les 4 appels API simultanément pour gagner du temps.
   */
  const refreshAll = async () => {
    setLoading(true)
    await Promise.all([fetchSystem(), fetchProjects(), fetchUsers(), fetchPending(), fetchRegSettings(), fetchSupportConvs(), fetchLogs()])
    setLoading(false)
  }

  // Au montage du composant, on charge toutes les données une première fois
  useEffect(() => { refreshAll() }, [])

  // Rafraîchissement automatique de la santé du système toutes les 30 secondes.
  // Le clearInterval dans le return nettoie le timer quand le composant est démonté.
  useEffect(() => {
    const interval = setInterval(fetchSystem, 30000)
    return () => clearInterval(interval)
  }, [fetchSystem])

  /**
   * Ouvre un projet en le chargeant via l'API, puis appelle onLoadProject
   * pour que le composant parent puisse afficher le projet dans l'éditeur.
   */
  const openProject = async (projectId: string) => {
    try {
      const data = await api.loadProjectById(projectId)
      onLoadProject?.(data)
    } catch (err: any) {
      console.error('Failed to load project:', err)
    }
  }

  // Calcul du pourcentage d'espace disque utilisé (pour la jauge visuelle)
  const diskPercent = system?.disk.total ? Math.round((system.disk.used / system.disk.total) * 100) : 0

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* En-tête : bouton retour, titre et bouton de rafraîchissement */}
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

      {/* Barre d'onglets : on itère sur un tableau d'objets pour générer chaque onglet.
          Quand on clique sur "Logs", on recharge aussi les logs automatiquement. */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {[
          { id: 'overview' as const, label: 'Vue d\'ensemble', icon: Activity },
          { id: 'projects' as const, label: 'Projets', icon: FolderKanban },
          { id: 'users' as const, label: 'Utilisateurs', icon: Users },
          { id: 'pending' as const, label: `Inscriptions${pendingUsers.length ? ` (${pendingUsers.length})` : ''}`, icon: UserCheck },
          { id: 'support' as const, label: `Support${supportTotalUnread ? ` (${supportTotalUnread})` : ''}`, icon: MessageCircle },
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

      {/* ===== ONGLET : VUE D'ENSEMBLE ===== */}
      {/* Affiche les statistiques globales et l'état des services */}
      {tab === 'overview' && system && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
          {/* Cartes de statistiques : utilisateurs, projets, disque, état de l'IA */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Utilisateurs" value={system.counts.users} icon={Users} />
            <StatCard label="Projets actifs" value={system.counts.projects} icon={FolderKanban} />
            <StatCard
              label="Espace disque"
              value={`${diskPercent}%`}
              subtitle={`${formatBytes(system.disk.used)} / ${formatBytes(system.disk.total)}`}
              icon={HardDrive}
              alert={diskPercent > 80} // Alerte visuelle si le disque est rempli à plus de 80%
            />
            <StatCard
              label="IA"
              value={system.aiLock ? 'Occupée' : 'Libre'}
              subtitle={system.aiLock ? `Par ${system.aiLock.username}` : undefined}
              icon={system.aiLock ? Lock : Cpu}
              alert={!!system.aiLock} // Alerte si l'IA est verrouillée par un utilisateur
            />
          </div>

          {/* Section services : affiche si Ollama et FFmpeg sont actifs ou non */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold text-foreground mb-4">Services</h3>
            <div className="grid grid-cols-2 gap-3">
              <ServiceStatus name="Ollama (LLM)" ok={system.services.ollama} />
              <ServiceStatus name="FFmpeg" ok={system.services.ffmpeg} />
            </div>
          </div>
        </motion.div>
      )}

      {/* ===== ONGLET : PROJETS ===== */}
      {/* Tableau listant tous les projets de la plateforme avec leurs métadonnées */}
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
                {/* Chaque ligne du tableau représente un projet.
                    Un clic sur la ligne ouvre le projet dans l'éditeur. */}
                {projects.map((p: any) => (
                  <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/20 cursor-pointer" onClick={() => openProject(p.id)}>
                    <td className="p-3 font-medium text-foreground flex items-center gap-1.5">{p.name} <ExternalLink className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100" /></td>
                    <td className="p-3 text-muted-foreground">{p.owner_username || '—'}</td>
                    {/* Badge coloré pour le type : "ai" en violet, autre en bleu */}
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        p.type === 'ai' ? 'bg-violet-500/10 text-violet-400' : 'bg-blue-500/10 text-blue-400'
                      }`}>{p.type}</span>
                    </td>
                    {/* Badge coloré pour le statut : vert=terminé, orange=en cours, gris=autre */}
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        p.status === 'done' ? 'bg-green-500/10 text-green-400' :
                        p.status === 'processing' ? 'bg-amber-500/10 text-amber-400' :
                        'bg-zinc-500/10 text-zinc-400'
                      }`}>{p.status}</span>
                    </td>
                    {/* Nombre de segments vidéo dans le projet */}
                    <td className="p-3 text-muted-foreground font-mono">{p.data?.segments?.length || 0}</td>
                    {/* Date de dernière modification, formatée en français */}
                    <td className="p-3 text-muted-foreground">
                      {new Date(p.updated_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
                {/* Message affiché si aucun projet n'existe */}
                {projects.length === 0 && (
                  <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Aucun projet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* ===== ONGLET : UTILISATEURS ===== */}
      {/* Tableau listant tous les utilisateurs inscrits sur la plateforme */}
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
                    {/* Badge pour le rôle : "admin" en couleur primaire, "user" en gris */}
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        u.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-zinc-500/10 text-zinc-400'
                      }`}>{u.role}</span>
                    </td>
                    {/* Date d'inscription formatée en français */}
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

      {/* ===== ONGLET : INSCRIPTIONS EN ATTENTE ===== */}
      {tab === 'pending' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
          {/* Bandeau de controle : toggle ouverture des inscriptions + etat mailer */}
          <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-foreground">
                Inscriptions {regSettings?.open ? 'ouvertes' : 'fermees'}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {regSettings?.mailerConfigured
                  ? <>Notifications envoyees a <span className="font-mono">{regSettings.adminEmail || '?'}</span></>
                  : <span className="text-amber-500">SMTP non configure — pas d'emails, validation manuelle uniquement</span>}
              </div>
            </div>
            <Button variant={regSettings?.open ? 'secondary' : 'default'} size="sm" onClick={toggleRegistration} className="h-8 text-xs">
              {regSettings?.open ? 'Fermer les inscriptions' : 'Ouvrir les inscriptions'}
            </Button>
          </div>

          {/* Liste des comptes en attente */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left p-3 font-semibold text-muted-foreground">Utilisateur</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Email</th>
                  <th className="text-left p-3 font-semibold text-muted-foreground">Demande le</th>
                  <th className="text-right p-3 font-semibold text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingUsers.map((u: any) => (
                  <tr key={u.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="p-3 font-medium text-foreground">{u.username}</td>
                    <td className="p-3 text-muted-foreground">{u.email}</td>
                    <td className="p-3 text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="p-3 text-right">
                      <Button variant="default" size="sm" onClick={() => decideUser(u.id, 'approve')} className="h-7 text-[11px] gap-1 mr-1.5">
                        <CheckCircle className="w-3 h-3" /> Approuver
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => decideUser(u.id, 'reject')} className="h-7 text-[11px] gap-1">
                        <XCircle className="w-3 h-3" /> Rejeter
                      </Button>
                    </td>
                  </tr>
                ))}
                {pendingUsers.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">Aucune inscription en attente</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* ===== ONGLET : SUPPORT (chat avec utilisateurs) ===== */}
      {tab === 'support' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-1 md:grid-cols-3 gap-4 h-[600px]">
          {/* Colonne gauche : liste des conversations */}
          <div className="bg-card border border-border rounded-xl overflow-hidden flex flex-col">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Conversations</span>
              <span className="text-[10px] text-muted-foreground">{supportConvs.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {supportConvs.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-10 px-4">Aucune conversation</div>
              ) : supportConvs.map(c => (
                <button
                  key={c.user_id}
                  onClick={() => fetchSupportThread(c.user_id)}
                  className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-secondary/40 transition-colors ${
                    supportSelectedUserId === c.user_id ? 'bg-primary/10' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-foreground truncate">{c.username}</span>
                    {c.unread_admin > 0 && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-destructive text-destructive-foreground">
                        {c.unread_admin}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {c.has_attachment ? '📎 ' : ''}{c.last_message || '(image)'}
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 font-mono mt-0.5">
                    {c.last_at ? new Date(c.last_at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Colonne droite : thread + composer */}
          <div className="md:col-span-2 bg-card border border-border rounded-xl overflow-hidden flex flex-col">
            {!supportSelectedUserId ? (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                Selectionne une conversation pour repondre
              </div>
            ) : (
              <>
                <div className="px-3 py-2 border-b border-border bg-secondary/20">
                  <span className="text-xs font-bold text-foreground">
                    {supportConvs.find(c => c.user_id === supportSelectedUserId)?.username || 'Conversation'}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-2">
                    {supportConvs.find(c => c.user_id === supportSelectedUserId)?.email}
                  </span>
                </div>
                <div ref={supportScrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
                  {supportThread.map(m => {
                    const isAdmin = m.sender_role === 'admin'
                    const time = new Date(m.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
                    return (
                      <div key={m.id} className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[75%] rounded-lg px-3 py-2 text-xs ${
                          isAdmin ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'
                        }`}>
                          {m.attachment_path && (
                            <img
                              src={`/api/support/attachments/${m.attachment_path}?t=${token}`}
                              alt="piece jointe"
                              className="rounded mb-1.5 max-w-full max-h-[240px] cursor-pointer"
                              onClick={() => window.open(`/api/support/attachments/${m.attachment_path}?t=${token}`, '_blank')}
                            />
                          )}
                          {m.content && <div className="whitespace-pre-wrap break-words">{m.content}</div>}
                          <div className={`text-[9px] mt-1 ${isAdmin ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>{time}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="p-3 border-t border-border space-y-2 bg-secondary/10">
                  {supportFile && (
                    <div className="flex items-center gap-2 px-2 py-1 bg-secondary rounded text-[11px]">
                      <Paperclip className="w-3 h-3 text-muted-foreground" />
                      <span className="flex-1 truncate text-foreground">{supportFile.name}</span>
                      <button onClick={() => { setSupportFile(null); if (supportFileRef.current) supportFileRef.current.value = '' }} className="hover:text-destructive">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <input
                      ref={supportFileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={e => e.target.files?.[0] && setSupportFile(e.target.files[0])}
                    />
                    <button
                      onClick={() => supportFileRef.current?.click()}
                      className="p-2 rounded-lg bg-secondary hover:bg-secondary/70 text-muted-foreground hover:text-foreground"
                      title="Joindre une image"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                    <textarea
                      value={supportContent}
                      onChange={e => setSupportContent(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendSupportMessage() } }}
                      placeholder="Repondre... (Ctrl+Enter pour envoyer)"
                      rows={2}
                      className="flex-1 resize-none px-2.5 py-1.5 bg-background border border-border rounded-lg text-xs outline-none focus:ring-1 focus:ring-primary/50"
                    />
                    <button
                      onClick={sendSupportMessage}
                      disabled={supportSending || (!supportContent.trim() && !supportFile)}
                      className="p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                    >
                      {supportSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </motion.div>
      )}

      {/* ===== ONGLET : LOGS ===== */}
      {/* Affiche les 200 dernières lignes de log du serveur dans une console stylisée.
          Les lignes contenant [ERROR] sont en rouge, [WARN] en orange. */}
      {tab === 'logs' && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{logTotal} lignes au total — 200 dernières affichées</span>
            <Button variant="secondary" size="sm" onClick={fetchLogs} className="h-7 text-xs gap-1">
              <RefreshCw className="w-3 h-3" /> Actualiser
            </Button>
          </div>
          {/* Zone de logs avec défilement vertical, style terminal */}
          <div className="bg-zinc-950 border border-border rounded-xl p-4 h-[500px] overflow-y-auto font-mono text-[10px] leading-relaxed">
            {logs.map((line, i) => {
              // Coloration conditionnelle selon le niveau de log
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

/**
 * Composant StatCard — Carte de statistique individuelle.
 * Affiche un label, une valeur principale, un sous-titre optionnel et une icône.
 * Le paramètre "alert" permet de mettre la carte en surbrillance orange
 * pour signaler un état critique (ex: disque presque plein).
 *
 * Props :
 * - label : titre de la statistique (ex: "Utilisateurs")
 * - value : valeur à afficher (nombre ou chaîne)
 * - subtitle : texte secondaire optionnel
 * - icon : composant icône à afficher
 * - alert : si true, la bordure et l'icône passent en orange
 */
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

/**
 * Composant ServiceStatus — Indicateur d'état d'un service.
 * Affiche le nom du service avec une icône verte (actif) ou rouge (inactif).
 *
 * Props :
 * - name : nom du service (ex: "Ollama (LLM)")
 * - ok : true si le service est en marche, false sinon
 */
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

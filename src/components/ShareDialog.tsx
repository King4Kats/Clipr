import { useState, useEffect } from 'react'
import { X, Share2, UserPlus, Trash2, Search, Crown, Eye, Pencil } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import api from '@/api'

interface ShareDialogProps {
  projectId: string
  projectName: string
  onClose: () => void
}

export default function ShareDialog({ projectId, projectName, onClose }: ShareDialogProps) {
  const [shares, setShares] = useState<any[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [selectedRole, setSelectedRole] = useState<'viewer' | 'editor'>('viewer')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const loadShares = async () => {
    const data = await api.getProjectShares(projectId)
    setShares(data)
  }

  useEffect(() => { loadShares() }, [projectId])

  useEffect(() => {
    if (searchQuery.length < 2) { setSearchResults([]); return }
    const timer = setTimeout(async () => {
      const results = await api.searchUsers(searchQuery)
      // Filter out already shared users
      const sharedIds = new Set(shares.map(s => s.user_id))
      setSearchResults(results.filter(r => !sharedIds.has(r.id)))
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, shares])

  const handleShare = async (username: string) => {
    setError('')
    setLoading(true)
    try {
      await api.shareProject(projectId, username, selectedRole)
      setSearchQuery('')
      setSearchResults([])
      await loadShares()
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }

  const handleUnshare = async (userId: string) => {
    await api.unshareProject(projectId, userId)
    await loadShares()
  }

  const handleUpdateRole = async (username: string, newRole: 'viewer' | 'editor') => {
    await api.shareProject(projectId, username, newRole)
    await loadShares()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Partager "{projectName}"</h3>
          </div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        {/* Search & Add */}
        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Chercher un utilisateur..."
                className="w-full pl-8 pr-3 py-2 bg-secondary/50 border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value as any)}
              className="px-2 py-2 bg-secondary/50 border border-border rounded-lg text-xs text-foreground outline-none"
            >
              <option value="viewer">Lecteur</option>
              <option value="editor">Éditeur</option>
            </select>
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              {searchResults.map(user => (
                <button
                  key={user.id}
                  onClick={() => handleShare(user.username)}
                  disabled={loading}
                  className="w-full flex items-center justify-between p-2.5 hover:bg-secondary/50 text-xs transition-colors border-b border-border/50 last:border-0"
                >
                  <div>
                    <span className="font-semibold text-foreground">{user.username}</span>
                    <span className="text-muted-foreground ml-2">{user.email}</span>
                  </div>
                  <UserPlus className="w-3.5 h-3.5 text-primary" />
                </button>
              ))}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {/* Current shares */}
        <div className="px-4 pb-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Partagé avec ({shares.length})
          </p>

          {shares.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-3 text-center">
              Aucun partage pour le moment
            </p>
          ) : (
            <div className="space-y-1.5">
              {shares.map(share => (
                <div key={share.user_id} className="flex items-center justify-between p-2.5 bg-secondary/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">{share.username}</span>
                    <button
                      onClick={() => handleUpdateRole(share.username, share.role === 'viewer' ? 'editor' : 'viewer')}
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase cursor-pointer transition-colors ${
                        share.role === 'editor'
                          ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'
                          : 'bg-zinc-500/10 text-zinc-400 hover:bg-zinc-500/20'
                      }`}
                      title="Cliquer pour changer le rôle"
                    >
                      {share.role === 'editor' ? <Pencil className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                      {share.role === 'editor' ? 'Éditeur' : 'Lecteur'}
                    </button>
                  </div>
                  <button
                    onClick={() => handleUnshare(share.user_id)}
                    className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                    title="Retirer l'accès"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}

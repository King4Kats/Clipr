/**
 * SHAREDIALOG.TSX — Boîte de dialogue de partage de projet
 *
 * Ce fichier contient le composant modal (fenêtre modale) qui permet de
 * partager un projet avec d'autres utilisateurs de la plateforme.
 * L'utilisateur peut :
 * - Rechercher des utilisateurs par nom/email
 * - Les ajouter en tant que "lecteur" (viewer) ou "éditeur" (editor)
 * - Changer le rôle d'un utilisateur déjà partagé
 * - Retirer l'accès à un utilisateur
 *
 * La recherche utilise un debounce de 300ms pour ne pas surcharger l'API
 * à chaque frappe de clavier.
 */

// --- Imports ---
// useState : gérer l'état local, useEffect : exécuter du code quand des dépendances changent
import { useState, useEffect } from 'react'
// Icônes SVG : X (fermer), Share2 (partage), UserPlus (ajouter), Trash2 (supprimer),
// Search (recherche), Eye (lecteur), Pencil (éditeur)
import { X, Share2, UserPlus, Trash2, Search, Eye, Pencil } from 'lucide-react'
// Bibliothèque d'animation : motion pour les transitions, AnimatePresence pour gérer les sorties
import { motion, AnimatePresence } from 'framer-motion'
// Composant bouton réutilisable du design system
import { Button } from '@/components/ui/button'
// Module API centralisé pour les appels au backend
import api from '@/api'

/**
 * Interface des props du composant ShareDialog.
 * - projectId : identifiant unique du projet à partager
 * - projectName : nom du projet (affiché dans le titre de la modale)
 * - onClose : fonction appelée pour fermer la modale
 */
interface ShareDialogProps {
  projectId: string
  projectName: string
  onClose: () => void
}

/**
 * Composant principal de la boîte de dialogue de partage.
 * Affiche une modale avec une barre de recherche d'utilisateurs,
 * la liste des partages existants, et des options pour gérer les rôles.
 */
export default function ShareDialog({ projectId, projectName, onClose }: ShareDialogProps) {
  // Liste des partages actuels du projet (utilisateurs ayant accès)
  const [shares, setShares] = useState<any[]>([])
  // Texte saisi dans la barre de recherche
  const [searchQuery, setSearchQuery] = useState('')
  // Résultats de la recherche d'utilisateurs
  const [searchResults, setSearchResults] = useState<any[]>([])
  // Rôle sélectionné pour les nouveaux partages ("viewer" = lecteur, "editor" = éditeur)
  const [selectedRole, setSelectedRole] = useState<'viewer' | 'editor'>('viewer')
  // Message d'erreur éventuel (ex: utilisateur introuvable)
  const [error, setError] = useState('')
  // Indicateur de chargement pendant un ajout de partage
  const [loading, setLoading] = useState(false)
  // Indique si une recherche a ete tentee (pour afficher "aucun resultat")
  const [hasSearched, setHasSearched] = useState(false)
  // Suggestions affichees au focus initial (tous les users hors deja partages)
  const [suggestions, setSuggestions] = useState<any[]>([])
  // Le champ recherche est-il actif (focus) ?
  const [searchFocused, setSearchFocused] = useState(false)

  /**
   * Charge la liste des partages existants pour ce projet depuis l'API.
   * Appelée au montage et après chaque modification (ajout/suppression).
   */
  const loadShares = async () => {
    const data = await api.getProjectShares(projectId)
    setShares(data)
  }

  // Au montage du composant (ou si le projectId change), on charge les partages
  useEffect(() => { loadShares() }, [projectId])

  // Au montage, on charge aussi tous les users (via recherche vide a 1 char "a")
  // pour avoir des suggestions des qu'on ouvre le dialog.
  // En realite on fait une recherche avec un wildcard implicite en envoyant
  // une lettre frequente, mais c'est sale. Plutot, on charge tous les users
  // via une recherche sur "" (le backend renverra 10 users max).
  useEffect(() => {
    api.searchUsers('').then((users) => {
      const sharedIds = new Set(shares.map((s) => s.user_id))
      setSuggestions(users.filter((u: any) => !sharedIds.has(u.id)))
    }).catch(() => { setSuggestions([]) })
  }, [shares])

  /**
   * Effet de recherche avec debounce :
   * - On attend 300ms après la dernière frappe avant de lancer la recherche
   * - Si l'utilisateur tape moins de 2 caractères, on vide les résultats
   * - On filtre les résultats pour exclure les utilisateurs déjà partagés
   *
   * Le clearTimeout dans le return annule la recherche précédente si
   * l'utilisateur tape une nouvelle lettre avant les 300ms.
   */
  useEffect(() => {
    if (searchQuery.length < 1) { setSearchResults([]); setHasSearched(false); return }
    const timer = setTimeout(async () => {
      try {
        const results = await api.searchUsers(searchQuery)
        const sharedIds = new Set(shares.map(s => s.user_id))
        setSearchResults(results.filter(r => !sharedIds.has(r.id)))
        setHasSearched(true)
      } catch (e: any) {
        console.error('Erreur recherche utilisateurs:', e)
        setError('Erreur de recherche : ' + (e.message || 'inconnue'))
        setSearchResults([])
        setHasSearched(true)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [searchQuery, shares])

  /**
   * Partage le projet avec un utilisateur donné.
   * Utilise le rôle sélectionné dans le dropdown (lecteur ou éditeur).
   * Après le partage, on vide la recherche et on recharge les partages.
   */
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

  /**
   * Retire l'accès d'un utilisateur au projet (supprime le partage).
   * Recharge ensuite la liste des partages pour mettre à jour l'affichage.
   */
  const handleUnshare = async (userId: string) => {
    await api.unshareProject(projectId, userId)
    await loadShares()
  }

  /**
   * Change le rôle d'un utilisateur déjà partagé.
   * Utilise la même API que handleShare : l'appel écrase le rôle existant.
   */
  const handleUpdateRole = async (username: string, newRole: 'viewer' | 'editor') => {
    await api.shareProject(projectId, username, newRole)
    await loadShares()
  }

  return (
    // Overlay sombre plein écran : un clic en dehors de la modale la ferme
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      {/* Conteneur de la modale avec animation d'apparition (zoom + fondu) */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()} // Empêche la fermeture si on clique dans la modale
      >
        {/* En-tête de la modale : icône de partage, titre et bouton de fermeture */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Partager "{projectName}"</h3>
          </div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        {/* ===== SECTION : RECHERCHE ET AJOUT ===== */}
        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            {/* Champ de recherche avec icône loupe intégrée */}
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                placeholder="Chercher un utilisateur..."
                className="w-full pl-8 pr-3 py-2 bg-secondary/50 border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {/* Sélecteur de rôle : lecteur ou éditeur */}
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value as any)}
              className="px-2 py-2 bg-secondary/50 border border-border rounded-lg text-xs text-foreground outline-none"
            >
              <option value="viewer">Lecteur</option>
              <option value="editor">Éditeur</option>
            </select>
          </div>

          {/*
            Dropdown :
            - Si l'utilisateur a tape >=1 char : on affiche les resultats filtres
              (ou "aucun resultat" si recherche faite mais vide)
            - Sinon, si le champ a le focus : on affiche les suggestions (tous les users)
          */}
          {(() => {
            const showSearchResults = searchQuery.length >= 1
            const list = showSearchResults ? searchResults : (searchFocused ? suggestions : [])
            if (list.length === 0 && showSearchResults && hasSearched) {
              return (
                <div className="border border-border rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground">
                    Aucun utilisateur trouve pour "<span className="font-semibold text-foreground">{searchQuery}</span>"
                  </p>
                </div>
              )
            }
            if (list.length === 0) return null
            return (
              <div className="border border-border rounded-lg overflow-hidden max-h-60 overflow-y-auto">
                {!showSearchResults && (
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary/30 px-2.5 py-1.5">
                    Utilisateurs disponibles
                  </div>
                )}
                {list.map((user) => (
                  <button
                    key={user.id}
                    onMouseDown={(e) => { e.preventDefault(); handleShare(user.username) }}
                    disabled={loading}
                    className="w-full flex items-center justify-between p-2.5 hover:bg-secondary/50 text-xs transition-colors border-b border-border/50 last:border-0 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-foreground truncate">{user.username}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{user.email}</div>
                    </div>
                    <UserPlus className="w-3.5 h-3.5 text-primary shrink-0 ml-2" />
                  </button>
                ))}
              </div>
            )
          })()}

          {/* Message d'erreur éventuel */}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {/* ===== SECTION : PARTAGES EXISTANTS ===== */}
        {/* Liste des utilisateurs ayant actuellement accès au projet */}
        <div className="px-4 pb-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Partagé avec ({shares.length})
          </p>

          {/* Message si aucun partage n'existe encore */}
          {shares.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-3 text-center">
              Aucun partage pour le moment
            </p>
          ) : (
            <div className="space-y-1.5">
              {shares.map(share => (
                <div key={share.user_id} className="flex items-center justify-between p-2.5 bg-secondary/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    {/* Nom de l'utilisateur */}
                    <span className="text-xs font-semibold text-foreground">{share.username}</span>
                    {/* Badge de rôle cliquable : un clic bascule entre lecteur et éditeur.
                        Bleu = éditeur, gris = lecteur */}
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
                  {/* Bouton pour retirer l'accès de cet utilisateur */}
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

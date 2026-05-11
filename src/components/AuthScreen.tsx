/**
 * AUTHSCREEN.TSX — Écran d'authentification de l'application Clipr
 *
 * Ce fichier contient le composant qui gère la connexion et l'inscription
 * des utilisateurs. Il affiche un formulaire qui bascule entre le mode
 * "connexion" et le mode "inscription". Les données saisies (nom d'utilisateur,
 * email, mot de passe) sont envoyées au store d'authentification (Zustand)
 * qui se charge de communiquer avec l'API backend.
 */

// --- Imports ---
// useState : hook React pour gérer l'état local du composant (ex: champs du formulaire)
import { useState, useEffect } from 'react'
// useAuthStore : store Zustand qui contient la logique d'authentification (login, register, etc.)
import { useAuthStore } from '@/store/useAuthStore'
// motion : bibliothèque d'animations pour React (transitions fluides)
import { motion } from 'framer-motion'
// Icônes provenant de la librairie lucide-react (icônes SVG légères)
// LogIn = icône de connexion, UserPlus = icône de création de compte, AlertCircle = icône d'erreur
import { LogIn, UserPlus, AlertCircle } from 'lucide-react'
// Logo de l'application Clipr (fichier SVG importé comme asset)
import logo from '@/assets/Clipr.svg'

/**
 * Composant principal de l'écran d'authentification.
 * Il gère deux modes : "login" (connexion) et "register" (inscription).
 * Le formulaire s'adapte dynamiquement selon le mode sélectionné.
 */
export default function AuthScreen() {
  // On récupère les fonctions et données du store d'authentification :
  // - login : fonction pour se connecter
  // - register : fonction pour créer un compte
  // - error : message d'erreur éventuel (ex: "mot de passe incorrect")
  // - clearError : fonction pour effacer le message d'erreur
  const { login, register, error, clearError } = useAuthStore()

  // État local pour savoir si on est en mode "login" ou "register"
  const [mode, setMode] = useState<'login' | 'register'>('login')
  // États locaux pour les champs du formulaire
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // État de chargement : true pendant qu'on attend la réponse du serveur
  const [loading, setLoading] = useState(false)
  // Message de succes "inscription enregistree, en attente de validation"
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  // Etat des inscriptions cote serveur (recupere au montage)
  const [registrationOpen, setRegistrationOpen] = useState<boolean>(true)

  // Au montage, on demande au serveur si les inscriptions sont ouvertes.
  // Si elles sont fermees (et qu'il y a deja un admin), on masque le bouton "S'inscrire".
  useEffect(() => {
    fetch('/api/auth/registration-status')
      .then(r => r.json())
      .then(d => setRegistrationOpen(!!d.open))
      .catch(() => {})
  }, [])

  /**
   * Fonction appelée lors de la soumission du formulaire.
   * Elle empêche le rechargement de la page (e.preventDefault),
   * puis appelle login() ou register() selon le mode courant.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setPendingMessage(null)
    if (mode === 'login') {
      await login(username, password)
    } else {
      const result = await register(username, email, password)
      // Si le serveur dit "pending" → on bascule sur l'ecran de confirmation
      if (result.ok && result.pending) {
        setPendingMessage(result.message || 'Inscription enregistree. Un administrateur va valider ton compte.')
      }
    }
    setLoading(false)
  }

  /**
   * Bascule entre le mode "login" et "register".
   * On efface aussi les erreurs précédentes pour repartir proprement.
   */
  const switchMode = () => {
    clearError()
    setPendingMessage(null)
    setMode(mode === 'login' ? 'register' : 'login')
  }

  // Si on a recu un message "compte en attente", on affiche un ecran de succes
  // a la place du formulaire (l'utilisateur ne peut pas se connecter de toute facon).
  if (pendingMessage) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 p-2 flex items-center justify-center mx-auto mb-4">
            <img src={logo} alt="Clipr" className="w-12 h-12" />
          </div>
          <h1 className="text-2xl font-black text-foreground tracking-tight mb-2">Inscription enregistree</h1>
          <p className="text-sm text-muted-foreground mb-6">{pendingMessage}</p>
          <button
            onClick={() => { setPendingMessage(null); setMode('login') }}
            className="text-primary text-sm font-semibold hover:underline"
          >
            Retour a la connexion
          </button>
        </motion.div>
      </div>
    )
  }

  return (
    // Conteneur plein écran centré verticalement et horizontalement
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      {/* Animation d'apparition : le formulaire glisse légèrement vers le haut en apparaissant */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        {/* Logo et titre de l'application */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 p-2 flex items-center justify-center mx-auto mb-4">
            <img src={logo} alt="Clipr" className="w-12 h-12" />
          </div>
          <h1 className="text-3xl font-black text-foreground tracking-tight">Clipr</h1>
          {/* Sous-titre dynamique selon le mode */}
          <p className="text-sm text-muted-foreground mt-1">
            {mode === 'login' ? 'Connectez-vous pour continuer' : 'Créer un compte'}
          </p>
        </div>

        {/* Formulaire de connexion / inscription */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Champ : nom d'utilisateur (ou email en mode connexion) */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {mode === 'login' ? 'Nom d\'utilisateur ou email' : 'Nom d\'utilisateur'}
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full px-3 py-2.5 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-2 focus:ring-primary/50 transition-all"
              placeholder={mode === 'login' ? 'utilisateur ou email@...' : 'utilisateur'}
              required
              autoFocus
            />
          </div>

          {/* Champ email : affiché uniquement en mode inscription */}
          {mode === 'register' && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full px-3 py-2.5 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                placeholder="email@exemple.com"
                required
              />
            </div>
          )}

          {/* Champ mot de passe */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Mot de passe
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full px-3 py-2.5 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-2 focus:ring-primary/50 transition-all"
              placeholder="••••••••"
              required
              minLength={mode === 'register' ? 8 : undefined}
            />
            {mode === 'register' && (
              <p className="text-[10px] text-muted-foreground/70 mt-1">Minimum 8 caracteres</p>
            )}
          </div>

          {/* Affichage du message d'erreur (si présent) avec une animation d'apparition */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-xs text-destructive"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </motion.div>
          )}

          {/* Bouton de soumission : affiche un spinner pendant le chargement,
              sinon l'icône et le texte adaptés au mode (connexion ou inscription) */}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              // Spinner animé pendant le chargement
              <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : mode === 'login' ? (
              <>
                <LogIn className="w-4 h-4" />
                Se connecter
              </>
            ) : (
              <>
                <UserPlus className="w-4 h-4" />
                Créer le compte
              </>
            )}
          </button>
        </form>

        {/* Lien pour basculer entre connexion et inscription.
            Si inscriptions fermees cote serveur, on masque le bouton "S'inscrire". */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          {mode === 'login' ? (
            registrationOpen ? (
              <>
                Pas encore de compte ?{' '}
                <button onClick={switchMode} className="text-primary font-semibold hover:underline">
                  S'inscrire
                </button>
              </>
            ) : (
              <span className="text-muted-foreground/60">Les inscriptions sont actuellement fermees.</span>
            )
          ) : (
            <>
              Déjà un compte ?{' '}
              <button onClick={switchMode} className="text-primary font-semibold hover:underline">
                Se connecter
              </button>
            </>
          )}
        </p>

        {/* Note informative : le premier utilisateur inscrit obtient le rôle administrateur */}
        {mode === 'register' && (
          <p className="text-center text-[10px] text-muted-foreground/50 mt-3">
            Le premier utilisateur inscrit devient administrateur.
          </p>
        )}
      </motion.div>
    </div>
  )
}

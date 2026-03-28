import { useState } from 'react'
import { useAuthStore } from '@/store/useAuthStore'
import { motion } from 'framer-motion'
import { LogIn, UserPlus, AlertCircle } from 'lucide-react'
import logo from '@/assets/Clipr.svg'

export default function AuthScreen() {
  const { login, register, error, clearError } = useAuthStore()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    if (mode === 'login') {
      await login(username, password)
    } else {
      await register(username, email, password)
    }
    setLoading(false)
  }

  const switchMode = () => {
    clearError()
    setMode(mode === 'login' ? 'register' : 'login')
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 p-2 flex items-center justify-center mx-auto mb-4">
            <img src={logo} alt="Clipr" className="w-12 h-12" />
          </div>
          <h1 className="text-3xl font-black text-foreground tracking-tight">Clipr</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {mode === 'login' ? 'Connectez-vous pour continuer' : 'Créer un compte'}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
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
            />
          </div>

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

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
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

        {/* Switch mode */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          {mode === 'login' ? (
            <>
              Pas encore de compte ?{' '}
              <button onClick={switchMode} className="text-primary font-semibold hover:underline">
                S'inscrire
              </button>
            </>
          ) : (
            <>
              Déjà un compte ?{' '}
              <button onClick={switchMode} className="text-primary font-semibold hover:underline">
                Se connecter
              </button>
            </>
          )}
        </p>

        {mode === 'register' && (
          <p className="text-center text-[10px] text-muted-foreground/50 mt-3">
            Le premier utilisateur inscrit devient administrateur.
          </p>
        )}
      </motion.div>
    </div>
  )
}

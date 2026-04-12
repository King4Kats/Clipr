/**
 * AUTHGUARD.TSX : Garde d'authentification (route protegee)
 *
 * Composant layout React Router qui protege les routes enfants.
 * Si l'utilisateur n'est pas connecte, il est redirige vers /login.
 * La page d'origine est sauvegardee dans le state pour y revenir apres connexion.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/useAuthStore'
import { Loader2 } from 'lucide-react'

export default function AuthGuard() {
  const { isAuthenticated, isLoading } = useAuthStore()
  const location = useLocation()

  // Affiche un spinner pendant la verification du token
  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    )
  }

  // Pas connecte → redirection vers /login (on memorise la page demandee)
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // Connecte → affiche les routes enfants
  return <Outlet />
}

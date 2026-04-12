/**
 * LOGINPAGE.TSX : Page de connexion / inscription
 *
 * Affiche l'ecran d'authentification (AuthScreen).
 * Si l'utilisateur est deja connecte, redirige vers la page d'origine
 * ou l'accueil par defaut.
 */

import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/useAuthStore'
import AuthScreen from '@/components/AuthScreen'

export default function LoginPage() {
  const { isAuthenticated } = useAuthStore()
  const location = useLocation()

  // Deja connecte → retour a la page d'origine ou a l'accueil
  if (isAuthenticated) {
    const from = (location.state as any)?.from?.pathname || '/'
    return <Navigate to={from} replace />
  }

  return <AuthScreen />
}

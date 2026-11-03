/**
 * LOGINPAGE.TSX : Page de connexion / inscription
 *
 * Affiche l'ecran d'authentification (AuthScreen).
 * Si l'utilisateur est deja connecte, redirige vers la page d'origine
 * ou l'accueil par defaut.
 *
 * Cette page est aussi le point d'atterrissage du retour du cloud Temonia (SSO) :
 * le serveur nous renvoie ici avec, dans le FRAGMENT de l'adresse (apres le #),
 * soit un jeton de session (#jeton=...&retour=/transcription), soit un message
 * d'erreur (#erreur_sso=...). Le fragment n'etant jamais envoye au serveur, le
 * jeton ne se retrouve pas dans les journaux d'acces.
 */

import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/useAuthStore'
import AuthScreen from '@/components/AuthScreen'

export default function LoginPage() {
  const { isAuthenticated, connecterAvecJeton } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()
  // Message d'erreur renvoye par le cloud, a afficher sur l'ecran de connexion
  const [erreurSso, setErreurSso] = useState<string | null>(null)

  useEffect(() => {
    const fragment = window.location.hash.replace(/^#/, '')
    if (!fragment) return
    const params = new URLSearchParams(fragment)

    const erreur = params.get('erreur_sso')
    if (erreur) {
      setErreurSso(erreur)
      // On nettoie l'adresse pour que le message ne revienne pas au rechargement
      window.history.replaceState(null, '', '/login')
      return
    }

    const jeton = params.get('jeton')
    if (jeton) {
      const retour = params.get('retour') || '/'
      window.history.replaceState(null, '', '/login')
      connecterAvecJeton(jeton).then(ok => {
        if (ok) navigate(retour.startsWith('/') && !retour.startsWith('//') ? retour : '/', { replace: true })
        else setErreurSso('La connexion par le cloud a echoue. Reessayez.')
      })
    }
  }, [connecterAvecJeton, navigate])

  // Deja connecte → retour a la page d'origine ou a l'accueil
  if (isAuthenticated) {
    const from = (location.state as any)?.from?.pathname || '/'
    return <Navigate to={from} replace />
  }

  return <AuthScreen erreurSso={erreurSso} />
}

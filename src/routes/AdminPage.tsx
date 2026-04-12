/**
 * ADMINPAGE.TSX : Page du tableau de bord administrateur
 *
 * Wrapper autour du composant AdminDashboard.
 * Verifie que l'utilisateur est admin, sinon redirige vers l'accueil.
 * Gere la navigation quand l'admin clique sur un projet pour l'ouvrir
 * (redirige vers la bonne route selon le type de projet).
 *
 * Route : /admin
 */

import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/useAuthStore'
import AdminDashboard from '@/components/AdminDashboard'

export default function AdminPage() {
  const { user } = useAuthStore()
  const navigate = useNavigate()

  // Verification du role admin — redirection si non autorise
  if (user?.role !== 'admin') {
    return <Navigate to="/" replace />
  }

  return (
    <AdminDashboard
      onBack={() => navigate('/')}
      onLoadProject={(data: any) => {
        // Redirige vers la bonne route selon le type d'outil du projet
        if (data.data?.toolType === 'transcription' || data.toolType === 'transcription') {
          navigate('/transcription/' + data.id)
        } else if (data.data?.toolType === 'linguistic' || data.toolType === 'linguistic') {
          navigate('/linguistic/' + data.id)
        } else {
          navigate('/project/' + data.id)
        }
      }}
    />
  )
}

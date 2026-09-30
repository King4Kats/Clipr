/**
 * AUDIOPAGE.TSX : Page de l'outil d'extraction audio (video → MP3)
 *
 * Simple enveloppe autour de AudioExtractTool. Contrairement aux autres outils,
 * celui-ci ne cree pas de projet : c'est une conversion ponctuelle, sans
 * historique ni sauvegarde.
 *
 * Route : /audio
 */

import { useNavigate } from 'react-router-dom'
import AudioExtractTool from '@/components/new/AudioExtractTool'

export default function AudioPage() {
  const navigate = useNavigate()
  return <AudioExtractTool onBack={() => navigate('/')} />
}

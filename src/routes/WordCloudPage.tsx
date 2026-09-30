/**
 * WORDCLOUDPAGE.TSX : Page de l'outil Nuage de mots (texte existant → nuage)
 *
 * Simple enveloppe autour de WordCloudTool. Comme l'extraction audio, l'outil
 * ne cree pas de projet : l'analyse est ponctuelle, rien n'est enregistre.
 *
 * Route : /nuage
 */

import { useNavigate } from 'react-router-dom'
import WordCloudTool from '@/components/new/WordCloudTool'

export default function WordCloudPage() {
  const navigate = useNavigate()
  return <WordCloudTool onBack={() => navigate('/')} />
}

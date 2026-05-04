/**
 * ATLASPAGE.TSX : Page de visualisation de l'atlas dialectal moderne
 *
 * Affiche sur carte de France les attestations modernes collectees via l'outil
 * de transcription linguistique, comparees aux attestations historiques de
 * l'ALF (1900) au meme point d'enquete. Permet de mesurer l'evolution
 * dialectale sur 120 ans.
 *
 * Route : /atlas
 */

import AtlasView from '@/components/new/AtlasView'

export default function AtlasPage() {
  return <AtlasView />
}

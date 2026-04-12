/**
 * WORD-FREQUENCY.TS : Utilitaire de calcul de frequence des mots
 *
 * Calcul purement client-side (pas d'appel API, instantane).
 * Analyse les segments transcrits pour compter les mots les plus utilises,
 * avec repartition par locuteur (speaker).
 *
 * Fonctions exportees :
 * - computeWordFrequencies(segments) : calcule les frequences de tous les mots
 * - getWordCloudData(frequencies) : formate les donnees pour le nuage de mots
 * - getSpeakers(segments) : retourne la liste des locuteurs uniques
 */

import type { TranscriptSegment, WordFrequency } from '@/types'

// ── Liste de stop words francais ──
// Mots tres courants qui n'apportent pas de sens semantique.
// On les filtre pour ne garder que les mots significatifs dans le nuage.
const FRENCH_STOP_WORDS = new Set([
  // Articles
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux',
  // Pronoms personnels
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
  'me', 'te', 'se', 'moi', 'toi', 'lui', 'leur', 'eux',
  // Pronoms relatifs et demonstratifs
  'que', 'qui', 'quoi', 'dont', 'ou', 'ce', 'cette', 'ces', 'cet',
  'cela', 'ceci', 'celle', 'celui', 'ceux', 'celles',
  // Possessifs
  'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses',
  'notre', 'votre', 'nos', 'vos', 'leurs',
  // Prepositions
  'de', 'en', 'dans', 'sur', 'sous', 'avec', 'sans', 'pour',
  'par', 'vers', 'chez', 'entre', 'depuis', 'pendant', 'avant',
  'apres', 'contre', 'jusque', 'selon', 'malgre',
  // Conjonctions
  'et', 'ou', 'mais', 'donc', 'car', 'ni', 'puis', 'comme',
  'quand', 'lorsque', 'puisque', 'parce', 'sinon', 'soit',
  // Prepositions avec accents
  'après', 'à', 'dès', 'até',
  // Adverbes tres courants (avec et sans accents)
  'ne', 'pas', 'plus', 'moins', 'tres', 'très', 'bien', 'mal', 'aussi',
  'encore', 'toujours', 'jamais', 'deja', 'déjà', 'ici', 'vraiment',
  'peut', 'tout', 'tous', 'toute', 'toutes', 'rien', 'peu',
  'beaucoup', 'trop', 'assez', 'meme', 'même', 'autre', 'autres',
  'oui', 'non', 'bon', 'bah', 'ben', 'hein', 'euh', 'alors',
  'voila', 'voilà', 'enfin', 'ensuite', 'ainsi', 'surtout', 'plutot', 'plutôt',
  // Mots generiques trop vagues pour etre pertinents
  'petit', 'petite', 'petits', 'petites', 'grand', 'grande', 'grands', 'grandes',
  'ans', 'année', 'années', 'jour', 'jours', 'fois', 'temps', 'moment',
  'chose', 'choses', 'gens', 'homme', 'femme', 'côté', 'cote',
  'coup', 'part', 'reste', 'parti', 'partir', 'arrivé', 'arrivés', 'arriver',
  'mis', 'pris', 'allé', 'allée', 'allés', 'allées', 'venu', 'venue',
  'trouvé', 'trouvée', 'appelé', 'appelait',
  'là', 'ça', 'comme', 'quand', 'comment', 'pourquoi',
  // Verbes auxiliaires et tres courants (formes conjuguees)
  // IMPORTANT : inclure les formes avec ET sans accents car Whisper transcrit avec accents
  'est', 'sont', 'etait', 'etaient', 'ete', 'sera', 'serait',
  'était', 'étaient', 'été', 'être', 'êtes',
  'suis', 'sommes', 'etes', 'fut', 'fus',
  'ai', 'as', 'avons', 'avez', 'ont', 'avait', 'avaient',
  'aura', 'aurait', 'avoir', 'etre',
  'fait', 'faire', 'fais', 'font', 'faisait',
  'dit', 'dire', 'dis', 'disait',
  'peut', 'peux', 'pouvait', 'pouvoir', 'peuvent',
  'veut', 'veux', 'voulait', 'vouloir',
  'doit', 'dois', 'devait', 'devoir',
  'faut', 'fallait',
  'sait', 'sais', 'savait', 'savoir',
  'voit', 'vois', 'voyait', 'voir',
  'va', 'vais', 'allait', 'aller', 'allez', 'allons',
  'vient', 'viens', 'venait', 'venir',
  'met', 'mets', 'mettre', 'mettait',
  'prend', 'prends', 'prendre', 'prenait',
  'donne', 'donner', 'donnait',
  'étais', 'étions', 'étiez',
  // Determinants et mots outils
  'quel', 'quelle', 'quels', 'quelles',
  'chaque', 'quelque', 'quelques', 'certain', 'certains',
  'certaine', 'certaines', 'plusieurs', 'aucun', 'aucune',
  // Nombres ecrits en lettres
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
  // Mots parasites de transcription et hesitations
  'donc', 'quoi', 'enfin', 'etc', 'voila', 'bon',
  'oui', 'non', 'ouais', 'nan', 'hmm', 'mmm', 'hum',
  'allez', 'tiens', 'bon', 'bref', 'genre',
  // Pronoms et adverbes accentues courants
  'où', 'déjà', 'là-bas', 'peut-être',
  'aussi', 'encore', 'dessus', 'dessous', 'dedans', 'dehors',
])

/**
 * Calcule les frequences de chaque mot dans les segments transcrits.
 * Filtre les stop words et les mots trop courts (< 3 caracteres).
 * Compte les occurrences par locuteur et au total.
 *
 * @param segments - Segments de transcription avec texte et speaker optionnel
 * @returns Tableau des frequences triees par total decroissant (top 200)
 */
export function computeWordFrequencies(segments: TranscriptSegment[]): WordFrequency[] {
  // Map : mot → { total: number, speakers: Record<string, number> }
  const wordMap = new Map<string, { total: number; speakers: Record<string, number> }>()

  for (const segment of segments) {
    const speaker = segment.speaker || 'Inconnu'
    // Nettoyage du texte : minuscules, suppression ponctuation, split sur espaces
    const words = segment.text
      .toLowerCase()
      .replace(/[.,!?;:'"«»""''()\-–—…\[\]{}\/\\0-9]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !FRENCH_STOP_WORDS.has(w))

    for (const word of words) {
      const entry = wordMap.get(word)
      if (entry) {
        entry.total++
        entry.speakers[speaker] = (entry.speakers[speaker] || 0) + 1
      } else {
        wordMap.set(word, { total: 1, speakers: { [speaker]: 1 } })
      }
    }
  }

  // Conversion en tableau, tri par frequence decroissante, top 200
  return Array.from(wordMap.entries())
    .map(([word, data]) => ({ word, total: data.total, speakers: data.speakers }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 200)
}

/**
 * Formate les frequences pour le composant de nuage de mots.
 * Retourne les 80 mots les plus frequents (au-dela le nuage est illisible).
 *
 * @param frequencies - Frequences calculees par computeWordFrequencies
 * @returns Tableau { text, value } pour react-wordcloud
 */
export function getWordCloudData(frequencies: WordFrequency[]): { text: string; value: number }[] {
  return frequencies
    .slice(0, 80)
    .map(f => ({ text: f.word, value: f.total }))
}

/**
 * Retourne la liste des locuteurs uniques trouves dans les segments.
 * Utile pour generer les colonnes du tableau de frequences.
 *
 * @param segments - Segments de transcription
 * @returns Tableau de noms de locuteurs uniques
 */
export function getSpeakers(segments: TranscriptSegment[]): string[] {
  const speakers = new Set<string>()
  for (const segment of segments) {
    if (segment.speaker) speakers.add(segment.speaker)
  }
  return Array.from(speakers)
}

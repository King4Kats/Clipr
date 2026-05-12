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
  // Prepositions (formes normalisees sans accents, la normalisation s'en charge)
  'apres', 'des',
  // Adverbes tres courants
  'ne', 'pas', 'plus', 'moins', 'tres', 'bien', 'mal', 'aussi',
  'encore', 'toujours', 'jamais', 'deja', 'ici', 'vraiment',
  'peut', 'tout', 'tous', 'toute', 'toutes', 'rien', 'peu',
  'beaucoup', 'trop', 'assez', 'meme', 'autre', 'autres',
  'oui', 'non', 'bon', 'bah', 'ben', 'hein', 'euh', 'alors',
  'voila', 'enfin', 'ensuite', 'ainsi', 'surtout', 'plutot',
  // Mots generiques trop vagues pour etre pertinents
  'petit', 'petite', 'petits', 'petites', 'grand', 'grande', 'grands', 'grandes',
  'ans', 'annee', 'annees', 'jour', 'jours', 'fois', 'temps', 'moment',
  'chose', 'choses', 'gens', 'homme', 'femme', 'cote',
  'coup', 'part', 'reste', 'parti', 'partir', 'arrive', 'arrives', 'arriver',
  'mis', 'pris', 'alle', 'allee', 'alles', 'allees', 'venu', 'venue',
  'trouve', 'trouvee', 'appele', 'appelait',
  'la', 'ca', 'comme', 'quand', 'comment', 'pourquoi',
  // Verbes auxiliaires et tres courants (formes normalisees sans accents)
  'est', 'sont', 'etait', 'etaient', 'ete', 'sera', 'serait',
  'etre', 'etes', 'etais', 'etions', 'etiez',
  'suis', 'sommes', 'fut', 'fus',
  'ai', 'as', 'avons', 'avez', 'ont', 'avait', 'avaient',
  'aura', 'aurait', 'avoir',
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
  // Pronoms et adverbes (formes normalisees)
  'ou', 'deja', 'la-bas', 'peut-etre',
  'aussi', 'encore', 'dessus', 'dessous', 'dedans', 'dehors',
  // Verbes et conjonctions courts (3 chars) souvent issus de transcriptions
  'qui', 'que', 'qua', 'tel', 'lui', 'eux', 'soi',
  'sur', 'par', 'sou', 'rev', 'pre', 'mes', 'tes', 'ses',
  // Particules
  'oh', 'ah', 'eh', 'ha', 'he', 'ho', 'oye', 'hop',
])

/**
 * Calcule les frequences de chaque mot dans les segments transcrits.
 * Filtre les stop words et les mots trop courts (< 3 caracteres).
 * Compte les occurrences par locuteur et au total.
 *
 * @param segments - Segments de transcription avec texte et speaker optionnel
 * @returns Tableau des frequences triees par total decroissant (top 200)
 */
/**
 * Normalise un mot pour eviter les doublons :
 * - minuscules
 * - ligatures (œ → oe, æ → ae)
 * - accents retires pour la CLE de deduplication
 *   mais on garde la forme originale pour l'affichage
 */
function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    // Retirer les accents pour la cle de deduplication
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/**
 * Prefixes d'elision francais a retirer (l', d', j', n', m', s', t', c', qu', jusqu', lorsqu', puisqu')
 * pour que "j'ai" donne "ai" au lieu de "j" + "ai", et "aujourd'hui" reste un seul mot.
 */
const ELISION_PREFIX_RE = /^(l|d|j|n|m|s|t|c|qu|jusqu|lorsqu|puisqu)['’]/i

/**
 * Decoupe un texte en mots en gardant les apostrophes INTERIEURES intactes
 * (aujourd'hui reste un seul token). Retire ensuite les prefixes d'elision
 * (j', l', d'... → "" ; "j'ai" → "ai" ; "aujourd'hui" → "aujourd'hui").
 */
function tokenize(text: string): string[] {
  // Remplacer apostrophes typographiques par apostrophe simple, virer ponctuation
  // (sauf l'apostrophe et le tiret qui peuvent etre internes a un mot)
  const cleaned = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.,!?;:"«»""()\[\]{}\/\\0-9…–—]/g, ' ')
  return cleaned
    .split(/\s+/)
    .map(w => w.replace(ELISION_PREFIX_RE, '').replace(/^['\-]+|['\-]+$/g, ''))
    .filter(w => w.length >= 3)
}

export function computeWordFrequencies(segments: TranscriptSegment[], options?: { minFreq?: number }): WordFrequency[] {
  const minFreq = options?.minFreq ?? 1
  // Map : cle normalisee → { displayWord, total, speakers }
  const wordMap = new Map<string, { displayWord: string; displayCount: Map<string, number>; total: number; speakers: Record<string, number> }>()

  for (const segment of segments) {
    const speaker = segment.speaker || 'Inconnu'
    const words = tokenize(segment.text)

    for (const word of words) {
      const key = normalizeWord(word)
      // Filtrer les stop words sur la cle normalisee
      if (FRENCH_STOP_WORDS.has(key) || FRENCH_STOP_WORDS.has(word)) continue

      const entry = wordMap.get(key)
      if (entry) {
        entry.total++
        entry.speakers[speaker] = (entry.speakers[speaker] || 0) + 1
        // Compter quelle forme est la plus courante pour l'affichage
        entry.displayCount.set(word, (entry.displayCount.get(word) || 0) + 1)
        // Utiliser la forme la plus frequente
        let maxForm = entry.displayWord, maxCount = 0
        entry.displayCount.forEach((c, w) => { if (c > maxCount) { maxCount = c; maxForm = w } })
        entry.displayWord = maxForm
      } else {
        const dc = new Map<string, number>()
        dc.set(word, 1)
        wordMap.set(key, { displayWord: word, displayCount: dc, total: 1, speakers: { [speaker]: 1 } })
      }
    }
  }

  // Conversion en tableau avec le mot affiche (forme la plus courante)
  // Tri par frequence decroissante, top 200, filtre min freq
  return Array.from(wordMap.entries())
    .map(([_key, data]) => ({ word: data.displayWord, total: data.total, speakers: data.speakers }))
    .filter(f => f.total >= minFreq)
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

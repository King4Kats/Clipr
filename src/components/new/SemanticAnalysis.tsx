/**
 * SEMANTICANALYSIS.TSX : Panneau d'analyse semantique
 *
 * Composant partage entre l'outil de transcription et l'outil de segmentation video.
 * Affiche 3 onglets :
 *   1. Nuage de mots interactif (SVG via d3-cloud)
 *   2. Tableau de frequences par locuteur (triable, filtrable)
 *   3. Analyse semantique par Ollama (themes, sentiment, insights)
 *
 * Le nuage de mots et le tableau sont calcules cote client (instantane).
 * L'analyse semantique est chargee a la demande via l'API Ollama.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Cloud, Table, Brain, Loader2, AlertCircle,
  ArrowUpDown, Search, ChevronUp, ChevronDown,
  Smile, Frown, Meh, TrendingUp
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import api from '@/api'
import type { TranscriptSegment, WordFrequency, SemanticAnalysisResult } from '@/types'
import { computeWordFrequencies, getWordCloudData, getSpeakers } from '@/lib/word-frequency'
// @ts-ignore — d3-cloud n'a pas toujours les types parfaits
import cloud from 'd3-cloud'

// ── Props du composant ──
interface SemanticAnalysisProps {
  /** Segments de transcription a analyser */
  segments: TranscriptSegment[]
  /** Modele Ollama a utiliser pour l'analyse semantique */
  ollamaModel: string
  /** Callback pour fermer le panneau */
  onClose: () => void
}

// ── Couleurs pour les locuteurs (meme palette que les segments video) ──
const SPEAKER_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
]

// ── Types internes pour le nuage de mots ──
interface CloudWord {
  text: string
  size: number
  x: number
  y: number
  rotate: number
  color: string
}

// ============================================================
// COMPOSANT PRINCIPAL
// ============================================================
export default function SemanticAnalysis({ segments, ollamaModel, onClose }: SemanticAnalysisProps) {
  // Onglet actif : nuage, tableau ou analyse IA
  const [tab, setTab] = useState<'cloud' | 'table' | 'analysis'>('cloud')

  // ── Donnees calculees cote client (instantane) ──
  const frequencies = useMemo(() => computeWordFrequencies(segments), [segments])
  const speakers = useMemo(() => getSpeakers(segments), [segments])
  const cloudData = useMemo(() => getWordCloudData(frequencies), [frequencies])

  // ── Analyse semantique (chargee a la demande) ──
  const [semanticResult, setSemanticResult] = useState<SemanticAnalysisResult | null>(null)
  const [semanticLoading, setSemanticLoading] = useState(false)
  const [semanticError, setSemanticError] = useState<string | null>(null)
  const semanticLoaded = useRef(false)

  // Charger l'analyse semantique quand on clique sur l'onglet "analyse"
  useEffect(() => {
    if (tab !== 'analysis' || semanticLoaded.current) return
    semanticLoaded.current = true
    setSemanticLoading(true)
    setSemanticError(null)

    api.semanticAnalyze(segments, ollamaModel)
      .then((data) => {
        setSemanticResult(data.semanticAnalysis)
      })
      .catch((err) => {
        setSemanticError(err.message || 'Erreur lors de l\'analyse')
      })
      .finally(() => setSemanticLoading(false))
  }, [tab, segments, ollamaModel])

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="bg-card border border-border rounded-xl shadow-lg overflow-hidden mt-4"
    >
      {/* En-tete avec onglets et bouton fermer */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-1">
          {/* Onglet Nuage de mots */}
          <button
            onClick={() => setTab('cloud')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              tab === 'cloud' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Cloud className="w-3.5 h-3.5" />
            Nuage de mots
          </button>
          {/* Onglet Tableau */}
          <button
            onClick={() => setTab('table')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              tab === 'table' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Table className="w-3.5 h-3.5" />
            Frequences
          </button>
          {/* Onglet Analyse IA */}
          <button
            onClick={() => setTab('analysis')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              tab === 'analysis' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            Analyse IA
            {semanticLoading && <Loader2 className="w-3 h-3 animate-spin" />}
          </button>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-secondary transition-colors">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Contenu de l'onglet actif */}
      <div className="p-4">
        <AnimatePresence mode="wait">
          {tab === 'cloud' && (
            <motion.div key="cloud" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <WordCloudView data={cloudData} frequencies={frequencies} speakers={speakers} />
            </motion.div>
          )}
          {tab === 'table' && (
            <motion.div key="table" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <FrequencyTable frequencies={frequencies} speakers={speakers} />
            </motion.div>
          )}
          {tab === 'analysis' && (
            <motion.div key="analysis" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <SemanticAnalysisView
                result={semanticResult}
                loading={semanticLoading}
                error={semanticError}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

// ============================================================
// SOUS-COMPOSANT : Nuage de mots (SVG via d3-cloud)
// ============================================================
function WordCloudView({
  data,
  frequencies,
  speakers
}: {
  data: { text: string; value: number }[]
  frequencies: WordFrequency[]
  speakers: string[]
}) {
  const [words, setWords] = useState<CloudWord[]>([])
  const [hoveredWord, setHoveredWord] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Construire une map de couleur par mot (basee sur le speaker dominant)
  const wordColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const freq of frequencies) {
      // Trouver le speaker qui utilise le plus ce mot
      let maxSpeaker = ''
      let maxCount = 0
      for (const [speaker, count] of Object.entries(freq.speakers)) {
        if (count > maxCount) { maxCount = count; maxSpeaker = speaker }
      }
      const speakerIndex = speakers.indexOf(maxSpeaker)
      map.set(freq.word, SPEAKER_COLORS[speakerIndex >= 0 ? speakerIndex % SPEAKER_COLORS.length : 0])
    }
    return map
  }, [frequencies, speakers])

  // Calculer le layout du nuage avec d3-cloud
  useEffect(() => {
    if (data.length === 0) return

    const width = 700
    const height = 400
    const maxVal = Math.max(...data.map(d => d.value))
    const minVal = Math.min(...data.map(d => d.value))

    // Echelle de taille : les mots les plus frequents sont plus grands
    const sizeScale = (val: number) => {
      if (maxVal === minVal) return 24
      return 12 + ((val - minVal) / (maxVal - minVal)) * 48
    }

    const layout = cloud()
      .size([width, height])
      .words(data.map(d => ({ text: d.text, size: sizeScale(d.value), value: d.value })))
      .padding(4)
      .rotate(() => (Math.random() > 0.7 ? 90 : 0))
      .fontSize((d: any) => d.size)
      .on('end', (layoutWords: any[]) => {
        setWords(layoutWords.map(w => ({
          text: w.text!,
          size: w.size!,
          x: w.x!,
          y: w.y!,
          rotate: w.rotate!,
          color: wordColorMap.get(w.text!) || SPEAKER_COLORS[0]
        })))
      })

    layout.start()
  }, [data, wordColorMap])

  // Trouver les details du mot survole
  const hoveredFreq = hoveredWord ? frequencies.find(f => f.word === hoveredWord) : null

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
        Pas assez de donnees pour generer un nuage de mots
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Legende des couleurs par speaker */}
      {speakers.length > 0 && (
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          {speakers.map((speaker, i) => (
            <div key={speaker} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SPEAKER_COLORS[i % SPEAKER_COLORS.length] }} />
              {speaker}
            </div>
          ))}
        </div>
      )}

      {/* SVG du nuage de mots */}
      <svg
        viewBox="-350 -200 700 400"
        className="w-full h-[400px] bg-background/50 rounded-lg border border-border"
      >
        {words.map((word, i) => (
          <text
            key={`${word.text}-${i}`}
            textAnchor="middle"
            transform={`translate(${word.x},${word.y}) rotate(${word.rotate})`}
            fontSize={word.size}
            fill={word.color}
            opacity={hoveredWord && hoveredWord !== word.text ? 0.3 : 1}
            className="cursor-pointer transition-opacity duration-150 select-none"
            style={{ fontWeight: word.size > 30 ? 700 : 500 }}
            onMouseEnter={() => setHoveredWord(word.text)}
            onMouseLeave={() => setHoveredWord(null)}
          >
            {word.text}
          </text>
        ))}
      </svg>

      {/* Tooltip au survol */}
      {hoveredFreq && (
        <div className="absolute top-2 right-2 bg-card border border-border rounded-lg p-3 shadow-lg text-xs max-w-[200px]">
          <div className="font-bold text-foreground text-sm mb-1">"{hoveredFreq.word}"</div>
          <div className="text-muted-foreground mb-2">Total : {hoveredFreq.total} occurrences</div>
          {Object.entries(hoveredFreq.speakers).map(([speaker, count]) => (
            <div key={speaker} className="flex justify-between text-[10px]">
              <span className="text-muted-foreground">{speaker}</span>
              <span className="font-mono font-bold text-foreground">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// SOUS-COMPOSANT : Tableau de frequences
// ============================================================
function FrequencyTable({
  frequencies,
  speakers
}: {
  frequencies: WordFrequency[]
  speakers: string[]
}) {
  const [searchFilter, setSearchFilter] = useState('')
  const [sortColumn, setSortColumn] = useState<'word' | 'total' | string>('total')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Filtrage par recherche
  const filtered = useMemo(() => {
    if (!searchFilter) return frequencies
    const q = searchFilter.toLowerCase()
    return frequencies.filter(f => f.word.includes(q))
  }, [frequencies, searchFilter])

  // Tri par colonne
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let valA: number | string, valB: number | string
      if (sortColumn === 'word') {
        valA = a.word; valB = b.word
      } else if (sortColumn === 'total') {
        valA = a.total; valB = b.total
      } else {
        // Colonne speaker
        valA = a.speakers[sortColumn] || 0
        valB = b.speakers[sortColumn] || 0
      }
      if (valA < valB) return sortDir === 'asc' ? -1 : 1
      if (valA > valB) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [filtered, sortColumn, sortDir])

  // Gestion du clic sur un en-tete de colonne pour trier
  const handleSort = (col: string) => {
    if (sortColumn === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(col)
      setSortDir('desc')
    }
  }

  const SortIcon = ({ col }: { col: string }) => {
    if (sortColumn !== col) return <ArrowUpDown className="w-3 h-3 opacity-30" />
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
  }

  return (
    <div>
      {/* Barre de recherche */}
      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="Rechercher un mot..."
          value={searchFilter}
          onChange={e => setSearchFilter(e.target.value)}
          className="w-full pl-8 pr-3 py-2 text-xs bg-secondary/50 border border-border rounded-lg outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Tableau */}
      <div className="max-h-[400px] overflow-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-secondary/50 sticky top-0">
            <tr>
              <th
                className="text-left px-3 py-2 font-semibold text-muted-foreground cursor-pointer hover:text-foreground"
                onClick={() => handleSort('word')}
              >
                <span className="flex items-center gap-1">Mot <SortIcon col="word" /></span>
              </th>
              <th
                className="text-right px-3 py-2 font-semibold text-muted-foreground cursor-pointer hover:text-foreground"
                onClick={() => handleSort('total')}
              >
                <span className="flex items-center justify-end gap-1">Total <SortIcon col="total" /></span>
              </th>
              {speakers.map(speaker => (
                <th
                  key={speaker}
                  className="text-right px-3 py-2 font-semibold text-muted-foreground cursor-pointer hover:text-foreground"
                  onClick={() => handleSort(speaker)}
                >
                  <span className="flex items-center justify-end gap-1 truncate max-w-[100px]">
                    {speaker} <SortIcon col={speaker} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((freq, i) => (
              <tr
                key={freq.word}
                className={`border-t border-border/50 hover:bg-secondary/30 transition-colors ${
                  i % 2 === 0 ? '' : 'bg-secondary/10'
                }`}
              >
                <td className="px-3 py-1.5 font-medium text-foreground">{freq.word}</td>
                <td className="px-3 py-1.5 text-right font-mono font-bold text-primary">{freq.total}</td>
                {speakers.map(speaker => (
                  <td key={speaker} className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                    {freq.speakers[speaker] || 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-xs">Aucun mot trouve</div>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground mt-2">
        {sorted.length} mots affiches sur {frequencies.length} total
      </div>
    </div>
  )
}

// ============================================================
// SOUS-COMPOSANT : Analyse semantique (Ollama)
// ============================================================
function SemanticAnalysisView({
  result,
  loading,
  error
}: {
  result: SemanticAnalysisResult | null
  loading: boolean
  error: string | null
}) {
  // Chargement en cours
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
        <p className="text-sm text-muted-foreground">Analyse semantique en cours...</p>
        <p className="text-[10px] text-muted-foreground">Le LLM analyse le contenu de la transcription</p>
      </div>
    )
  }

  // Erreur
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <AlertCircle className="w-8 h-8 text-destructive" />
        <p className="text-sm text-destructive font-medium">Erreur d'analyse</p>
        <p className="text-xs text-muted-foreground text-center max-w-md">{error}</p>
      </div>
    )
  }

  // Pas encore de resultat
  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <Brain className="w-8 h-8" />
        <p className="text-sm">Cliquez pour lancer l'analyse semantique</p>
      </div>
    )
  }

  // Icone du sentiment
  const SentimentIcon = () => {
    switch (result.sentiment.label) {
      case 'positif': return <Smile className="w-5 h-5 text-green-400" />
      case 'negatif': return <Frown className="w-5 h-5 text-red-400" />
      case 'mixte': return <TrendingUp className="w-5 h-5 text-amber-400" />
      default: return <Meh className="w-5 h-5 text-zinc-400" />
    }
  }

  // Couleur du badge sentiment
  const sentimentColor = {
    positif: 'bg-green-500/10 text-green-400 border-green-500/20',
    negatif: 'bg-red-500/10 text-red-400 border-red-500/20',
    mixte: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    neutre: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  }[result.sentiment.label] || 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'

  return (
    <div className="space-y-6">
      {/* Themes identifies */}
      <div>
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <Cloud className="w-3.5 h-3.5 text-primary" />
          Themes identifies
        </h3>
        <div className="flex flex-wrap gap-2">
          {result.themes.map((theme, i) => (
            <span
              key={i}
              className="px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 rounded-full text-[11px] font-medium"
            >
              {theme}
            </span>
          ))}
        </div>
      </div>

      {/* Sentiment general */}
      <div>
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <SentimentIcon />
          Sentiment general
        </h3>
        <div className="flex items-start gap-3">
          <span className={`px-3 py-1 rounded-full text-xs font-bold border capitalize ${sentimentColor}`}>
            {result.sentiment.label}
          </span>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {result.sentiment.explanation}
          </p>
        </div>
      </div>

      {/* Points cles */}
      <div>
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5 text-primary" />
          Points cles
        </h3>
        <ul className="space-y-2">
          {result.insights.map((insight, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
              <span className="text-primary font-bold mt-0.5 shrink-0">{i + 1}.</span>
              <span className="leading-relaxed">{insight}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

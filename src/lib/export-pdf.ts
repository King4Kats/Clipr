/**
 * EXPORT-PDF.TS : Generation d'un rapport PDF professionnel
 *
 * Genere un PDF avec un template soigne contenant :
 * - Page de garde avec titre du projet et metadonnees
 * - Analyse IA (themes, sentiment, points cles)
 * - Tableau des frequences de mots par locuteur
 * - Transcription complete avec speakers et timestamps
 *
 * Utilise jsPDF pour la generation et le rendu direct (pas de html2canvas).
 * Tout le rendu est fait par programmation pour un controle total du layout.
 */

import { jsPDF } from 'jspdf'
import type { TranscriptSegment, WordFrequency } from '@/types'

// ── Couleurs du template ──
const COLORS = {
  primary: [0, 200, 200] as [number, number, number],    // Cyan Clipr
  dark: [20, 30, 40] as [number, number, number],         // Fond sombre
  text: [220, 230, 240] as [number, number, number],      // Texte clair
  muted: [130, 140, 150] as [number, number, number],     // Texte secondaire
  card: [30, 42, 55] as [number, number, number],         // Fond carte
  white: [255, 255, 255] as [number, number, number],
  green: [16, 185, 129] as [number, number, number],
  amber: [245, 158, 11] as [number, number, number],
  red: [239, 68, 68] as [number, number, number],
}

interface ExportOptions {
  /** Titre du projet */
  title: string
  /** Nom du fichier source */
  filename?: string
  /** Segments de transcription */
  segments: TranscriptSegment[]
  /** Frequences de mots */
  frequencies: WordFrequency[]
  /** Noms des locuteurs */
  speakers: string[]
  /** Resultat de l'analyse IA (optionnel) */
  semanticResult?: {
    themes: string[]
    sentiment: { label: string; explanation: string }
    insights: string[]
  } | null
  /** Date de creation */
  date?: string
}

/**
 * Genere et telecharge un rapport PDF complet.
 * Le PDF est genere en memoire puis telecharge automatiquement.
 */
export async function exportAnalysisPDF(options: ExportOptions): Promise<void> {
  const { title, filename, segments, frequencies, speakers, semanticResult, date } = options

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 15
  const contentW = pageW - margin * 2
  let y = 0

  // ── Utilitaires ──
  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2])
  const setFillColor = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2])

  const addPage = () => {
    doc.addPage()
    y = margin
    // Fond sombre sur chaque page
    setFillColor(COLORS.dark)
    doc.rect(0, 0, pageW, pageH, 'F')
  }

  const checkPageBreak = (needed: number) => {
    if (y + needed > pageH - margin) addPage()
  }

  // ── Page de garde ──
  setFillColor(COLORS.dark)
  doc.rect(0, 0, pageW, pageH, 'F')

  // Barre decorative en haut
  setFillColor(COLORS.primary)
  doc.rect(0, 0, pageW, 3, 'F')

  // Logo/Titre
  y = 60
  doc.setFontSize(32)
  setColor(COLORS.primary)
  doc.text('CLIPR', pageW / 2, y, { align: 'center' })

  y += 15
  doc.setFontSize(10)
  setColor(COLORS.muted)
  doc.text('Rapport d\'analyse', pageW / 2, y, { align: 'center' })

  // Titre du projet
  y += 30
  doc.setFontSize(20)
  setColor(COLORS.white)
  const titleLines = doc.splitTextToSize(title, contentW)
  doc.text(titleLines, pageW / 2, y, { align: 'center' })
  y += titleLines.length * 8

  // Metadonnees
  y += 15
  doc.setFontSize(10)
  setColor(COLORS.muted)
  if (filename) doc.text(`Fichier : ${filename}`, pageW / 2, y, { align: 'center' })
  y += 6
  doc.text(`Date : ${date || new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`, pageW / 2, y, { align: 'center' })
  y += 6
  doc.text(`${segments.length} segments • ${speakers.length} locuteur${speakers.length > 1 ? 's' : ''} • ${frequencies.length} mots analyses`, pageW / 2, y, { align: 'center' })

  if (speakers.length > 0) {
    y += 6
    doc.text(`Locuteurs : ${speakers.join(', ')}`, pageW / 2, y, { align: 'center' })
  }

  // ── Page 2 : Analyse IA ──
  if (semanticResult) {
    addPage()

    // Titre section
    doc.setFontSize(16)
    setColor(COLORS.primary)
    doc.text('Analyse semantique', margin, y)
    y += 10

    // Themes
    doc.setFontSize(11)
    setColor(COLORS.white)
    doc.text('Themes identifies', margin, y)
    y += 6
    doc.setFontSize(9)
    setColor(COLORS.text)
    for (const theme of semanticResult.themes) {
      checkPageBreak(6)
      doc.text(`•  ${theme}`, margin + 4, y)
      y += 5
    }

    // Sentiment
    y += 8
    doc.setFontSize(11)
    setColor(COLORS.white)
    doc.text('Sentiment general', margin, y)
    y += 6
    doc.setFontSize(9)

    const sentimentColors: Record<string, [number, number, number]> = {
      positif: COLORS.green, negatif: COLORS.red, mixte: COLORS.amber, neutre: COLORS.muted
    }
    setColor(sentimentColors[semanticResult.sentiment.label] || COLORS.muted)
    doc.text(semanticResult.sentiment.label.toUpperCase(), margin + 4, y)
    y += 5
    setColor(COLORS.text)
    const sentimentLines = doc.splitTextToSize(semanticResult.sentiment.explanation, contentW - 8)
    doc.text(sentimentLines, margin + 4, y)
    y += sentimentLines.length * 4 + 2

    // Points cles
    y += 8
    doc.setFontSize(11)
    setColor(COLORS.white)
    doc.text('Points cles', margin, y)
    y += 6
    doc.setFontSize(9)
    setColor(COLORS.text)
    semanticResult.insights.forEach((insight, i) => {
      checkPageBreak(8)
      const lines = doc.splitTextToSize(`${i + 1}. ${insight}`, contentW - 8)
      doc.text(lines, margin + 4, y)
      y += lines.length * 4 + 2
    })
  }

  // ── Page : Tableau des frequences ──
  addPage()
  doc.setFontSize(16)
  setColor(COLORS.primary)
  doc.text('Frequences des mots', margin, y)
  y += 8

  // En-tete du tableau
  doc.setFontSize(8)
  setColor(COLORS.muted)
  const colMot = margin
  const colTotal = margin + 50
  const colSpeakerStart = margin + 70
  const speakerColW = speakers.length > 0 ? Math.min(30, (contentW - 70) / speakers.length) : 0

  setFillColor(COLORS.card)
  doc.rect(margin, y - 3, contentW, 6, 'F')
  doc.text('Mot', colMot, y)
  doc.text('Total', colTotal, y)
  speakers.forEach((s, i) => {
    doc.text(s.substring(0, 12), colSpeakerStart + i * speakerColW, y)
  })
  y += 5

  // Lignes du tableau (top 50 mots)
  doc.setFontSize(8)
  const topFreqs = frequencies.slice(0, 50)
  for (const freq of topFreqs) {
    checkPageBreak(5)

    setColor(COLORS.text)
    doc.text(freq.word, colMot, y)
    setColor(COLORS.primary)
    doc.text(String(freq.total), colTotal, y)
    setColor(COLORS.muted)
    speakers.forEach((s, i) => {
      doc.text(String(freq.speakers[s] || 0), colSpeakerStart + i * speakerColW, y)
    })

    // Ligne separatrice legere
    doc.setDrawColor(40, 50, 60)
    doc.line(margin, y + 1.5, margin + contentW, y + 1.5)
    y += 4.5
  }

  if (frequencies.length > 50) {
    y += 3
    setColor(COLORS.muted)
    doc.setFontSize(7)
    doc.text(`... et ${frequencies.length - 50} mots supplementaires`, margin, y)
  }

  // ── Pages : Transcription complete ──
  addPage()
  doc.setFontSize(16)
  setColor(COLORS.primary)
  doc.text('Transcription', margin, y)
  y += 10

  let lastSpeaker = ''
  doc.setFontSize(8)

  for (const seg of segments) {
    // Nouveau locuteur
    if (seg.speaker && seg.speaker !== lastSpeaker) {
      checkPageBreak(10)
      y += 3
      doc.setFontSize(9)
      setColor(COLORS.primary)
      doc.text(seg.speaker.toUpperCase(), margin, y)
      y += 5
      doc.setFontSize(8)
      lastSpeaker = seg.speaker
    }

    checkPageBreak(6)

    // Timestamp
    const m = Math.floor(seg.start / 60)
    const s = Math.floor(seg.start % 60)
    const ts = `${m}:${String(s).padStart(2, '0')}`

    setColor(COLORS.muted)
    doc.text(ts, margin, y)
    setColor(COLORS.text)
    const textLines = doc.splitTextToSize(seg.text, contentW - 20)
    doc.text(textLines, margin + 18, y)
    y += textLines.length * 3.5 + 1.5
  }

  // ── Pied de page sur toutes les pages ──
  const totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setFontSize(7)
    setColor(COLORS.muted)
    doc.text(`Clipr — ${title}`, margin, pageH - 8)
    doc.text(`Page ${i}/${totalPages}`, pageW - margin, pageH - 8, { align: 'right' })
    // Ligne separatrice en bas
    doc.setDrawColor(40, 50, 60)
    doc.line(margin, pageH - 12, pageW - margin, pageH - 12)
  }

  // ── Telechargement ──
  const safeName = (title || 'rapport').replace(/[^a-zA-Z0-9àâäéèêëïîôùûüç_-]/g, '_').substring(0, 50)
  doc.save(`${safeName}_analyse.pdf`)
}

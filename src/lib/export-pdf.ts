/**
 * EXPORT-PDF.TS : Generation d'un rapport PDF professionnel
 *
 * Template epure, fond blanc, pensé pour l'impression.
 * Contient :
 * - Page de garde minimaliste
 * - Nuage de mots (capture SVG → image)
 * - Analyse IA (themes, sentiment, points cles)
 * - Tableau des frequences top 50
 * - Transcription en paragraphes regroupes par locuteur
 */

import { jsPDF } from 'jspdf'
import type { TranscriptSegment, WordFrequency } from '@/types'

// ── Couleurs du template (epure, imprimable) ──
const C = {
  black: [30, 30, 30] as [number, number, number],
  text: [50, 50, 50] as [number, number, number],
  muted: [140, 140, 140] as [number, number, number],
  primary: [0, 160, 160] as [number, number, number],
  accent: [0, 120, 120] as [number, number, number],
  light: [245, 245, 245] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
  green: [22, 163, 74] as [number, number, number],
  amber: [217, 119, 6] as [number, number, number],
  red: [220, 38, 38] as [number, number, number],
  line: [220, 220, 220] as [number, number, number],
}

interface ExportOptions {
  title: string
  filename?: string
  segments: TranscriptSegment[]
  frequencies: WordFrequency[]
  speakers: string[]
  semanticResult?: {
    themes: string[]
    sentiment: { label: string; explanation: string }
    insights: string[]
  } | null
  date?: string
  /** Element SVG du nuage de mots a capturer (optionnel) */
  wordCloudSvg?: SVGElement | null
}

/**
 * Capture un element SVG et le convertit en data URL PNG.
 * Utilise un canvas temporaire pour le rendu.
 */
async function svgToImage(svgEl: SVGElement, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const clone = svgEl.cloneNode(true) as SVGElement
    // Forcer un fond blanc sur le SVG clone
    clone.setAttribute('style', 'background: white')
    // Changer les couleurs des textes en noir/gris fonce pour l'impression
    clone.querySelectorAll('text').forEach(t => {
      const currentFill = t.getAttribute('fill') || ''
      // Garder les couleurs des speakers mais les assombrir pour l'impression
      if (currentFill.startsWith('#')) {
        // Assombrir legerement
        t.setAttribute('fill', currentFill)
      } else {
        t.setAttribute('fill', '#333333')
      }
    })

    const svgData = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width * 2 // retina
      canvas.height = height * 2
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = url
  })
}

/**
 * Genere et telecharge le rapport PDF.
 */
export async function exportAnalysisPDF(options: ExportOptions): Promise<void> {
  const { title, filename, segments, frequencies, speakers, semanticResult, wordCloudSvg } = options

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()   // 210
  const H = doc.internal.pageSize.getHeight()  // 297
  const M = 20 // marge
  const CW = W - M * 2 // largeur contenu
  let y = 0

  const color = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2])
  const fill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2])
  const line = () => { doc.setDrawColor(220, 220, 220); doc.line(M, y, W - M, y); y += 3 }

  const newPage = () => { doc.addPage(); y = M + 5 }
  const needSpace = (n: number) => { if (y + n > H - 20) newPage() }

  // ════════════════════════════════════════════
  // PAGE DE GARDE
  // ════════════════════════════════════════════
  // Barre accent en haut
  fill(C.primary)
  doc.rect(0, 0, W, 2, 'F')

  // Marque
  y = 50
  doc.setFontSize(12)
  color(C.primary)
  doc.text('CLIPR', W / 2, y, { align: 'center' })

  // Trait fin
  y += 5
  doc.setDrawColor(C.primary[0], C.primary[1], C.primary[2])
  doc.setLineWidth(0.3)
  doc.line(W / 2 - 15, y, W / 2 + 15, y)

  // Titre
  y += 15
  doc.setFontSize(24)
  color(C.black)
  const titleLines = doc.splitTextToSize(title, CW)
  doc.text(titleLines, W / 2, y, { align: 'center' })
  y += titleLines.length * 10

  // Sous-titre
  y += 5
  doc.setFontSize(11)
  color(C.muted)
  doc.text('Rapport d\'analyse', W / 2, y, { align: 'center' })

  // Metadonnees
  y += 20
  doc.setFontSize(9)
  color(C.text)
  const dateStr = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
  const meta = [
    filename ? `Fichier : ${filename}` : null,
    `Date : ${dateStr}`,
    `${segments.length} segments transcrits`,
    speakers.length > 0 ? `Locuteurs : ${speakers.join(', ')}` : null,
  ].filter(Boolean)
  meta.forEach(m => {
    doc.text(m!, W / 2, y, { align: 'center' })
    y += 5
  })

  // ════════════════════════════════════════════
  // PAGE 2 : NUAGE DE MOTS + ANALYSE IA
  // ════════════════════════════════════════════
  newPage()

  // ── Nuage de mots (capture SVG) ──
  if (wordCloudSvg) {
    try {
      doc.setFontSize(13)
      color(C.black)
      doc.text('Nuage de mots', M, y)
      y += 2
      doc.setFontSize(8)
      color(C.muted)
      doc.text('Les mots les plus frequents, dimensionnes par nombre d\'occurrences', M, y + 3)
      y += 8

      const imgData = await svgToImage(wordCloudSvg, 700, 350)
      const imgW = CW
      const imgH = CW * 0.5
      doc.addImage(imgData, 'PNG', M, y, imgW, imgH)
      y += imgH + 8

      line()
    } catch (err) {
      console.warn('Capture nuage de mots echouee:', err)
    }
  }

  // ── Analyse IA ──
  if (semanticResult) {
    needSpace(40)
    doc.setFontSize(13)
    color(C.black)
    doc.text('Analyse semantique', M, y)
    y += 8

    // Themes
    doc.setFontSize(9)
    color(C.muted)
    doc.text('THEMES IDENTIFIES', M, y)
    y += 5
    doc.setFontSize(9)
    color(C.text)
    // Afficher les themes en ligne avec separateur
    const themesText = semanticResult.themes.join('  ·  ')
    const themesLines = doc.splitTextToSize(themesText, CW)
    doc.text(themesLines, M, y)
    y += themesLines.length * 4 + 5

    // Sentiment
    needSpace(15)
    doc.setFontSize(9)
    color(C.muted)
    doc.text('SENTIMENT GENERAL', M, y)
    y += 5
    const sentColors: Record<string, [number, number, number]> = {
      positif: C.green, negatif: C.red, mixte: C.amber, neutre: C.muted
    }
    color(sentColors[semanticResult.sentiment.label] || C.muted)
    doc.setFontSize(10)
    doc.text(semanticResult.sentiment.label.charAt(0).toUpperCase() + semanticResult.sentiment.label.slice(1), M, y)
    y += 5
    color(C.text)
    doc.setFontSize(9)
    const sentLines = doc.splitTextToSize(semanticResult.sentiment.explanation, CW)
    doc.text(sentLines, M, y)
    y += sentLines.length * 4 + 5

    // Points cles
    needSpace(15)
    doc.setFontSize(9)
    color(C.muted)
    doc.text('POINTS CLES', M, y)
    y += 5
    doc.setFontSize(9)
    color(C.text)
    semanticResult.insights.forEach((ins, i) => {
      needSpace(8)
      const insLines = doc.splitTextToSize(`${i + 1}.  ${ins}`, CW - 5)
      doc.text(insLines, M + 2, y)
      y += insLines.length * 4 + 2
    })

    y += 5
    line()
  }

  // ════════════════════════════════════════════
  // TABLEAU DES FREQUENCES
  // ════════════════════════════════════════════
  needSpace(30)
  doc.setFontSize(13)
  color(C.black)
  doc.text('Frequences des mots', M, y)
  y += 3
  doc.setFontSize(8)
  color(C.muted)
  doc.text('Top 50 des mots les plus utilises, repartis par locuteur', M, y)
  y += 7

  // En-tete
  fill(C.light)
  doc.rect(M, y - 3.5, CW, 5.5, 'F')
  doc.setFontSize(7)
  color(C.muted)
  doc.text('Mot', M + 2, y)
  doc.text('Total', M + 45, y)
  speakers.forEach((s, i) => {
    const x = M + 60 + i * Math.min(28, (CW - 60) / speakers.length)
    doc.text(s.substring(0, 14), x, y)
  })
  y += 4

  // Lignes
  const top = frequencies.slice(0, 50)
  doc.setFontSize(8)
  top.forEach((f, i) => {
    needSpace(5)
    // Fond alterne
    if (i % 2 === 0) {
      fill(C.light)
      doc.rect(M, y - 3, CW, 4.5, 'F')
    }
    color(C.text)
    doc.text(f.word, M + 2, y)
    color(C.primary)
    doc.text(String(f.total), M + 45, y)
    color(C.muted)
    speakers.forEach((s, si) => {
      const x = M + 60 + si * Math.min(28, (CW - 60) / speakers.length)
      doc.text(String(f.speakers[s] || 0), x, y)
    })
    y += 4.5
  })

  if (frequencies.length > 50) {
    y += 2
    doc.setFontSize(7)
    color(C.muted)
    doc.text(`+ ${frequencies.length - 50} mots supplementaires`, M + 2, y)
  }

  // ════════════════════════════════════════════
  // TRANSCRIPTION (en paragraphes par locuteur)
  // ════════════════════════════════════════════
  newPage()
  doc.setFontSize(13)
  color(C.black)
  doc.text('Transcription', M, y)
  y += 3
  doc.setFontSize(8)
  color(C.muted)
  doc.text(`${segments.length} segments, ${speakers.length} locuteur${speakers.length > 1 ? 's' : ''}`, M, y)
  y += 8

  // Regrouper les segments consecutifs du meme locuteur en paragraphes
  let currentSpeaker = ''
  let paragraphText = ''
  let paragraphStart = 0

  const flushParagraph = () => {
    if (!paragraphText) return
    needSpace(15)

    // Nom du locuteur + timestamp
    doc.setFontSize(9)
    color(C.primary)
    const speakerLabel = currentSpeaker || 'Locuteur'
    const m = Math.floor(paragraphStart / 60)
    const s = Math.floor(paragraphStart % 60)
    const ts = `${m}:${String(s).padStart(2, '0')}`
    doc.text(`${speakerLabel}`, M, y)
    color(C.muted)
    doc.setFontSize(7)
    doc.text(`  ${ts}`, M + doc.getTextWidth(speakerLabel) + 1, y)
    y += 4

    // Texte du paragraphe
    doc.setFontSize(9)
    color(C.text)
    const paraLines = doc.splitTextToSize(paragraphText.trim(), CW - 4)
    paraLines.forEach((pLine: string) => {
      needSpace(4)
      doc.text(pLine, M + 2, y)
      y += 3.8
    })
    y += 3
    paragraphText = ''
  }

  for (const seg of segments) {
    const speaker = seg.speaker || ''
    if (speaker !== currentSpeaker && paragraphText) {
      flushParagraph()
    }
    if (speaker !== currentSpeaker) {
      currentSpeaker = speaker
      paragraphStart = seg.start
    }
    paragraphText += seg.text + ' '
  }
  flushParagraph() // dernier paragraphe

  // ════════════════════════════════════════════
  // PIEDS DE PAGE
  // ════════════════════════════════════════════
  const totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setFontSize(7)
    color(C.muted)
    doc.setDrawColor(220, 220, 220)
    doc.line(M, H - 15, W - M, H - 15)
    doc.text(`Clipr — ${title}`, M, H - 10)
    doc.text(`${i} / ${totalPages}`, W - M, H - 10, { align: 'right' })
  }

  // ── Telecharger ──
  const safeName = (title || 'rapport').replace(/[^a-zA-Z0-9àâäéèêëïîôùûüç_\- ]/g, '_').substring(0, 50).trim()
  doc.save(`${safeName}_analyse.pdf`)
}

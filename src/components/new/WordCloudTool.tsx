/**
 * WORDCLOUDTOOL.TSX : Outil "Nuage de mots" a partir d'un texte existant
 *
 * Permet d'analyser un texte qui n'a pas besoin de passer par Whisper :
 *   - un texte colle directement (ex. une transcription copiee, une colonne Excel)
 *   - un ou plusieurs fichiers texte (.txt / .docx / .pdf) → un groupe par fichier
 *   - un tableau (.xlsx / .csv), typiquement les reponses a un questionnaire :
 *     l'utilisateur coche les colonnes (questions) a analyser, un groupe par colonne
 *
 * Chaque groupe est traite comme un "locuteur" : on reutilise tel quel le panneau
 * SemanticAnalysis (nuage, frequences par groupe, analyse IA). Les pastilles en
 * haut du resultat permettent d'afficher un nuage par colonne / fichier, ou tous
 * ensemble (les mots sont alors colores selon le groupe qui les emploie le plus).
 *
 * Comme l'extraction audio, l'outil est ponctuel : rien n'est enregistre.
 */

import { useState, useMemo, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft, Cloud, Upload, Loader2, AlertCircle, FileSpreadsheet,
  ClipboardPaste, RotateCcw, Columns3, CheckSquare, Square
} from 'lucide-react'
import api from '@/api'
import { Button } from '@/components/ui/button'
import SemanticAnalysis from '@/components/new/SemanticAnalysis'
import type { TranscriptSegment } from '@/types'

const TEXT_EXTS = ['txt', 'docx', 'pdf']
const TABLE_EXTS = ['xlsx', 'csv', 'xls', 'ods']
const OLLAMA_MODEL = 'mistral-nemo:12b'

/** Un groupe de textes = une colonne du tableau, un fichier, ou le texte colle. */
interface Group {
  name: string
  entries: string[]
}

type Sheet = { name: string; headers: string[]; rows: string[][] }

/** Extension en minuscules, sans le point. */
function extOf(name: string): string {
  return (name.split('.').pop() || '').toLowerCase()
}

/**
 * Decoupe un texte en entrees : une par ligne non vide. Colle depuis Excel,
 * une ligne = une reponse ; pour un texte suivi, une ligne = un paragraphe.
 */
function splitEntries(text: string): string[] {
  return text.split(/\r?\n+/).map(l => l.trim()).filter(l => l.length > 0)
}

/**
 * Nom court et unique pour un groupe : les intitules de questions peuvent etre
 * tres longs et apparaissent dans la legende et les colonnes du tableau.
 */
function uniqueLabel(name: string, taken: Set<string>): string {
  let label = name.length > 60 ? name.slice(0, 57).trimEnd() + '…' : name
  let n = 2
  const base = label
  while (taken.has(label)) label = `${base} (${n++})`
  taken.add(label)
  return label
}

/** Statistiques d'une colonne pour aider a choisir : remplissage, exemple, texte libre ? */
function columnStats(sheet: Sheet, col: number) {
  const values = sheet.rows.map(r => r[col] || '').filter(v => v.trim() !== '')
  const avgLen = values.length ? values.reduce((s, v) => s + v.length, 0) / values.length : 0
  const numeric = values.filter(v => /^[\d\s.,:/\-+%€]+$/.test(v)).length
  const distinct = new Set(values.map(v => v.toLowerCase())).size
  // Texte libre = reponses assez longues, pas des nombres/dates, pas un choix
  // parmi quelques options (Oui/Non, tranches d'age...)
  const isFreeText = values.length > 0
    && avgLen >= 15
    && numeric < values.length * 0.5
    && !(values.length >= 10 && distinct <= 8)
  const sample = values.find(v => v.length >= 15) || values[0] || ''
  return { filled: values.length, sample, isFreeText }
}

export default function WordCloudTool({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<'source' | 'columns' | 'result'>('source')
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Tableau charge (etape de choix des colonnes)
  const [table, setTable] = useState<{ filename: string; sheets: Sheet[] } | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [selectedCols, setSelectedCols] = useState<Set<number>>(new Set())

  // Resultat : groupes a analyser + groupe affiche ('all' = tous ensemble)
  const [groups, setGroups] = useState<Group[]>([])
  const [sourceName, setSourceName] = useState('')
  const [active, setActive] = useState<string>('all')

  const sheet = table?.sheets[sheetIndex] ?? null
  const stats = useMemo(
    () => (sheet ? sheet.headers.map((_, i) => columnStats(sheet, i)) : []),
    [sheet]
  )

  /** Affiche le resultat pour une liste de groupes. */
  const showResult = useCallback((newGroups: Group[], name: string) => {
    const nonEmpty = newGroups.filter(g => g.entries.length > 0)
    if (nonEmpty.length === 0) {
      setError('Aucun texte a analyser')
      return
    }
    setGroups(nonEmpty)
    setSourceName(name)
    // Un seul groupe : pas de pastille « Toutes », on l'affiche directement
    setActive(nonEmpty.length > 1 ? 'all' : nonEmpty[0].name)
    setStep('result')
  }, [])

  /** Selectionne une feuille et pre-coche ses colonnes de texte libre. */
  const selectSheet = useCallback((t: { sheets: Sheet[] }, index: number) => {
    const s = t.sheets[index]
    setSheetIndex(index)
    setSelectedCols(new Set(
      s.headers.map((_, i) => i).filter(i => columnStats(s, i).isFreeText)
    ))
  }, [])

  /** Traite les fichiers choisis : un tableau, ou un ou plusieurs textes. */
  const handleFiles = useCallback(async (files: File[]) => {
    setError(null)
    if (files.length === 0) return
    const tables = files.filter(f => TABLE_EXTS.includes(extOf(f.name)))
    const texts = files.filter(f => TEXT_EXTS.includes(extOf(f.name)))
    const ignored = files.length - tables.length - texts.length

    setBusy(true)
    try {
      if (tables.length > 0) {
        // Un tableau a la fois : le choix des colonnes est propre a chaque fichier
        const t = await api.textParseTable(tables[0])
        setTable(t)
        selectSheet(t, 0)
        setStep('columns')
        if (tables.length > 1 || texts.length > 0) {
          setError(`Seul « ${tables[0].name} » a ete charge : un tableau a la fois.`)
        }
        return
      }
      if (texts.length === 0) {
        throw new Error('Format non supporte. Accepte : .txt, .docx, .pdf, .xlsx, .csv')
      }
      // Fichiers texte : extraction cote serveur, un groupe par fichier
      const taken = new Set<string>()
      const newGroups: Group[] = []
      for (const f of texts) {
        const { text } = await api.assistantExtractFile(f)
        newGroups.push({ name: uniqueLabel(f.name.replace(/\.[^.]+$/, ''), taken), entries: splitEntries(text) })
      }
      showResult(newGroups, texts.length === 1 ? texts[0].name : `${texts.length} fichiers`)
      if (ignored > 0) setError(`${ignored} fichier(s) ignore(s) : format non supporte.`)
    } catch (e: any) {
      setError(e.message || 'Echec de la lecture du fichier')
    } finally {
      setBusy(false)
    }
  }, [selectSheet, showResult])

  /** Construit un groupe par colonne cochee. */
  const buildFromColumns = () => {
    if (!sheet || !table) return
    const taken = new Set<string>()
    const cols = Array.from(selectedCols).sort((a, b) => a - b)
    showResult(
      cols.map(c => ({
        name: uniqueLabel(sheet.headers[c], taken),
        entries: sheet.rows.map(r => (r[c] || '').trim()).filter(v => v !== ''),
      })),
      table.sheets.length > 1 ? `${table.filename} — ${sheet.name}` : table.filename
    )
  }

  const toggleCol = (i: number) => {
    setSelectedCols(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const reset = () => {
    setStep('source')
    setTable(null)
    setGroups([])
    setError(null)
  }

  // Segments passes au panneau d'analyse : le groupe devient le "locuteur"
  const segments = useMemo<TranscriptSegment[]>(() => {
    const shown = active === 'all' ? groups : groups.filter(g => g.name === active)
    return shown.flatMap(g => g.entries.map((text, i) => ({
      id: `${g.name}-${i}`, start: 0, end: 0, text, speaker: g.name,
    })))
  }, [groups, active])

  const exportName = `nuage-${(active === 'all' ? sourceName : active)}`
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />
          Retour
        </Button>
      </div>

      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400">
          <Cloud className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-foreground">Nuage de mots</h1>
          <p className="text-xs text-muted-foreground">
            Analyser un texte existant : transcription, document ou reponses a un questionnaire
          </p>
        </div>
        {step !== 'source' && (
          <Button variant="outline" size="sm" onClick={reset} className="gap-1.5">
            <RotateCcw className="w-3.5 h-3.5" />
            Nouvelle analyse
          </Button>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Etape 1 : source du texte ── */}
      {step === 'source' && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Coller un texte */}
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <ClipboardPaste className="w-4 h-4 text-rose-400" />
              <h2 className="text-sm font-semibold text-foreground">Coller un texte</h2>
            </div>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Collez ici une transcription, un article, ou une colonne de reponses copiee depuis Excel (une reponse par ligne)..."
              className="flex-1 min-h-[220px] w-full resize-y rounded-lg border border-border bg-background p-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-rose-500/40"
            />
            <Button
              className="mt-3"
              disabled={pasted.trim().length < 10}
              onClick={() => { setError(null); showResult([{ name: 'Texte', entries: splitEntries(pasted) }], 'texte-colle') }}
            >
              <Cloud className="w-4 h-4 mr-1.5" />
              Generer le nuage
            </Button>
          </div>

          {/* Charger un fichier */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setIsDragging(false)
              if (!busy) handleFiles(Array.from(e.dataTransfer.files))
            }}
            onClick={() => { if (!busy) fileInputRef.current?.click() }}
            className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center transition-colors ${
              busy ? 'opacity-60 cursor-wait border-border' : 'cursor-pointer'
            } ${isDragging ? 'border-rose-500 bg-rose-500/5' : 'border-border hover:border-rose-500/50'}`}
          >
            {busy
              ? <Loader2 className="w-8 h-8 text-muted-foreground mb-3 animate-spin" />
              : <Upload className="w-8 h-8 text-muted-foreground mb-3" />}
            <p className="text-sm font-medium text-foreground">
              {busy ? 'Lecture du fichier...' : 'Glissez un fichier ici, ou cliquez pour le choisir'}
            </p>
            <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
              <strong>Tableau</strong> (.xlsx, .csv) : reponses a un questionnaire,<br />
              vous choisirez ensuite les colonnes a analyser<br />
              <strong>Texte</strong> (.txt, .docx, .pdf) : un ou plusieurs fichiers,<br />
              un nuage par fichier
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={[...TEXT_EXTS, ...TABLE_EXTS].map(e => '.' + e).join(',')}
              className="hidden"
              onChange={(e) => {
                handleFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
          </motion.div>
        </div>
      )}

      {/* ── Etape 2 : choix des colonnes du tableau ── */}
      {step === 'columns' && table && sheet && (
        <div className="mt-6 bg-card border border-border rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <FileSpreadsheet className="w-4 h-4 text-rose-400" />
            <h2 className="text-sm font-semibold text-foreground">{table.filename}</h2>
            <span className="text-[11px] text-muted-foreground">
              {sheet.rows.length} ligne(s), {sheet.headers.length} colonne(s)
            </span>
            {table.sheets.length > 1 && (
              <select
                value={sheetIndex}
                onChange={(e) => selectSheet(table, Number(e.target.value))}
                className="ml-auto text-xs rounded-md border border-border bg-background px-2 py-1"
              >
                {table.sheets.map((s, i) => <option key={i} value={i}>Feuille : {s.name}</option>)}
              </select>
            )}
          </div>

          <p className="text-xs text-muted-foreground mb-3">
            Cochez les colonnes a analyser. Les questions a reponse libre sont pre-cochees ;
            chaque colonne aura son propre nuage.
          </p>

          <div className="flex gap-2 mb-2">
            <button className="text-[11px] text-primary hover:underline" onClick={() => setSelectedCols(new Set(sheet.headers.map((_, i) => i)))}>
              Tout cocher
            </button>
            <button className="text-[11px] text-primary hover:underline" onClick={() => setSelectedCols(new Set())}>
              Tout decocher
            </button>
          </div>

          <div className="max-h-[420px] overflow-y-auto divide-y divide-border border border-border rounded-lg">
            {sheet.headers.map((h, i) => {
              const st = stats[i]
              const checked = selectedCols.has(i)
              return (
                <button
                  key={i}
                  onClick={() => toggleCol(i)}
                  disabled={st.filled === 0}
                  className={`w-full flex items-start gap-3 p-3 text-left transition-colors disabled:opacity-40 ${
                    checked ? 'bg-rose-500/5' : 'hover:bg-secondary/50'
                  }`}
                >
                  {checked
                    ? <CheckSquare className="w-4 h-4 text-rose-400 shrink-0 mt-px" />
                    : <Square className="w-4 h-4 text-muted-foreground shrink-0 mt-px" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-foreground">{h}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {st.filled} reponse(s){st.isFreeText ? ' · texte libre' : ''}
                    </div>
                    {st.sample && (
                      <div className="text-[10px] text-muted-foreground/80 italic mt-0.5 truncate">
                        ex. « {st.sample} »
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          <div className="flex justify-end mt-4">
            <Button disabled={selectedCols.size === 0} onClick={buildFromColumns}>
              <Cloud className="w-4 h-4 mr-1.5" />
              Generer {selectedCols.size > 1 ? `les nuages (${selectedCols.size} colonnes)` : 'le nuage'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Etape 3 : resultat ── */}
      {step === 'result' && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">{sourceName}</span>
            {table && (
              <Button variant="ghost" size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setStep('columns')}>
                <Columns3 className="w-3.5 h-3.5" />
                Changer les colonnes
              </Button>
            )}
          </div>

          {/* Pastilles : un nuage par colonne / fichier, ou tous ensemble */}
          {groups.length > 1 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {[{ name: 'all', label: 'Toutes', count: groups.reduce((s, g) => s + g.entries.length, 0) },
                ...groups.map(g => ({ name: g.name, label: g.name, count: g.entries.length }))].map(p => (
                <button
                  key={p.name}
                  onClick={() => setActive(p.name)}
                  title={p.label}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors max-w-[320px] truncate ${
                    active === p.name
                      ? 'border-rose-500 bg-rose-500/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-rose-500/40'
                  }`}
                >
                  {p.label} <span className="opacity-60">({p.count})</span>
                </button>
              ))}
            </div>
          )}

          {/* key : on repart de zero a chaque changement de groupe (analyse IA comprise) */}
          <SemanticAnalysis
            key={active}
            segments={segments}
            ollamaModel={OLLAMA_MODEL}
            exportFilename={exportName || 'nuage-de-mots'}
          />
        </div>
      )}
    </main>
  )
}

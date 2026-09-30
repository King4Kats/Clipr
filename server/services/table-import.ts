/**
 * TABLE-IMPORT.TS — Lecture de tableaux (.xlsx / .csv) pour l'outil Nuage de mots.
 *
 * Cas d'usage typique : l'export des reponses d'un questionnaire (Google Forms,
 * LimeSurvey, Framaforms, Excel...). Une ligne = un repondant, une colonne = une
 * question. On renvoie le tableau brut au client, qui laisse l'utilisateur
 * choisir les colonnes a analyser. Rien n'est stocke sur le serveur.
 */

import { extname } from 'path'

/** Une feuille lue : en-tetes (1re ligne non vide) + lignes de reponses. */
export interface ParsedSheet {
  name: string
  headers: string[]
  rows: string[][]
}

// Garde-fous : au-dela, le navigateur ramerait et le nuage n'a plus de sens
const MAX_ROWS = 50000
const MAX_COLS = 300

/**
 * Lit un fichier tableau et renvoie ses feuilles (une seule pour un CSV).
 * Les feuilles vides sont ignorees.
 */
export async function parseTable(buffer: Buffer, filename: string): Promise<ParsedSheet[]> {
  const ext = extname(filename).toLowerCase()
  let grids: Array<{ name: string; cells: string[][] }>

  if (ext === '.csv') {
    grids = [{ name: filename.replace(/\.[^.]+$/, ''), cells: parseCsv(decodeText(buffer)) }]
  } else if (ext === '.xlsx') {
    grids = await readXlsx(buffer)
  } else if (ext === '.xls' || ext === '.ods') {
    throw new Error(`Format ${ext} non lu : enregistrez le fichier en .xlsx ou .csv depuis Excel / LibreOffice`)
  } else {
    throw new Error(`Format non supporte : ${ext} (xlsx ou csv)`)
  }

  const sheets: ParsedSheet[] = []
  for (const g of grids) {
    const sheet = toSheet(g.name, g.cells)
    if (sheet) sheets.push(sheet)
  }
  if (sheets.length === 0) throw new Error('Aucune donnee trouvee dans le fichier')
  return sheets
}

/**
 * Transforme une grille brute en feuille : la 1re ligne non vide sert d'en-tete,
 * les lignes entierement vides sont retirees, toutes les lignes sont completees
 * a la meme largeur. Renvoie null si la feuille est vide.
 */
function toSheet(name: string, cells: string[][]): ParsedSheet | null {
  const nonEmpty = cells.filter(r => r.some(c => c.trim() !== ''))
  if (nonEmpty.length === 0) return null

  const width = Math.min(MAX_COLS, Math.max(...nonEmpty.map(r => r.length)))
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim())

  const headerRow = pad(nonEmpty[0])
  // En-tete manquant → nom generique « Colonne N » pour pouvoir quand meme la choisir
  const headers = headerRow.map((h, i) => h || `Colonne ${i + 1}`)
  const rows = nonEmpty.slice(1, MAX_ROWS + 1).map(pad)
  return { name, headers, rows }
}

/** Lit toutes les feuilles d'un classeur Excel via exceljs. */
async function readXlsx(buffer: Buffer): Promise<Array<{ name: string; cells: string[][] }>> {
  // Import dynamique : exceljs n'est charge que si quelqu'un importe un tableau
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)

  const result: Array<{ name: string; cells: string[][] }> = []
  wb.eachSheet((ws) => {
    const cells: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const line: string[] = []
      // cell.text = valeur telle qu'affichee dans Excel (dates, formules, texte riche)
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col <= MAX_COLS) line[col - 1] = safeCellText(cell)
      })
      cells.push(line)
    })
    result.push({ name: ws.name, cells })
  })
  return result
}

/** Texte d'une cellule, sans planter sur les cas tordus (erreurs de formule...). */
function safeCellText(cell: any): string {
  try {
    return String(cell.text ?? '')
  } catch {
    return ''
  }
}

/**
 * Decode un CSV : UTF-8 si le fichier est valide en UTF-8, sinon Windows-1252
 * (le « CSV (separateur : point-virgule) » d'Excel francais est souvent dans ce
 * format, les accents seraient casses en lisant en UTF-8).
 */
function decodeText(buffer: Buffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    text = new TextDecoder('windows-1252').decode(buffer)
  }
  // Retire le BOM eventuel
  return text.replace(/^﻿/, '')
}

/**
 * Parse un CSV (RFC 4180 : champs entre guillemets, "" pour un guillemet,
 * retours a la ligne autorises dans un champ entre guillemets).
 * Le separateur est devine sur la 1re ligne : ; , ou tabulation.
 */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0]
  const candidates = [';', ',', '\t']
  const sep = candidates
    .map(c => ({ c, n: firstLine.split(c).length }))
    .sort((a, b) => b.n - a.n)[0].c

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } // guillemet echappe
        else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === sep) {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
      if (rows.length > MAX_ROWS) break
    } else {
      field += ch
    }
  }
  // Derniere ligne sans saut de ligne final
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

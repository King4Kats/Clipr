/**
 * =============================================================================
 * Fichier : alf-lookup.ts
 * Rôle    : Service de consultation de la base ALF locale (data/alf.db).
 *
 *           Permet de retrouver les attestations historiques de l'ALF
 *           (Atlas Linguistique de la France, 1902-1910) pour un mot
 *           français donné, filtré par point d'enquête / département.
 *
 *           La base est alimentée par `scripts/alf-scrape.py` qui aspire
 *           SYMILA Toulouse. Lecture seule depuis le serveur Node.
 *
 *           Stack : better-sqlite3 (synchrone, ultra-rapide pour read-heavy).
 * =============================================================================
 */

import { join } from 'path'
import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import { logger } from '../logger.js'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const ALF_DB_PATH = join(DATA_DIR, 'alf.db')

// ── Types publics ──
export interface AlfPoint {
  id: number
  num_alf: number
  commune: string
  dept_code: string
  dept_nom: string
  lat: number | null
  lng: number | null
  langue: string
  dialecte: string
  ipa_local: string
}

export interface AlfCarte {
  id: number
  num_alf: number
  titre: string
  is_partial: boolean
}

export interface AlfAttestation {
  realisation_id: number
  point: AlfPoint
  ipa: string
  phrase_fr: string         // phrase source en français
  num_phrase: number
  proprietes: string
  validee: boolean
  cartes: AlfCarte[]        // cartes liées à cette réalisation
}

// ── Init DB (lazy, singleton) ──
let _db: Database.Database | null = null

/**
 * Renvoie la connexion SQLite à `alf.db`. Crée la connexion la 1ère fois.
 * Renvoie null si le fichier n'existe pas (scrape pas encore effectué).
 */
function getDb(): Database.Database | null {
  if (_db) return _db
  if (!existsSync(ALF_DB_PATH)) {
    logger.warn(`[ALF] Base introuvable : ${ALF_DB_PATH}. Lance scripts/alf-scrape.py d'abord.`)
    return null
  }
  _db = new Database(ALF_DB_PATH, { readonly: true, fileMustExist: true })
  _db.pragma('journal_mode = WAL')
  logger.info(`[ALF] Base chargée : ${ALF_DB_PATH}`)
  return _db
}

/**
 * Indique si la base ALF est disponible (scrape effectué).
 */
export function isAlfAvailable(): boolean {
  return getDb() !== null
}

/**
 * Renvoie la liste complète des 639 points d'enquête.
 * Utilisé pour l'autocomplete commune côté UI.
 */
export function listAllPoints(): AlfPoint[] {
  const db = getDb()
  if (!db) return []
  return db.prepare(`
    SELECT id, num_alf, commune, dept_code, dept_nom, lat, lng, langue, dialecte, ipa_local
    FROM alf_points
    WHERE commune IS NOT NULL AND commune != ''
    ORDER BY commune
  `).all() as AlfPoint[]
}

/**
 * Recherche un point par nom de commune (LIKE %nom%).
 * Limité à 20 résultats pour autocomplete UI.
 */
export function searchPoints(query: string): AlfPoint[] {
  const db = getDb()
  if (!db) return []
  const q = `%${query.toLowerCase()}%`
  return db.prepare(`
    SELECT id, num_alf, commune, dept_code, dept_nom, lat, lng, langue, dialecte, ipa_local
    FROM alf_points
    WHERE LOWER(commune) LIKE ? OR LOWER(dept_nom) LIKE ?
    ORDER BY commune
    LIMIT 20
  `).all(q, q) as AlfPoint[]
}

/**
 * Renvoie un point par son ID interne.
 */
export function getPointById(id: number): AlfPoint | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(`
    SELECT id, num_alf, commune, dept_code, dept_nom, lat, lng, langue, dialecte, ipa_local
    FROM alf_points WHERE id = ?
  `).get(id) as AlfPoint | undefined
  return row || null
}

/**
 * Trouve les 5 points ALF les plus proches (Haversine) d'une coordonnée donnée.
 * Permet de proposer un point automatique quand l'utilisateur saisit une commune
 * dont les coordonnées sont connues mais sans correspondance exacte ALF.
 */
export function findNearestPoints(lat: number, lng: number, limit: number = 5): AlfPoint[] {
  const db = getDb()
  if (!db) return []
  // SQLite ne fait pas de Haversine natif → calcul approximatif via différence
  // de carrés (suffisant pour un tri sur quelques degrés). Pas besoin de précision
  // exacte ici, on veut juste les plus proches en ordre relatif.
  const rows = db.prepare(`
    SELECT id, num_alf, commune, dept_code, dept_nom, lat, lng, langue, dialecte, ipa_local,
           ((lat - ?) * (lat - ?) + (lng - ?) * (lng - ?)) AS dist_sq
    FROM alf_points
    WHERE lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY dist_sq ASC
    LIMIT ?
  `).all(lat, lat, lng, lng, limit) as (AlfPoint & { dist_sq: number })[]
  return rows.map(({ dist_sq, ...rest }) => rest)
}

/**
 * Cherche des cartes ALF dont le titre contient le mot français donné.
 * Match approximatif (LIKE). Utilisé pour détecter si un mot transcrit
 * par Whisper est un concept ALF connu.
 *
 * Exemples : "vache" → carte 36 "La vache", "chasseur" → carte 134 "Le chasseur"
 */
export function findCartesByMot(mot: string): AlfCarte[] {
  const db = getDb()
  if (!db) return []
  const q = `%${mot.toLowerCase()}%`
  return db.prepare(`
    SELECT id, num_alf, titre, is_partial
    FROM alf_cartes
    WHERE LOWER(titre) LIKE ?
    ORDER BY num_alf
    LIMIT 10
  `).all(q) as AlfCarte[]
}

/**
 * Récupère toutes les attestations IPA d'une carte (concept) ALF, par point.
 * Optionnellement filtré par département ou région dialectale.
 *
 * @param carteId ID interne SYMILA de la carte
 * @param opts.deptCode si défini, filtre sur le département
 * @param opts.langue si défini, filtre sur la langue (oïl, oc, fpr)
 */
export function getAttestationsByCarte(
  carteId: number,
  opts: { deptCode?: string; langue?: string } = {}
): AlfAttestation[] {
  const db = getDb()
  if (!db) return []

  // Pour chaque réalisation liée à cette carte, on remonte phrase + point + cartes
  const conditions: string[] = ['rc.carte_id = ?']
  const params: (string | number)[] = [carteId]

  if (opts.deptCode) {
    conditions.push('p.dept_code = ?')
    params.push(opts.deptCode)
  }
  if (opts.langue) {
    conditions.push('p.langue = ?')
    params.push(opts.langue)
  }

  const rows = db.prepare(`
    SELECT
      r.id AS realisation_id,
      r.ipa,
      r.proprietes,
      r.validee,
      ph.num_phrase,
      ph.texte_fr AS phrase_fr,
      p.id AS p_id,
      p.num_alf AS p_num_alf,
      p.commune AS p_commune,
      p.dept_code AS p_dept_code,
      p.dept_nom AS p_dept_nom,
      p.lat AS p_lat,
      p.lng AS p_lng,
      p.langue AS p_langue,
      p.dialecte AS p_dialecte,
      p.ipa_local AS p_ipa_local
    FROM alf_realisation_cartes rc
    JOIN alf_realisations r ON r.id = rc.realisation_id
    LEFT JOIN alf_phrases_sources ph ON ph.id = r.phrase_source_id
    JOIN alf_points p ON p.id = r.point_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.num_alf
  `).all(...params) as any[]

  // Regroupe les cartes liées à chaque réalisation
  const cartesByReal = db.prepare(`
    SELECT rc.realisation_id, c.id, c.num_alf, c.titre, c.is_partial
    FROM alf_realisation_cartes rc
    JOIN alf_cartes c ON c.id = rc.carte_id
    WHERE rc.realisation_id IN (${rows.map(() => '?').join(',') || 'NULL'})
  `).all(...rows.map(r => r.realisation_id)) as any[]

  const cartesMap = new Map<number, AlfCarte[]>()
  for (const c of cartesByReal) {
    const arr = cartesMap.get(c.realisation_id) || []
    arr.push({ id: c.id, num_alf: c.num_alf, titre: c.titre, is_partial: !!c.is_partial })
    cartesMap.set(c.realisation_id, arr)
  }

  return rows.map(r => ({
    realisation_id: r.realisation_id,
    ipa: r.ipa || '',
    phrase_fr: r.phrase_fr || '',
    num_phrase: r.num_phrase || 0,
    proprietes: r.proprietes || '',
    validee: !!r.validee,
    cartes: cartesMap.get(r.realisation_id) || [],
    point: {
      id: r.p_id,
      num_alf: r.p_num_alf,
      commune: r.p_commune,
      dept_code: r.p_dept_code,
      dept_nom: r.p_dept_nom,
      lat: r.p_lat,
      lng: r.p_lng,
      langue: r.p_langue,
      dialecte: r.p_dialecte,
      ipa_local: r.p_ipa_local
    }
  }))
}

/**
 * Récupère les attestations pour un mot français donné, à un point ALF donné.
 * Combine `findCartesByMot` + `getAttestationsByCarte`.
 *
 * @param mot mot français recherché (ex: "vache")
 * @param pointId optionnel : si défini, ne renvoie que les attestations de ce point
 */
export function lookupMot(
  mot: string,
  pointId?: number
): { carte: AlfCarte; attestations: AlfAttestation[] }[] {
  const cartes = findCartesByMot(mot)
  const result: { carte: AlfCarte; attestations: AlfAttestation[] }[] = []

  for (const carte of cartes) {
    let atts = getAttestationsByCarte(carte.id)
    if (pointId !== undefined) {
      atts = atts.filter(a => a.point.id === pointId)
    }
    result.push({ carte, attestations: atts })
  }

  return result
}

/**
 * Statistiques rapides sur la base ALF (pour debug / dashboard).
 */
export function getAlfStats(): {
  available: boolean
  points: number
  cartes: number
  phrases: number
  realisations: number
} {
  const db = getDb()
  if (!db) {
    return { available: false, points: 0, cartes: 0, phrases: 0, realisations: 0 }
  }
  const get = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  return {
    available: true,
    points: get('SELECT COUNT(*) AS c FROM alf_points'),
    cartes: get('SELECT COUNT(*) AS c FROM alf_cartes'),
    phrases: get('SELECT COUNT(*) AS c FROM alf_phrases_sources'),
    realisations: get('SELECT COUNT(*) AS c FROM alf_realisations')
  }
}

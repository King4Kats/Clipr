/**
 * =============================================================================
 * Fichier : atlas-moderne.ts
 * Rôle    : Gestion de l'atlas dialectal moderne — table `modern_attestations`.
 *
 *           Chaque variante de locuteur validee par l'utilisateur dans l'outil
 *           linguistique est ajoutee a la table `modern_attestations`. Cela
 *           constitue un atlas vivant, en double notation IPA + ALF Rousselot,
 *           geolocalise via le point d'enquete saisi a l'analyse.
 *
 *           A terme, on pourra comparer ces attestations modernes aux
 *           attestations historiques ALF (1900) du meme point pour mesurer
 *           l'evolution dialectale sur 120 ans.
 * =============================================================================
 */

import { getDb } from './database.js'
import * as alfLookup from './alf-lookup.js'

export interface ModernAttestation {
  id: number
  linguistic_id: string
  sequence_idx: number
  variant_idx: number
  point_alf_id: number | null
  speaker: string
  french_text: string
  ipa: string
  rousselot: string
  carte_alf_id: number | null
  audio_extract: string | null
  validated_by_user: number
  created_at: string
}

/**
 * Enregistre une variante (locuteur) comme attestation moderne validee.
 * Idempotent : si la variante existe deja (meme linguistic_id + idx),
 * on met a jour les champs phonetiques.
 *
 * @param linguisticId ID de la transcription linguistique source
 * @param sequenceIdx index de la sequence dans la transcription
 * @param variantIdx index de la variante (locuteur) dans la sequence
 * @param data champs a inserer
 */
export function upsertAttestation(
  linguisticId: string,
  sequenceIdx: number,
  variantIdx: number,
  data: {
    pointAlfId?: number | null
    speaker: string
    frenchText: string
    ipa: string
    rousselot: string
    carteAlfId?: number | null
    audioExtract?: string | null
  }
): { id: number } {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO modern_attestations
      (linguistic_id, sequence_idx, variant_idx, point_alf_id, speaker,
       french_text, ipa, rousselot, carte_alf_id, audio_extract, validated_by_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(linguistic_id, sequence_idx, variant_idx) DO UPDATE SET
      point_alf_id = excluded.point_alf_id,
      speaker = excluded.speaker,
      french_text = excluded.french_text,
      ipa = excluded.ipa,
      rousselot = excluded.rousselot,
      carte_alf_id = excluded.carte_alf_id,
      audio_extract = excluded.audio_extract,
      validated_by_user = 1
  `).run(
    linguisticId, sequenceIdx, variantIdx,
    data.pointAlfId ?? null, data.speaker,
    data.frenchText, data.ipa, data.rousselot,
    data.carteAlfId ?? null, data.audioExtract ?? null
  )
  // Recupere l'ID (en cas d'INSERT, lastInsertRowid ; en cas d'UPDATE on retrouve via la cle unique)
  const id = (result.lastInsertRowid as number) || (db.prepare(
    'SELECT id FROM modern_attestations WHERE linguistic_id = ? AND sequence_idx = ? AND variant_idx = ?'
  ).get(linguisticId, sequenceIdx, variantIdx) as { id: number }).id
  return { id }
}

/**
 * Valide une transcription linguistique entiere : ajoute toutes ses sequences
 * et variantes a l'atlas moderne. Si un mot francais correspond a un concept
 * ALF connu (titre de carte), on lie automatiquement `carte_alf_id`.
 *
 * Optimisation : bulk insert dans une transaction unique.
 */
export function validateLinguisticTranscription(linguisticId: string): { count: number } {
  const db = getDb()
  const row = db.prepare(`
    SELECT sequences, alf_point_id FROM linguistic_transcriptions WHERE id = ?
  `).get(linguisticId) as { sequences: string; alf_point_id: number | null } | undefined
  if (!row) throw new Error(`Transcription introuvable : ${linguisticId}`)

  const sequences = JSON.parse(row.sequences) as Array<{
    french_text: string
    variants: Array<{
      speaker: string
      ipa: string
      rousselot?: string
      audio_extract?: string
    }>
  }>
  const pointAlfId = row.alf_point_id

  // Pre-calcul : pour chaque sequence, on cherche les concepts ALF correspondants
  // (match approximatif sur le titre de carte vs phrase FR).
  const carteByPhrase = new Map<number, number | null>()
  if (alfLookup.isAlfAvailable()) {
    for (let si = 0; si < sequences.length; si++) {
      const phrase = sequences[si].french_text || ''
      // On extrait les "mots significatifs" (>3 caracteres) et on cherche un match
      const motsCles = phrase.split(/[\s,;:.!?'"-]+/).filter(m => m.length > 3)
      let bestMatch: number | null = null
      for (const mot of motsCles) {
        const cartes = alfLookup.findCartesByMot(mot)
        if (cartes.length > 0) { bestMatch = cartes[0].id; break }
      }
      carteByPhrase.set(si, bestMatch)
    }
  }

  const insert = db.prepare(`
    INSERT INTO modern_attestations
      (linguistic_id, sequence_idx, variant_idx, point_alf_id, speaker,
       french_text, ipa, rousselot, carte_alf_id, audio_extract, validated_by_user)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(linguistic_id, sequence_idx, variant_idx) DO UPDATE SET
      point_alf_id = excluded.point_alf_id,
      ipa = excluded.ipa,
      rousselot = excluded.rousselot,
      carte_alf_id = excluded.carte_alf_id,
      validated_by_user = 1
  `)

  let count = 0
  const txn = db.transaction(() => {
    for (let si = 0; si < sequences.length; si++) {
      const seq = sequences[si]
      const carteId = carteByPhrase.get(si) ?? null
      for (let vi = 0; vi < seq.variants.length; vi++) {
        const v = seq.variants[vi]
        insert.run(
          linguisticId, si, vi, pointAlfId, v.speaker,
          seq.french_text || '', v.ipa || '', v.rousselot || '',
          carteId, v.audio_extract || null
        )
        count++
      }
    }
  })
  txn()

  return { count }
}

/**
 * Liste toutes les attestations modernes, optionnellement filtrees.
 * Pour la vue carte/atlas (frontend).
 */
export function listAttestations(opts: {
  pointAlfId?: number
  carteAlfId?: number
  limit?: number
} = {}): ModernAttestation[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []
  if (opts.pointAlfId !== undefined) {
    conditions.push('point_alf_id = ?'); params.push(opts.pointAlfId)
  }
  if (opts.carteAlfId !== undefined) {
    conditions.push('carte_alf_id = ?'); params.push(opts.carteAlfId)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ?? 1000
  return db.prepare(`
    SELECT * FROM modern_attestations
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as ModernAttestation[]
}

/**
 * Statistiques de l'atlas moderne (pour dashboard / vue atlas).
 */
export function getAtlasStats(): {
  total: number
  pointsCount: number      // nb de points distincts
  conceptsCount: number    // nb de concepts ALF distincts couverts
  recordings: number       // nb de transcriptions linguistiques sources
} {
  const db = getDb()
  const total = (db.prepare('SELECT COUNT(*) AS c FROM modern_attestations').get() as { c: number }).c
  const pointsCount = (db.prepare(
    'SELECT COUNT(DISTINCT point_alf_id) AS c FROM modern_attestations WHERE point_alf_id IS NOT NULL'
  ).get() as { c: number }).c
  const conceptsCount = (db.prepare(
    'SELECT COUNT(DISTINCT carte_alf_id) AS c FROM modern_attestations WHERE carte_alf_id IS NOT NULL'
  ).get() as { c: number }).c
  const recordings = (db.prepare(
    'SELECT COUNT(DISTINCT linguistic_id) AS c FROM modern_attestations'
  ).get() as { c: number }).c
  return { total, pointsCount, conceptsCount, recordings }
}

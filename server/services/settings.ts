/**
 * SETTINGS.TS — Stockage de configuration clé/valeur en base de données.
 *
 * Permet à l'admin de modifier dynamiquement certains paramètres (sans redémarrer
 * le serveur), comme l'ouverture des inscriptions.
 */

import { getDb } from './database.js'

export function getSetting(key: string, defaultValue: string = ''): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
  return row ? row.value : defaultValue
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value)
}

/** Helper booléen : '1' → true, sinon false */
export function getBool(key: string, defaultValue: boolean = false): boolean {
  const v = getSetting(key, defaultValue ? '1' : '0')
  return v === '1' || v === 'true'
}

export function setBool(key: string, value: boolean): void {
  setSetting(key, value ? '1' : '0')
}

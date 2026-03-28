import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { logger } from '../logger.js'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = join(DATA_DIR, 'clipr.db')

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initSchema()
    logger.info(`SQLite database initialized at ${DB_PATH}`)
  }
  return db
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Projet Sans Nom',
      type TEXT NOT NULL DEFAULT 'manual' CHECK(type IN ('manual', 'ai')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'processing', 'done')),
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
  `)
}

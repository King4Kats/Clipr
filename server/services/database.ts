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
    db.pragma('encoding = "UTF-8"')
    initSchema()
    logger.info(`SQLite database initialized at ${DB_PATH}`)
  }
  return db
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL DEFAULT 'Projet Sans Nom',
      type TEXT NOT NULL DEFAULT 'manual' CHECK(type IN ('manual', 'ai')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'processing', 'done')),
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS ai_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS project_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer', 'editor')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(project_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_shares_project ON project_shares(project_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON project_shares(user_id);

    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('analysis', 'transcription')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      project_id TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      progress_message TEXT,
      position INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_task_queue_user ON task_queue(user_id);

    CREATE TABLE IF NOT EXISTS transcriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'fr',
      whisper_model TEXT NOT NULL DEFAULT 'large-v3',
      segments TEXT NOT NULL DEFAULT '[]',
      duration REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES task_queue(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transcriptions_user ON transcriptions(user_id);
  `)

  // Migration: add user_id column if missing (for existing DBs)
  try {
    db.prepare('SELECT user_id FROM projects LIMIT 1').get()
  } catch {
    db.exec('ALTER TABLE projects ADD COLUMN user_id TEXT REFERENCES users(id)')
    logger.info('Migration: added user_id column to projects')
  }
}

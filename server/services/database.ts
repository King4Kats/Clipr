/**
 * =============================================================================
 * Fichier : services/database.ts
 * Rôle    : Initialise et gère la connexion à la base de données SQLite.
 *           SQLite est une base de données légère stockée dans un seul fichier
 *           sur le disque (ici : data/clipr.db). Pas besoin d'installer un
 *           serveur de base de données séparé comme PostgreSQL ou MySQL.
 *
 *           Ce fichier s'occupe de :
 *           1. Créer le fichier de base de données s'il n'existe pas
 *           2. Définir le schéma (les tables et index)
 *           3. Exécuter les migrations (mises à jour du schéma pour les BDD existantes)
 *
 *           On utilise le patron "singleton" : une seule connexion à la BDD
 *           est créée et réutilisée partout dans l'application.
 * =============================================================================
 */

// 'better-sqlite3' est une bibliothèque performante pour utiliser SQLite en Node.js.
// Contrairement à d'autres, elle est synchrone, ce qui simplifie le code.
import Database from 'better-sqlite3'

// 'join' construit des chemins de fichiers de manière portable (Linux/Mac/Windows)
import { join } from 'path'

// 'existsSync' vérifie si un fichier/dossier existe, 'mkdirSync' en crée un
import { existsSync, mkdirSync } from 'fs'

// Notre système de log pour tracer les événements liés à la BDD
import { logger } from '../logger.js'

/**
 * Répertoire où sont stockées les données de l'application.
 * Utilise la variable d'environnement DATA_DIR si définie, sinon le dossier 'data/'
 * dans le répertoire courant du projet.
 */
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')

// On crée le dossier de données s'il n'existe pas encore
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

/** Chemin complet vers le fichier de base de données SQLite */
const DB_PATH = join(DATA_DIR, 'clipr.db')

/**
 * Variable qui stocke l'instance unique de la connexion à la BDD.
 * Elle est initialisée à la première utilisation (lazy initialization).
 */
let db: Database.Database

/**
 * Retourne l'instance de la base de données, en la créant si nécessaire.
 * C'est la seule façon d'accéder à la BDD dans toute l'application.
 *
 * A la première utilisation :
 * - Ouvre (ou crée) le fichier SQLite
 * - Configure les pragmas (options de performance et de sécurité)
 * - Crée toutes les tables si elles n'existent pas
 *
 * @returns L'instance de la base de données prête à l'emploi
 */
export function getDb(): Database.Database {
  if (!db) {
    // Ouverture de la connexion à la base de données
    db = new Database(DB_PATH)

    // --- Configuration des pragmas SQLite ---

    // WAL (Write-Ahead Logging) améliore les performances en permettant
    // des lectures simultanées pendant les écritures
    db.pragma('journal_mode = WAL')

    // Active la vérification des clés étrangères (par défaut désactivée dans SQLite).
    // Cela empêche par exemple de créer un projet avec un user_id qui n'existe pas.
    db.pragma('foreign_keys = ON')

    // Force l'encodage UTF-8 pour supporter les caractères spéciaux (accents, emojis, etc.)
    db.pragma('encoding = "UTF-8"')

    // Création du schéma (tables, index) et exécution des migrations
    initSchema()

    logger.info(`SQLite database initialized at ${DB_PATH}`)
  }
  return db
}

/**
 * Initialise le schéma de la base de données.
 * Crée toutes les tables et index nécessaires au fonctionnement de Clipr.
 * Grâce à "IF NOT EXISTS", cette fonction peut être appelée plusieurs fois
 * sans risque : les tables déjà existantes ne seront pas recréées.
 *
 * Exécute aussi les migrations nécessaires pour les bases de données existantes
 * (par exemple, ajout d'une nouvelle colonne).
 */
function initSchema() {
  db.exec(`
    -- =======================================================================
    -- Table des utilisateurs
    -- Stocke les comptes utilisateur avec leur mot de passe hashé et leur rôle.
    -- =======================================================================
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- =======================================================================
    -- Table des projets
    -- Chaque projet contient des données d'analyse (clips vidéo, etc.)
    -- Le champ 'data' est un JSON stocké en texte (SQLite n'a pas de type JSON natif).
    -- Le champ 'deleted_at' permet la suppression douce (soft delete) :
    -- au lieu de supprimer un projet, on met une date dans ce champ.
    -- =======================================================================
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

    -- Index pour accélérer les requêtes fréquentes sur les projets
    CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

    -- Index d'unicité sur les champs username et email des utilisateurs
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- =======================================================================
    -- Table des verrous IA (ai_locks)
    -- Empêche deux utilisateurs d'utiliser l'IA en même temps.
    -- Voir le fichier ai-lock.ts pour la logique métier.
    -- =======================================================================
    CREATE TABLE IF NOT EXISTS ai_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    -- =======================================================================
    -- Table de partage de projets
    -- Permet à un utilisateur de partager ses projets avec d'autres,
    -- en mode lecture seule ('viewer') ou en mode édition ('editor').
    -- La contrainte UNIQUE(project_id, user_id) empêche de partager deux fois
    -- le même projet avec la même personne.
    -- =======================================================================
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

    -- Index pour retrouver rapidement les partages par projet ou par utilisateur
    CREATE INDEX IF NOT EXISTS idx_shares_project ON project_shares(project_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON project_shares(user_id);

    -- =======================================================================
    -- File d'attente des tâches (task_queue)
    -- Les tâches longues (analyses IA, transcriptions) sont mises en file d'attente
    -- et traitées de manière asynchrone en arrière-plan.
    -- Le champ 'progress' (0-100) permet d'afficher une barre de progression.
    -- =======================================================================
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

    -- =======================================================================
    -- Table des transcriptions audio/vidéo
    -- Stocke le résultat des transcriptions réalisées par Whisper (modèle d'IA).
    -- Le champ 'segments' contient un JSON avec le texte découpé par segments temporels.
    -- =======================================================================
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

  // ==========================================================================
  // MIGRATIONS
  // Les migrations sont des modifications du schéma appliquées aux bases de
  // données existantes. Elles permettent de faire évoluer la structure sans
  // perdre les données des utilisateurs.
  // ==========================================================================

  // --- Migration 1 : Ajout de la colonne user_id dans projects ---
  // Pour les anciennes bases de données qui n'avaient pas cette colonne.
  // On tente une requête SELECT sur user_id : si elle échoue, la colonne n'existe pas.
  try {
    db.prepare('SELECT user_id FROM projects LIMIT 1').get()
  } catch {
    db.exec('ALTER TABLE projects ADD COLUMN user_id TEXT REFERENCES users(id)')
    logger.info('Migration: added user_id column to projects')
  }

  // --- Migration 2 : Ajout du type 'linguistic' dans task_queue ---
  // La contrainte CHECK sur le champ 'type' n'acceptait que 'analysis' et 'transcription'.
  // On doit la modifier pour accepter aussi 'linguistic'.
  // Comme SQLite ne permet pas de modifier une contrainte CHECK, on doit :
  // 1. Créer une nouvelle table avec la bonne contrainte
  // 2. Copier les données
  // 3. Supprimer l'ancienne table
  // 4. Renommer la nouvelle table
  try {
    // On tente d'insérer une ligne de test avec le type 'linguistic'
    // Si ça marche, la contrainte est déjà à jour
    db.prepare("INSERT INTO task_queue (id, user_id, type, status, config, created_at) VALUES ('__test_ling', '__test', 'linguistic', 'cancelled', '{}', datetime('now'))").run()
    // On supprime la ligne de test
    db.prepare("DELETE FROM task_queue WHERE id = '__test_ling'").run()
  } catch {
    // La contrainte actuelle n'accepte pas 'linguistic', on doit migrer
    logger.info('Migration: expanding task_queue type constraint to include linguistic...')

    // On désactive temporairement les clés étrangères car on va supprimer et recréer la table
    db.pragma('foreign_keys = OFF')

    db.exec(`
      -- Création de la nouvelle table avec la contrainte mise à jour
      DROP TABLE IF EXISTS task_queue_new;
      CREATE TABLE task_queue_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('analysis', 'transcription', 'linguistic')),
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
      -- Copie de toutes les données existantes dans la nouvelle table
      INSERT INTO task_queue_new SELECT * FROM task_queue;
      -- Suppression de l'ancienne table
      DROP TABLE task_queue;
      -- Renommage de la nouvelle table
      ALTER TABLE task_queue_new RENAME TO task_queue;
      -- Recréation des index
      CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
      CREATE INDEX IF NOT EXISTS idx_task_queue_user ON task_queue(user_id);
    `)

    // On réactive les clés étrangères
    db.pragma('foreign_keys = ON')
    logger.info('Migration: task_queue type constraint updated')
  }

  // --- Création de la table des transcriptions linguistiques ---
  // Table similaire à 'transcriptions' mais adaptée à l'analyse linguistique.
  // Contient les séquences de parole et la liste des intervenants (speakers).
  db.exec(`
    CREATE TABLE IF NOT EXISTS linguistic_transcriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      leader_speaker TEXT NOT NULL DEFAULT '',
      sequences TEXT NOT NULL DEFAULT '[]',
      speakers TEXT NOT NULL DEFAULT '[]',
      duration REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES task_queue(id)
    );
    CREATE INDEX IF NOT EXISTS idx_linguistic_user ON linguistic_transcriptions(user_id);
  `)

  // Migration : ajout colonne alf_point_id (point d'enquete ALF associe a la
  // transcription, optionnel). On utilise PRAGMA table_info pour verifier la
  // presence de la colonne avant d'ajouter (idempotent sur les bases existantes).
  const linguisticCols = db.prepare("PRAGMA table_info('linguistic_transcriptions')").all() as { name: string }[]
  if (!linguisticCols.some(c => c.name === 'alf_point_id')) {
    db.exec('ALTER TABLE linguistic_transcriptions ADD COLUMN alf_point_id INTEGER')
  }

  // ── Atlas moderne : attestations modernes en double notation ──
  // Chaque variante validee par l'utilisateur dans l'outil linguistique
  // alimente cette table. Permet de constituer un atlas dialectal moderne
  // comparable aux donnees ALF historiques (1900) au meme point d'enquete.
  db.exec(`
    CREATE TABLE IF NOT EXISTS modern_attestations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linguistic_id TEXT NOT NULL,        -- lien vers linguistic_transcriptions
      sequence_idx INTEGER NOT NULL,
      variant_idx INTEGER NOT NULL,
      point_alf_id INTEGER,               -- lien vers alf_points (data/alf.db)
      speaker TEXT,
      french_text TEXT,                   -- phrase FR du meneur (contexte)
      ipa TEXT,
      rousselot TEXT,
      carte_alf_id INTEGER,               -- concept ALF detecte (data/alf.db) si match
      audio_extract TEXT,                 -- nom du clip audio
      validated_by_user INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (linguistic_id) REFERENCES linguistic_transcriptions(id) ON DELETE CASCADE,
      UNIQUE (linguistic_id, sequence_idx, variant_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_modern_point ON modern_attestations(point_alf_id);
    CREATE INDEX IF NOT EXISTS idx_modern_carte ON modern_attestations(carte_alf_id);
  `)
}

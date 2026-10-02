/**
 * ForeSight schema — SQLite DDL, idempotent migration, sqlite-vec loading.
 * Design contract: docs/design.md §7.
 *
 * Four tables:
 *   memories      memory entries (hybrid: structured cols + vector + metadata bag)
 *   links         edges between memories
 *   conversations raw session messages (twice FTS-indexed)
 *   events        append-only audit trail
 * Plus two FTS5 shadow tables and one sqlite-vec vec0 virtual table.
 *
 * SQLite access: built-in `node:sqlite` (no native module -- runs identically
 * under plain Node and the Electron runtime; sqlite-vec loaded as an extension).
 */
import { DatabaseSync } from 'node:sqlite'
import * as sqliteVec from 'sqlite-vec'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EMBED_DIM } from './defaults.js'

export interface Schema {
  db: DatabaseSync
  dbPath: string
}

/** Open (or create) the database, apply DDL, load sqlite-vec. Idempotent. */
export function openDatabase(dbPath: string): Schema {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath, { allowExtension: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.enableLoadExtension(true)
  db.loadExtension(sqliteVec.getLoadablePath())
  migrate(db)
  return { db, dbPath }
}

const DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  aspect       TEXT NOT NULL,
  anchor_json  TEXT NOT NULL DEFAULT '{"type":"none"}',
  category     TEXT,
  telicity     TEXT,
  modality     TEXT,
  activation   REAL NOT NULL DEFAULT 1.0,
  base_weight  REAL NOT NULL DEFAULT 1.0,
  source       TEXT NOT NULL,
  source_ref   TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  metadata     TEXT NOT NULL DEFAULT '{}',
  embedding    BLOB,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_aspect_status ON memories(aspect, status);
CREATE INDEX IF NOT EXISTS idx_memories_activation ON memories(activation);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  rel        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  peer       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  type   TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  clause TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(content);
CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts_zh USING fts5(content, tokenize='trigram');

CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[${EMBED_DIM}]
);
`

/** Migrate: idempotent DDL, version recorded in PRAGMA user_version. */
function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (current < 1) {
    db.exec(DDL)
    db.exec('PRAGMA user_version = 1')
  }
}

export function closeDatabase(schema: Schema): void {
  schema.db.close()
}

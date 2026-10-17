import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { Logger } from '../log/logger.ts';

export type Db = Database.Database;

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/** UTC `YYYY-MM-DD HH:MM:SS` — the one timestamp format every table stores. */
export const sqliteTime = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Open (creating if needed) the SQLite file, enable WAL and foreign keys, and
 * apply pending `migrations/NNN_*.sql` in order, each in one transaction.
 */
export function openDatabase(path: string, log: Logger): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations ( version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]);
  for (const { version, name, sql } of migrations()) {
    if (applied.has(version)) continue;
    log.info(`applying migration ${name}`);
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, sqliteTime(new Date()));
    })();
  }
  return db;
}

/**
 * A second connection that cannot write: `database_query` runs model-written
 * SQL here, so even a statement that slips past its checks can't mutate data.
 */
export const openReadOnly = (path: string): Db => new Database(path, { readonly: true, fileMustExist: true });

function migrations(): { version: number; name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .flatMap((name) => {
      const match = /^(\d+)_.+\.sql$/.exec(name);
      return match ? [{ version: Number(match[1]), name, sql: readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8') }] : [];
    })
    .sort((a, b) => a.version - b.version);
}

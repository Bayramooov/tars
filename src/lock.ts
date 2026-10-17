import { join } from 'node:path';

import Database from 'better-sqlite3';

/**
 * Refuse to run twice on one data directory (two bots would double-fire
 * reminders and fight over the Claude session). The lock is an exclusive
 * SQLite lock on `data/.instance.lock`, held for the process lifetime and
 * released by the OS when the process dies — even on SIGKILL — so there is
 * no stale lock to clean up. Returns the release function.
 */
export function acquireInstanceLock(dataDir: string): () => void {
  const db = new Database(join(dataDir, '.instance.lock'), { timeout: 0 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec(`BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder (pid INTEGER); DELETE FROM holder; INSERT INTO holder VALUES (${process.pid}); COMMIT;`);
  } catch (err) {
    db.close();
    throw new Error(
      `another tars instance is already running on ${dataDir} (data/.instance.lock is held). Stop it, or give this instance its own TARS_DATA_DIR.`,
      { cause: err },
    );
  }
  return () => db.close();
}

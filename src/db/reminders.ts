import { type Db, sqliteTime } from './database.ts';

/** A `reminders` row as `SELECT *` returns it. `cron_expr` NULL = one-shot; `auto_seed_key` NULL = set from chat. */
export interface ReminderRow {
  id: number;
  chat_id: number;
  user_id: number;
  text: string;
  /** UTC `YYYY-MM-DD HH:MM:SS`; the due check compares it as text. */
  trigger_at: string;
  cron_expr: string | null;
  status: 'pending' | 'processing' | 'sent' | 'cancelled';
  created_at: string;
  auto_seed_key: string | null;
}

export interface NewReminder {
  chatId: number;
  userId: number;
  text: string;
  triggerAt: string;
  cronExpr: string | null;
}

/** A pending reminder; boot seeders tag theirs with `autoSeedKey`. Returns its id. */
export function insertReminder(db: Db, r: NewReminder, autoSeedKey: string | null = null): number {
  const info = db
    .prepare(
      `INSERT INTO reminders (chat_id, user_id, text, trigger_at, cron_expr, status, created_at, auto_seed_key)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(r.chatId, r.userId, r.text, r.triggerAt, r.cronExpr, sqliteTime(new Date()), autoSeedKey);
  return Number(info.lastInsertRowid);
}

/** Pending reminders due at `now` (a `sqliteTime`), across all chats, earliest first. */
export function fetchDueReminders(db: Db, now: string): ReminderRow[] {
  return db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND trigger_at <= ? ORDER BY trigger_at, id").all(now) as ReminderRow[];
}

/** pending → processing, atomically: false when another poll already holds the row. */
export function claimReminder(db: Db, id: number): boolean {
  return db.prepare("UPDATE reminders SET status = 'processing' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
}

/** A failed delivery: back to pending so the next poll fires it again. */
export function revertReminder(db: Db, id: number): void {
  db.prepare("UPDATE reminders SET status = 'pending' WHERE id = ? AND status = 'processing'").run(id);
}

/** At boot nothing is in flight, so every `processing` row is a delivery a shutdown cut short. */
export function resetStuckReminders(db: Db): number {
  return db.prepare("UPDATE reminders SET status = 'pending' WHERE status = 'processing'").run().changes;
}

export function markReminderSent(db: Db, id: number): void {
  db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(id);
}

/** A delivered recurring reminder waits, pending, for its next slot. */
export function advanceRecurringReminder(db: Db, id: number, nextTriggerAt: string): void {
  db.prepare("UPDATE reminders SET trigger_at = ?, status = 'pending' WHERE id = ?").run(nextTriggerAt, id);
}

/** Only a pending reminder can be cancelled; false otherwise (unknown, in flight, sent or cancelled). */
export function cancelReminder(db: Db, id: number): boolean {
  return db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
}

export function listPendingReminders(db: Db, chatId: number): ReminderRow[] {
  return db.prepare("SELECT * FROM reminders WHERE chat_id = ? AND status = 'pending' ORDER BY trigger_at").all(chatId) as ReminderRow[];
}

export function fetchReminder(db: Db, id: number): ReminderRow | undefined {
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
}

/** Pending rows a boot seeder owns under `key`. Only pending ones count: a cancelled loop is re-seeded. */
export function countPendingAutoSeeded(db: Db, key: string): number {
  return db.prepare("SELECT COUNT(*) FROM reminders WHERE auto_seed_key = ? AND status = 'pending'").pluck().get(key) as number;
}

/** Distinct keys of pending seeded rows under `prefix` (SQLite `LIKE`: ASCII case-insensitive). */
export function pendingAutoSeedKeys(db: Db, prefix: string): Set<string> {
  const keys = db.prepare("SELECT DISTINCT auto_seed_key FROM reminders WHERE status = 'pending' AND auto_seed_key LIKE ? || '%'").pluck().all(prefix);
  return new Set(keys as string[]);
}

export function cancelAutoSeeded(db: Db, key: string): number {
  return db.prepare("UPDATE reminders SET status = 'cancelled' WHERE auto_seed_key = ? AND status = 'pending'").run(key).changes;
}

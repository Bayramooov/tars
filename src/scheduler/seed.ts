import type { Config } from '../config.ts';
import type { Db } from '../db/database.ts';
import { cancelAutoSeeded, countPendingAutoSeeded, insertReminder, type NewReminder, pendingAutoSeedKeys, resetStuckReminders } from '../db/reminders.ts';
import type { Logger } from '../log/logger.ts';
import { nextFire } from './cron.ts';
import { KEY_PREFIX, loadDeclaredReminders } from './declared.ts';

const SELF_REFLECTION_KEY = 'self-reflection-default';

export type SeedConfig = Pick<Config, 'ownerId' | 'selfReflectionEnabled' | 'selfReflectionCron' | 'committedRemindersPath'>;

/**
 * Boot-time reminder upkeep, before anything can fire: re-arm deliveries a
 * shutdown cut short (first, so an in-flight self-reflection row counts as
 * pending), then match the operator-owned rows to the config — the
 * self-reflection loop and `default-reminders.json`. A malformed file or an
 * unusable cron throws: boot stops rather than run without a reminder.
 */
export function prepareReminders(db: Db, config: SeedConfig, log: Logger): void {
  const rearmed = resetStuckReminders(db);
  if (rearmed) log.info(`re-armed ${rearmed} reminder(s) left mid-delivery by the last shutdown`);
  seedSelfReflection(db, config, log);
  reconcileCommitted(db, config, log);
}

/** On: exactly one pending self-reflection row (re-seeded if cancelled or deleted). Off: none. */
function seedSelfReflection(db: Db, config: SeedConfig, log: Logger): void {
  if (!config.selfReflectionEnabled) {
    log.info(`self-reflection disabled; cancelled ${cancelAutoSeeded(db, SELF_REFLECTION_KEY)} pending reminder(s)`);
    return;
  }
  const pending = countPendingAutoSeeded(db, SELF_REFLECTION_KEY);
  if (pending > 0) {
    log.info(`self-reflection reminder: ${pending} pending row(s) active, skipping seed`);
    return;
  }
  const cronExpr = config.selfReflectionCron;
  const triggerAt = nextFire(cronExpr, new Date());
  insertReminder(db, { chatId: config.ownerId, userId: -1, text: '<skill name="self-reflection">run</skill>', triggerAt, cronExpr }, SELF_REFLECTION_KEY);
  log.info(`seeded default self-reflection reminder (cron=${cronExpr}, next=${triggerAt} UTC)`);
}

/**
 * Make the pending `committed:` rows match the enabled entries of
 * `default-reminders.json`: seed what's missing, cancel what's gone. Keys are
 * content hashes, so an edit reads as cancel-old + seed-new; rows with other
 * keys (self-reflection, set from chat) are never touched.
 */
function reconcileCommitted(db: Db, config: SeedConfig, log: Logger): void {
  const declared = loadDeclaredReminders(config.committedRemindersPath, config.ownerId);
  const desired = new Map<string, NewReminder>();
  for (const r of declared) {
    if (r.enabled) desired.set(r.key, { chatId: r.chatId, userId: -1, text: r.text, triggerAt: nextFire(r.cron, new Date()), cronExpr: r.cron });
  }
  const existing = pendingAutoSeedKeys(db, KEY_PREFIX);
  let cancelled = 0;
  for (const key of existing) if (!desired.has(key)) cancelled += cancelAutoSeeded(db, key);
  let seeded = 0;
  for (const [key, reminder] of desired) {
    if (existing.has(key)) continue;
    insertReminder(db, reminder, key);
    seeded++;
  }
  log.info(`committed reminders: ${declared.length} declared, ${seeded} seeded, ${cancelled} cancelled, ${desired.size - seeded} unchanged`);
}

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase, sqliteTime } from '../../src/db/database.ts';
import { cancelReminder, claimReminder, insertReminder } from '../../src/db/reminders.ts';
import { prepareReminders, type SeedConfig } from '../../src/scheduler/seed.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const OWNER = 42;
const TRENDS = { name: 'morning-trends', cron: '0 6 * * *', text: 'Post today\'s trends digest.' };
const REVIEW = { name: 'weekly-review', cron: '0 18 * * 5', text: 'Summarize the week.' };

function setup(over: Partial<SeedConfig> = {}) {
  const dir = tempDir();
  const log = memoryLogger();
  const db = openDatabase(join(dir, 'h.db'), log);
  const config: SeedConfig = { ownerId: OWNER, selfReflectionEnabled: false, selfReflectionCron: '0 0 * * *', committedRemindersPath: join(dir, 'default-reminders.json'), ...over };
  const write = (body: string) => writeFileSync(config.committedRemindersPath, body);
  const declare = (...reminders: object[]) => write(JSON.stringify({ reminders }));
  const boot = (changes: Partial<SeedConfig> = {}) => prepareReminders(db, { ...config, ...changes }, log);
  const rows = (where: string) => db.prepare(`SELECT id, chat_id, user_id, text, trigger_at, cron_expr, status, auto_seed_key FROM reminders WHERE ${where} ORDER BY id`).all() as Record<string, unknown>[];
  const lines = () => log.records.filter((r) => r.name === 'tars').map((r) => r.msg);
  return { db, log, write, declare, boot, rows, lines };
}

const selfReflection = "auto_seed_key = 'self-reflection-default'";
const committed = "status = 'pending' AND auto_seed_key LIKE 'committed:%'";

describe('boot: re-arming deliveries a shutdown cut short', () => {
  it('re-arms them first, so an in-flight self-reflection row is not seeded twice', () => {
    const t = setup({ selfReflectionEnabled: true });
    t.boot();
    const [row] = t.rows(selfReflection);
    claimReminder(t.db, row?.id as number);
    t.boot();
    expect(t.rows(selfReflection).map((r) => r.status)).toEqual(['pending']);
    expect(t.lines()).toContain('re-armed 1 reminder(s) left mid-delivery by the last shutdown');
    expect(t.lines()).toContain('self-reflection reminder: 1 pending row(s) active, skipping seed');
  });
});

describe('boot: the self-reflection loop', () => {
  it('seeds one pending row for the owner at the next cron fire', () => {
    const t = setup({ selfReflectionEnabled: true, selfReflectionCron: '0 0 * * *' });
    const before = sqliteTime(new Date());
    t.boot();
    const rows = t.rows(selfReflection);
    expect(rows).toEqual([
      { id: 1, chat_id: OWNER, user_id: -1, text: '<skill name="self-reflection">run</skill>', trigger_at: expect.stringMatching(/ 00:00:00$/) as unknown, cron_expr: '0 0 * * *', status: 'pending', auto_seed_key: 'self-reflection-default' },
    ]);
    const next = rows[0]?.trigger_at as string;
    expect(next > before && next <= sqliteTime(new Date(Date.now() + 86_400_000))).toBe(true);
    expect(t.lines()).toContain(`seeded default self-reflection reminder (cron=0 0 * * *, next=${next} UTC)`);
  });

  it('does not seed a second row on the next boot', () => {
    const t = setup({ selfReflectionEnabled: true });
    t.boot();
    t.boot();
    expect(t.rows(selfReflection)).toHaveLength(1);
  });

  // "learning cannot be stopped": a deleted or cancelled row comes back; a cancelled one stays as history
  it('re-seeds a deleted or cancelled row', () => {
    const t = setup({ selfReflectionEnabled: true });
    t.boot();
    t.db.prepare(`DELETE FROM reminders WHERE ${selfReflection}`).run();
    t.boot();
    expect(t.rows(selfReflection).map((r) => r.status)).toEqual(['pending']);
    t.db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE ${selfReflection}`).run();
    t.boot();
    expect(t.rows(selfReflection).map((r) => r.status)).toEqual(['cancelled', 'pending']);
  });

  it('seeds nothing when disabled, and cancels a row seeded while it was on', () => {
    const t = setup();
    t.boot();
    expect(t.rows(selfReflection)).toEqual([]);
    t.boot({ selfReflectionEnabled: true });
    t.boot({ selfReflectionEnabled: false });
    expect(t.rows(selfReflection).map((r) => r.status)).toEqual(['cancelled']);
    expect(t.lines()).toContain('self-reflection disabled; cancelled 1 pending reminder(s)');
    expect(t.lines()).toContain('self-reflection disabled; cancelled 0 pending reminder(s)');
  });

  it('keeps the existing row when the cron changes', () => {
    const t = setup({ selfReflectionEnabled: true });
    t.boot();
    t.boot({ selfReflectionCron: '0 12 * * *' });
    expect(t.rows(selfReflection).map((r) => r.cron_expr)).toEqual(['0 0 * * *']);
  });

  it('stops boot on a cron that can never fire', () => {
    const t = setup({ selfReflectionEnabled: true, selfReflectionCron: 'nope' });
    expect(() => t.boot()).toThrow('invalid cron expression "nope"');
  });
});

describe('boot: default-reminders.json', () => {
  it('seeds every enabled entry as a pending row for its chat', () => {
    const t = setup();
    t.declare(TRENDS, REVIEW, { name: 'group-digest', cron: '0 9 * * *', chat: -100123, text: 'Daily group digest.' });
    t.boot();
    expect(t.rows(committed).map((r) => [r.text, r.chat_id, r.user_id, r.cron_expr, r.auto_seed_key])).toEqual([
      ['Post today\'s trends digest.', OWNER, -1, '0 6 * * *', 'committed:morning-trends:70eb67bd'],
      ['Summarize the week.', OWNER, -1, '0 18 * * 5', 'committed:weekly-review:bc16820b'],
      ['Daily group digest.', -100123, -1, '0 9 * * *', 'committed:group-digest:9f03df76'],
    ]);
    expect(t.rows(committed).every((r) => (r.trigger_at as string) > sqliteTime(new Date()))).toBe(true);
    expect(t.lines()).toContain('committed reminders: 3 declared, 3 seeded, 0 cancelled, 0 unchanged');
  });

  it('adds nothing on a second boot with the same file, and keeps the rows\' trigger times', () => {
    const t = setup();
    t.declare(TRENDS, REVIEW);
    t.boot();
    t.db.prepare("UPDATE reminders SET trigger_at = '2099-01-01 06:00:00'").run();
    t.boot();
    expect(t.rows(committed).map((r) => r.trigger_at)).toEqual(['2099-01-01 06:00:00', '2099-01-01 06:00:00']);
    expect(t.lines().at(-1)).toBe('committed reminders: 2 declared, 0 seeded, 0 cancelled, 2 unchanged');
  });

  it('reads an edit as cancel-old, seed-new; the old row stays as history', () => {
    const t = setup();
    t.declare(TRENDS);
    t.boot();
    t.declare({ ...TRENDS, cron: '0 9 * * *' });
    t.boot();
    expect(t.rows(committed).map((r) => r.cron_expr)).toEqual(['0 9 * * *']);
    expect(t.rows("status = 'cancelled'").map((r) => r.cron_expr)).toEqual(['0 6 * * *']);
    expect(t.lines().at(-1)).toBe('committed reminders: 1 declared, 1 seeded, 1 cancelled, 0 unchanged');
  });

  it('cancels an entry that is removed or turned off, and never seeds a disabled one', () => {
    const t = setup();
    t.declare(TRENDS, { ...REVIEW, enabled: false });
    t.boot();
    expect(t.rows(committed).map((r) => r.text)).toEqual([TRENDS.text]);
    expect(t.lines().at(-1)).toBe('committed reminders: 2 declared, 1 seeded, 0 cancelled, 0 unchanged');
    t.declare(TRENDS, REVIEW);
    t.boot();
    t.declare(TRENDS, { ...REVIEW, enabled: false });
    t.boot();
    expect(t.rows(committed).map((r) => r.text)).toEqual([TRENDS.text]);
    t.declare();
    t.boot();
    expect(t.rows(committed)).toEqual([]);
  });

  // a committed row cancelled by hand is seeded again
  it('re-seeds a cancelled committed row', () => {
    const t = setup();
    t.declare(TRENDS);
    t.boot();
    cancelReminder(t.db, 1);
    t.boot();
    expect(t.rows(committed)).toHaveLength(1);
  });

  it('never touches self-reflection or user-set rows, even with no file at all', () => {
    const t = setup({ selfReflectionEnabled: true });
    const userRow = insertReminder(t.db, { chatId: OWNER, userId: 7, text: 'call mom', triggerAt: '2999-01-01 00:00:00', cronExpr: null });
    t.declare(TRENDS);
    t.boot();
    t.declare();
    t.boot();
    expect(t.rows(`id = ${userRow} OR ${selfReflection}`).map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(t.lines().at(-1)).toBe('committed reminders: 0 declared, 0 seeded, 1 cancelled, 0 unchanged');
  });

  it('stops boot on a malformed file or an entry that can never fire, before changing anything', () => {
    const t = setup();
    t.declare(TRENDS);
    t.boot();
    t.write('{"reminders": 5}');
    expect(() => t.boot()).toThrow(expect.objectContaining({ name: 'ReminderConfigError' }) as Error);
    t.declare({ name: 'fresh', cron: '0 6 * * *', text: 'x' }, { name: 'never', cron: '0 6 31 2 *', text: 'y' });
    expect(() => t.boot()).toThrow('reminders[1]: invalid cron expression "0 6 31 2 *"');
    expect(t.rows(committed).map((r) => r.text)).toEqual([TRENDS.text]);
  });
});

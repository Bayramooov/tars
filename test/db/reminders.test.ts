import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import {
  advanceRecurringReminder,
  cancelAutoSeeded,
  cancelReminder,
  claimReminder,
  countPendingAutoSeeded,
  fetchDueReminders,
  fetchReminder,
  insertReminder,
  listPendingReminders,
  markReminderSent,
  pendingAutoSeedKeys,
  resetStuckReminders,
  revertReminder,
} from '../../src/db/reminders.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

// A trigger in the deep past and a "now" far in the future: an unclaimed reminder is always due.
const PAST = '2000-01-01 00:00:00';
const NOW = '2100-01-01 00:00:00';

function setup() {
  const db = openDatabase(join(tempDir(), 'h.db'), memoryLogger());
  const insert = (over: Partial<Parameters<typeof insertReminder>[1]> = {}, key: string | null = null) =>
    insertReminder(db, { chatId: -100, userId: 42, text: 'ping', triggerAt: PAST, cronExpr: null, ...over }, key);
  const status = (id: number) => fetchReminder(db, id)?.status;
  return { db, insert, status };
}

describe('reminders table: the delivery claim', () => {
  it('inserts a pending row stamped with the UTC time', () => {
    const { db, insert } = setup();
    const before = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const id = insert({ cronExpr: '0 9 * * *' }, 'committed:x:1');
    expect(fetchReminder(db, id)).toEqual({
      id, chat_id: -100, user_id: 42, text: 'ping', trigger_at: PAST, cron_expr: '0 9 * * *', status: 'pending',
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/) as unknown, auto_seed_key: 'committed:x:1',
    });
    expect((fetchReminder(db, id)?.created_at ?? '') >= before).toBe(true);
    expect(fetchReminder(db, insert())?.auto_seed_key).toBeNull();
  });

  it('hides a claimed reminder from the next poll', () => {
    const { db, insert } = setup();
    const id = insert();
    expect(fetchDueReminders(db, NOW).map((r) => r.id)).toEqual([id]);
    expect(claimReminder(db, id)).toBe(true);
    expect(fetchDueReminders(db, NOW)).toEqual([]);
  });

  it('lets only one claim win', () => {
    const { db, insert } = setup();
    const id = insert();
    expect(claimReminder(db, id)).toBe(true);
    expect(claimReminder(db, id)).toBe(false);
  });

  it('re-arms a claimed reminder whose delivery failed, and only an in-flight one', () => {
    const { db, insert, status } = setup();
    const id = insert();
    claimReminder(db, id);
    revertReminder(db, id);
    expect(fetchDueReminders(db, NOW).map((r) => r.id)).toEqual([id]);
    markReminderSent(db, id);
    revertReminder(db, id);
    expect(status(id)).toBe('sent');
  });

  it('re-arms every row a shutdown left mid-delivery', () => {
    const { db, insert } = setup();
    const id = insert();
    claimReminder(db, id);
    expect(resetStuckReminders(db)).toBe(1);
    expect(fetchDueReminders(db, NOW).map((r) => r.id)).toEqual([id]);
    expect(resetStuckReminders(db)).toBe(0);
  });

  it('returns an advanced recurring reminder to pending, not due until its next slot', () => {
    const { db, insert, status } = setup();
    const id = insert({ cronExpr: '0 0 * * *' });
    claimReminder(db, id);
    advanceRecurringReminder(db, id, '2100-06-18 00:00:00');
    expect([status(id), fetchReminder(db, id)?.trigger_at]).toEqual(['pending', '2100-06-18 00:00:00']);
    expect(fetchDueReminders(db, NOW)).toEqual([]);
  });

  it('closes a delivered one-shot', () => {
    const { db, insert, status } = setup();
    const id = insert();
    claimReminder(db, id);
    markReminderSent(db, id);
    expect(status(id)).toBe('sent');
  });

  it('compares trigger times as canonical text, earliest first, across chats', () => {
    const { db, insert } = setup();
    const late = insert({ triggerAt: '2026-10-17 06:00:01', chatId: 1 });
    const early = insert({ triggerAt: '2026-10-17 05:00:00', chatId: 2 });
    insert({ triggerAt: '2026-10-17 06:00:02' });
    expect(fetchDueReminders(db, '2026-10-17 06:00:01').map((r) => r.id)).toEqual([early, late]);
  });
});

describe('reminders table: listing and cancelling', () => {
  it('cancels only pending rows', () => {
    const { db, insert, status } = setup();
    const [pending, inFlight, sent] = [insert(), insert(), insert()];
    claimReminder(db, inFlight);
    markReminderSent(db, sent);
    expect([cancelReminder(db, pending), cancelReminder(db, inFlight), cancelReminder(db, sent), cancelReminder(db, 999)]).toEqual([true, false, false, false]);
    expect([status(pending), status(inFlight), status(sent)]).toEqual(['cancelled', 'processing', 'sent']);
    expect(cancelReminder(db, pending)).toBe(false);
  });

  it('lists a chat\'s pending rows by trigger time; in-flight ones are hidden', () => {
    const { db, insert } = setup();
    const later = insert({ triggerAt: '2030-01-02 00:00:00' });
    const sooner = insert({ triggerAt: '2030-01-01 00:00:00' });
    claimReminder(db, insert());
    insert({ chatId: 7 });
    expect(listPendingReminders(db, -100).map((r) => r.id)).toEqual([sooner, later]);
    expect(fetchReminder(db, 999)).toBeUndefined();
  });

  it('counts, lists and cancels seeded rows by key; cancelled ones no longer count', () => {
    const { db, insert } = setup();
    insert({}, 'committed:a:1');
    insert({}, 'committed:a:1');
    insert({}, 'COMMITTED:b:2');
    insert({}, 'self-reflection-default');
    claimReminder(db, insert({}, 'committed:c:3'));
    insert();
    expect(countPendingAutoSeeded(db, 'committed:a:1')).toBe(2);
    expect(pendingAutoSeedKeys(db, 'committed:')).toEqual(new Set(['committed:a:1', 'COMMITTED:b:2']));
    expect(cancelAutoSeeded(db, 'committed:a:1')).toBe(2);
    expect(countPendingAutoSeeded(db, 'committed:a:1')).toBe(0);
    expect(cancelAutoSeeded(db, 'committed:c:3')).toBe(0);
  });
});

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase, sqliteTime } from '../../src/db/database.ts';
import { claimReminder, fetchDueReminders, insertReminder, markReminderSent } from '../../src/db/reminders.ts';
import type { Tool } from '../../src/mcp/tool.ts';
import { reminderCancelTool, reminderListTool, reminderSetTool } from '../../src/tools/reminders.ts';
import { expectGoldenTool } from '../golden/tools.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

function setup() {
  const db = openDatabase(join(tempDir(), 'h.db'), memoryLogger());
  const tools = { set: reminderSetTool(db), list: reminderListTool(db), cancel: reminderCancelTool(db) };
  const call = (tool: Tool, args: object) => tool.run(tool.args.parse(args));
  const set = (trigger_at: string, extra: object = {}) => call(tools.set, { chat_id: 42, user_id: 42, text: 'hi', trigger_at, ...extra });
  const stored = () => db.prepare('SELECT trigger_at FROM reminders ORDER BY id DESC LIMIT 1').pluck().get() as string | undefined;
  return { db, tools, call, set, stored };
}

/** `YYYY-MM-DDTHH:MM:SS` + suffix, `minutes` from now. */
const isoIn = (minutes: number, suffix = 'Z') => new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 19) + suffix;

describe('reminder tools: surface', () => {
  it('match the tools/list snapshot', () => {
    const { tools } = setup();
    expectGoldenTool(tools.set);
    expectGoldenTool(tools.list);
    expectGoldenTool(tools.cancel);
  });
});

describe('reminder_set', () => {
  // `T…Z` sorts after `YYYY-MM-DD HH:MM:SS`, so the loop's text compare needs the canonical form
  it('stores trigger_at as canonical UTC, which the loop\'s due query picks up', async () => {
    const t = setup();
    const at = isoIn(2);
    expect(await t.set(at)).toEqual({ content: `reminder #1 (one-shot) set for ${at}`, data: { reminder_id: 1 } });
    expect(t.stored()).toBe(at.slice(0, 19).replace('T', ' '));
    expect(fetchDueReminders(t.db, sqliteTime(new Date(Date.now() + 7 * 60_000))).map((r) => [r.chat_id, r.user_id, r.text, r.cron_expr])).toEqual([[42, 42, 'hi', null]]);
  });

  it('converts an offset to UTC but echoes trigger_at as given', async () => {
    const t = setup();
    expect((await t.set('2099-01-01T12:00:00+02:00')).content).toBe('reminder #1 (one-shot) set for 2099-01-01T12:00:00+02:00');
    expect(t.stored()).toBe('2099-01-01 10:00:00');
  });

  it.each([
    ['2099-01-01 12:00:00Z', '2099-01-01 12:00:00'],
    ['2099-01-01T12:00Z', '2099-01-01 12:00:00'],
    ['2099-01-01T12:00:00.999999Z', '2099-01-01 12:00:00'],
    ['2099-01-01T12:00:00.5-05:00', '2099-01-01 17:00:00'],
    ['2099-01-01T12:00:00+05:30', '2099-01-01 06:30:00'],
    ['2099-01-01T00:00:00+23:59', '2098-12-31 00:01:00'],
  ])('accepts %s', async (input, canonical) => {
    const t = setup();
    expect((await t.set(input)).isError).toBeUndefined();
    expect(t.stored()).toBe(canonical);
  });

  it.each([
    ['tomorrow 9am', 'invalid trigger_at format: "tomorrow 9am"'],
    ['2099-02-30T10:00:00Z', 'invalid trigger_at format: "2099-02-30T10:00:00Z"'],
    [' 2099-01-01T12:00:00Z', 'invalid trigger_at format: " 2099-01-01T12:00:00Z"'],
    ['2099-01-01T12:00:00z', 'invalid trigger_at format: "2099-01-01T12:00:00z"'],
    ['2099-01-01T24:00:00Z', 'invalid trigger_at format: "2099-01-01T24:00:00Z"'],
    ['2099-01-01T12:00:00+25:00', 'invalid trigger_at format: "2099-01-01T12:00:00+25:00"'],
    ['2099-01-01T12:0000Z', 'invalid trigger_at format: "2099-01-01T12:0000Z"'],
    ['2099-1-01T12:00:00Z', 'invalid trigger_at format: "2099-1-01T12:00:00Z"'],
    ['2099-01-01T', 'invalid trigger_at format: "2099-01-01T"'],
    ['2099-01-01', 'invalid trigger_at format: "2099-01-01"'],
    ['0000-01-01T00:00:00Z', 'trigger_at is out of range'],
    ['9999-12-31T23:00:00-05:00', 'trigger_at is out of range'],
    ['2020-01-01T00:00:00Z', 'trigger_at must be in the future'],
  ])('refuses %s', async (input, content) => {
    const t = setup();
    expect(await t.set(input)).toEqual({ content, isError: true });
    expect(t.stored()).toBeUndefined();
  });

  it('refuses a time without an offset', async () => {
    const t = setup();
    expect(await t.set(isoIn(5, ''))).toEqual({ content: "trigger_at must include a timezone offset (use UTC, e.g. '...Z')", isError: true });
  });

  it('sets a recurring reminder with a valid cron, checking the time first', async () => {
    const t = setup();
    const at = isoIn(60);
    expect(await t.set(at, { cron_expr: '0 9 * * 1-5' })).toEqual({ content: `reminder #1 (recurring) set for ${at}`, data: { reminder_id: 1 } });
    expect(t.db.prepare('SELECT cron_expr, status, auto_seed_key FROM reminders').get()).toEqual({ cron_expr: '0 9 * * 1-5', status: 'pending', auto_seed_key: null });
    expect(await t.set(at, { cron_expr: 'not a cron' })).toEqual({ content: 'invalid cron expression: "not a cron"', isError: true });
    expect(await t.set(at, { cron_expr: '' })).toEqual({ content: 'invalid cron expression: ""', isError: true });
    expect((await t.set('tomorrow', { cron_expr: 'not a cron' })).content).toBe('invalid trigger_at format: "tomorrow"');
  });
});

describe('reminder_list', () => {
  it('lists the chat\'s pending reminders as raw TSV, soonest first', async () => {
    const t = setup();
    insertReminder(t.db, { chatId: 42, userId: 7, text: 'water\tplants\nnow', triggerAt: '2099-01-02 09:00:00', cronExpr: '0 9 * * *' });
    insertReminder(t.db, { chatId: 42, userId: 7, text: 'call mom', triggerAt: '2099-01-01 09:00:00', cronExpr: null });
    claimReminder(t.db, insertReminder(t.db, { chatId: 42, userId: 7, text: 'in flight', triggerAt: '2000-01-01 00:00:00', cronExpr: null }));
    insertReminder(t.db, { chatId: 43, userId: 7, text: 'elsewhere', triggerAt: '2099-01-01 09:00:00', cronExpr: null });
    expect(await t.call(t.tools.list, { chat_id: 42 })).toEqual({
      content: 'id\ttrigger_at\tcron\ttext\n2\t2099-01-01 09:00:00\t-\tcall mom\n1\t2099-01-02 09:00:00\t0 9 * * *\twater\tplants\nnow',
      data: { count: 2 },
    });
    expect(await t.call(t.tools.list, { chat_id: 44 })).toEqual({ content: 'no pending reminders' });
  });
});

describe('reminder_cancel', () => {
  it('cancels a pending reminder, and only that', async () => {
    const t = setup();
    const id = insertReminder(t.db, { chatId: 42, userId: 7, text: 'x', triggerAt: '2099-01-01 09:00:00', cronExpr: null });
    const sent = insertReminder(t.db, { chatId: 42, userId: 7, text: 'y', triggerAt: '2000-01-01 00:00:00', cronExpr: null });
    markReminderSent(t.db, sent);
    expect(await t.call(t.tools.cancel, { reminder_id: id })).toEqual({ content: `reminder #${id} cancelled` });
    for (const gone of [id, sent, 999]) {
      expect(await t.call(t.tools.cancel, { reminder_id: gone })).toEqual({ content: `reminder #${gone} not found or already sent/cancelled`, isError: true });
    }
  });

  // the self-reflection loop and default-reminders.json rows are the operator's
  it('refuses to cancel an auto-seeded reminder in any status', async () => {
    const t = setup();
    const id = insertReminder(t.db, { chatId: 42, userId: -1, text: '<skill name="self-reflection">run</skill>', triggerAt: '2099-01-01 00:00:00', cronExpr: '0 0 * * *' }, 'self-reflection-default');
    expect(await t.call(t.tools.cancel, { reminder_id: id })).toEqual({
      content: `reminder #${id} is an auto-seeded mandatory loop (self-reflection-default) and cannot be cancelled`,
      isError: true,
    });
    claimReminder(t.db, id);
    expect((await t.call(t.tools.cancel, { reminder_id: id })).content).toContain('auto-seeded mandatory loop');
    expect(t.db.prepare('SELECT status FROM reminders').pluck().get()).toBe('processing');
  });
});

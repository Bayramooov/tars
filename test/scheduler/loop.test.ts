import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TurnResult } from '../../src/claude/turn.ts';
import { openDatabase, sqliteTime } from '../../src/db/database.ts';
import { claimReminder, fetchReminder, insertReminder, type NewReminder } from '../../src/db/reminders.ts';
import { Engine, type EngineWorker, type TurnHooks } from '../../src/engine/engine.ts';
import { TypingIndicator } from '../../src/engine/typing.ts';
import type { ChatMessage } from '../../src/message.ts';
import { ReminderLoop } from '../../src/scheduler/loop.ts';
import { loadGolden } from '../golden/load.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';
import { until } from '../helpers/wait.ts';

const running: { stop(): unknown }[] = [];
afterEach(async () => {
  for (const item of running.splice(0)) await item.stop();
});

/** Records what the loop submits; `fail` makes submits throw, `onSubmit` runs inside one. */
class FakeEngine {
  readonly submitted: { msg: ChatMessage; hooks: TurnHooks }[] = [];
  fail = false;
  onSubmit = () => {};
  submit(msg: ChatMessage, hooks: TurnHooks): Promise<void> {
    if (this.fail) return Promise.reject(new Error('engine is gone'));
    this.submitted.push({ msg, hooks });
    this.onSubmit();
    return Promise.resolve();
  }
}

function setup(intervalMs = 5) {
  const log = memoryLogger();
  const db = openDatabase(join(tempDir(), 'h.db'), log);
  const engine = new FakeEngine();
  const loop = new ReminderLoop({ db, engine, log: log.child('reminder'), intervalMs });
  running.push(loop);
  const add = (r: Partial<NewReminder> = {}) => insertReminder(db, { chatId: 111, userId: 7, text: 'ping', triggerAt: '2000-01-01 00:00:00', cronExpr: null, ...r });
  const row = (id: number) => fetchReminder(db, id);
  const lines = () => log.records.filter((r) => r.name === 'tars.reminder').map((r) => `${r.level} ${r.msg}`);
  const submitted = (n: number) => until(() => engine.submitted.length >= n && engine.submitted);
  /** The hooks of the first reminder submitted. */
  const hooks = async () => (await submitted(1))[0]?.hooks ?? {};
  return { db, log, engine, loop, add, row, lines, submitted, hooks };
}

describe('reminder loop: firing', () => {
  // envelopes as the golden fixture pins them
  it('submits each due reminder as a synthetic message carrying the raw <reminder> envelope', async () => {
    const t = setup();
    const golden = loadGolden<{ reminder: { id: number; chat_id: number; user_id: number; text: string; envelope: string }[] }>('envelope.json').reminder;
    for (const g of golden) expect(t.add({ chatId: g.chat_id, userId: g.user_id, text: g.text })).toBe(g.id);
    t.loop.start();
    const submitted = await t.submitted(golden.length);
    expect(submitted.map(({ msg }) => msg.text)).toEqual(golden.map((g) => g.envelope));
    const msg = submitted[2]?.msg;
    expect(msg).toEqual({ chatId: -1001, messageId: 0, userId: 5, direction: 'in', timestamp: expect.any(Date) as unknown, text: golden[2]?.envelope });
    expect(Date.now() - (msg?.timestamp.getTime() ?? 0)).toBeLessThan(5_000);
  });

  // claimed rows are not fired twice; firing order follows trigger time
  it('claims what it fires, so later polls skip it', async () => {
    const t = setup();
    const later = t.add({ triggerAt: '2001-01-01 00:00:00' });
    const sooner = t.add({ triggerAt: '2000-01-01 00:00:00' });
    t.add({ triggerAt: '2999-01-01 00:00:00' });
    t.loop.start();
    await t.submitted(2);
    await until(() => t.lines().filter((l) => l.includes('no due reminders')).length >= 2);
    expect(t.engine.submitted.map(({ msg }) => msg.text)).toEqual([sooner, later].map((id) => `<reminder id="${id}" chat_id="111" user_id="7">ping</reminder>`));
    expect([t.row(sooner)?.status, t.row(later)?.status]).toEqual(['processing', 'processing']);
    expect(t.lines()).toEqual(
      expect.arrayContaining(['INFO reminder loop: 2 due', `INFO firing reminder #${sooner} (chat=111)`, `INFO queued reminder #${sooner}`, 'DEBUG reminder loop: no due reminders']),
    );
  });

  // a row another poller won meanwhile is skipped (yet still logged as queued)
  it('skips a reminder whose claim was lost', async () => {
    const t = setup();
    const [first, second] = [t.add(), t.add()];
    t.engine.onSubmit = () => claimReminder(t.db, second);
    t.loop.start();
    await until(() => t.lines().includes(`INFO reminder #${second} already claimed; skipping`));
    expect(t.engine.submitted.map(({ msg }) => msg.text)).toEqual([`<reminder id="${first}" chat_id="111" user_id="7">ping</reminder>`]);
    expect(t.lines()).toContain(`INFO queued reminder #${second}`);
  });

  // success: a one-shot closes
  it('closes a delivered one-shot', async () => {
    const t = setup();
    const id = t.add();
    t.loop.start();
    const hooks = await t.hooks();
    await hooks.onSuccess?.();
    expect(t.row(id)?.status).toBe('sent');
    expect(t.lines()).toContain(`INFO delivered reminder #${id}`);
  });

  // success: a recurring row waits for the slot after now (missed slots collapse)
  it('advances a delivered recurring reminder to its next slot after now', async () => {
    const t = setup();
    const id = t.add({ cronExpr: '0 0 * * *' });
    t.loop.start();
    const hooks = await t.hooks();
    await hooks.onSuccess?.();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(t.row(id)).toMatchObject({ status: 'pending', trigger_at: `${tomorrow} 00:00:00` });
  });

  // failure: the claim is released and the next poll fires it again
  it('re-arms a reminder whose turn failed', async () => {
    const t = setup();
    const id = t.add();
    t.loop.start();
    const hooks = await t.hooks();
    await hooks.onFailure?.();
    expect(t.lines()).toContain(`INFO reverted reminder #${id} after failed delivery`);
    await t.submitted(2);
  });

  // a cron that never fires again: the hook rejects (the engine logs it), the row stays claimed
  it('leaves the row claimed when the next slot can\'t be computed', async () => {
    const t = setup();
    const id = t.add({ cronExpr: '0 6 31 2 *' });
    t.loop.start();
    const hooks = await t.hooks();
    await expect(hooks.onSuccess?.()).rejects.toThrow('failed to find next date for cron expression "0 6 31 2 *"');
    expect(t.row(id)?.status).toBe('processing');
  });
});

describe('reminder loop: failures and lifecycle', () => {
  // a submit that throws releases the claim; one bad row doesn't stop the rest
  it('releases the claim when the engine refuses the message, and goes on', async () => {
    const t = setup();
    const first = t.add();
    t.engine.fail = true;
    t.loop.start();
    await until(() => t.lines().includes(`ERROR failed to fire reminder #${first}`));
    expect(t.row(first)?.status).toBe('pending');
    expect(t.log.records.find((r) => r.msg === `failed to fire reminder #${first}`)?.err).toEqual(new Error('engine is gone'));
    t.engine.fail = false;
    await t.submitted(1);
  });

  // a failed poll is logged and retried on the next tick
  it('logs a failed poll and keeps going', async () => {
    const t = setup();
    t.db.close();
    t.loop.start();
    await until(() => t.lines().filter((l) => l === 'ERROR reminder loop: fetching due reminders failed').length >= 2);
  });

  // the first poll comes a full interval after start; stop() cancels the wait (no timer left behind)
  it('sleeps before polling, and stops promptly', async () => {
    const t = setup(60_000);
    t.add();
    t.loop.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = performance.now();
    await t.loop.stop();
    expect(performance.now() - started).toBeLessThan(100);
    expect(t.engine.submitted).toEqual([]);
    expect(t.lines()).toEqual([]);
  });
});

describe('reminder loop with the engine', () => {
  class FakeWorker implements EngineWorker {
    readonly sent: string[] = [];
    readonly injected: string[] = [];
    send(text: string) {
      this.sent.push(text);
      return Promise.resolve();
    }
    inject(text: string) {
      this.injected.push(text);
      return Promise.resolve(true);
    }
    resetSession() {
      return Promise.resolve();
    }
  }

  function withEngine() {
    const t = setup();
    const worker = new FakeWorker();
    const typing = new TypingIndicator(() => Promise.resolve(), t.log);
    const engine = new Engine({ worker, db: t.db, debounceMs: 0, typing, log: t.log.child('engine'), notify: () => Promise.resolve() });
    running.push(engine);
    const loop = new ReminderLoop({ db: t.db, engine, log: t.log.child('reminder'), intervalMs: 5 });
    running.push(loop);
    return { ...t, worker, engine, loop };
  }

  const end = (overrides: Partial<TurnResult> = {}): TurnResult => ({
    textBlocks: [],
    stderrTail: [],
    userVisibleAction: true,
    droppedText: false,
    control: { action: 'stop', reason: 'done' },
    ...overrides,
  });

  // the row is committed only once Claude Code has finished the turn
  it('advances a recurring reminder after a clean turn and re-arms it after a crash', async () => {
    const t = withEngine();
    const daily = t.add({ cronExpr: '0 0 * * *', text: 'digest' });
    t.loop.start();
    await until(() => t.worker.sent.length === 1);
    expect(t.worker.sent[0]).toBe(`<reminder id="${daily}" chat_id="111" user_id="7">digest</reminder>`);
    expect(t.row(daily)?.status).toBe('processing');
    t.engine.onResult(end());
    await until(() => t.row(daily)?.status === 'pending');
    expect((t.row(daily)?.trigger_at ?? '') > sqliteTime(new Date())).toBe(true);

    const once = t.add({ text: 'call mom' });
    await until(() => t.worker.sent.length === 2);
    t.engine.onResult(end({ abortedReason: 'crash', control: undefined }));
    await until(() => t.lines().includes(`INFO reverted reminder #${once} after failed delivery`));
    await until(() => t.worker.sent.length === 3);
    t.engine.onResult(end({ droppedText: true, textBlocks: ['said it'], userVisibleAction: false }));
    await until(() => t.row(once)?.status === 'sent');
  });

  // a reminder due while a turn runs (or while /pause is on) is injected into that turn
  it('injects a reminder into the turn already running', async () => {
    const t = withEngine();
    await t.engine.submit({ chatId: 111, messageId: 5, userId: 111, direction: 'in', timestamp: new Date(), text: 'hello' });
    await until(() => t.worker.sent.length === 1);
    const id = t.add({ text: 'stand up' });
    t.loop.start();
    await until(() => t.worker.injected.length === 1);
    expect(t.worker.injected[0]).toBe(`<reminder id="${id}" chat_id="111" user_id="7">stand up</reminder>`);
    t.engine.onResult(end());
    await until(() => t.row(id)?.status === 'sent');
  });
});

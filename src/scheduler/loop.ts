import { setTimeout as sleep } from 'node:timers/promises';

import { type Db, sqliteTime } from '../db/database.ts';
import { advanceRecurringReminder, claimReminder, fetchDueReminders, markReminderSent, type ReminderRow, revertReminder } from '../db/reminders.ts';
import type { TurnHooks } from '../engine/engine.ts';
import type { Logger } from '../log/logger.ts';
import type { ChatMessage } from '../message.ts';
import { nextFire } from './cron.ts';

/** Where due reminders go: the engine. */
export interface ReminderTarget {
  submit(msg: ChatMessage, hooks: TurnHooks): Promise<void>;
}

export interface ReminderLoopOptions {
  db: Db;
  engine: ReminderTarget;
  log: Logger;
  /** Poll period; a minute in production. */
  intervalMs?: number;
}

/**
 * Fires due reminders. Every minute (sleeping first) it claims each due row
 * (pending → processing) and hands it to the engine as a synthetic message
 * (`message_id` 0) whose text is the trusted `<reminder>` envelope. When the
 * turn that consumed it ends, the engine's hooks close a one-shot or advance
 * a recurring row (success), or re-arm the claim (failure). A row whose
 * hooks never run stays `processing` until the next boot re-arms it.
 */
export class ReminderLoop {
  private readonly o: ReminderLoopOptions;
  private readonly abort = new AbortController();
  private running: Promise<void> = Promise.resolve();

  constructor(options: ReminderLoopOptions) {
    this.o = options;
  }

  start(): void {
    this.running = this.run(this.abort.signal);
  }

  /** Stops polling; a reminder already handed to the engine stays with it. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }

  private async run(signal: AbortSignal): Promise<void> {
    // stop() aborts the sleep, which ends the loop.
    while (await sleep(this.o.intervalMs ?? 60_000, true, { signal }).catch(() => false)) await this.poll(signal);
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const log = this.o.log;
    let due: ReminderRow[];
    try {
      due = fetchDueReminders(this.o.db, sqliteTime(new Date()));
    } catch (err) {
      log.error('reminder loop: fetching due reminders failed', { err });
      return;
    }
    if (!due.length) {
      log.debug('reminder loop: no due reminders');
      return;
    }
    log.info(`reminder loop: ${due.length} due`);
    for (const row of due) {
      if (signal.aborted) return;
      try {
        log.info(`firing reminder #${row.id} (chat=${row.chat_id})`);
        await this.fire(row);
        log.info(`queued reminder #${row.id}`);
      } catch (err) {
        log.error(`failed to fire reminder #${row.id}`, { err });
      }
    }
  }

  private async fire(row: ReminderRow): Promise<void> {
    const { db, log } = this.o;
    if (!claimReminder(db, row.id)) {
      log.info(`reminder #${row.id} already claimed; skipping`);
      return;
    }
    const msg: ChatMessage = {
      chatId: row.chat_id,
      messageId: 0,
      userId: row.user_id,
      direction: 'in',
      timestamp: new Date(),
      // Raw on purpose: seeded reminders carry `<skill …>` markup the model trusts only here.
      text: `<reminder id="${row.id}" chat_id="${row.chat_id}" user_id="${row.user_id}">${row.text}</reminder>`,
    };
    // The hooks run on a promise so a throw (a cron that never fires again) reaches the engine as a rejection it logs.
    const hooks: TurnHooks = {
      onSuccess: () => Promise.resolve().then(() => this.delivered(row)),
      onFailure: () => Promise.resolve().then(() => this.reverted(row)),
    };
    try {
      await this.o.engine.submit(msg, hooks);
    } catch (err) {
      revertReminder(db, row.id); // the hooks never registered, so release the claim here
      throw err;
    }
  }

  private delivered(row: ReminderRow): void {
    if (row.cron_expr) advanceRecurringReminder(this.o.db, row.id, nextFire(row.cron_expr, new Date()));
    else markReminderSent(this.o.db, row.id);
    this.o.log.info(`delivered reminder #${row.id}`);
  }

  private reverted(row: ReminderRow): void {
    revertReminder(this.o.db, row.id);
    this.o.log.info(`reverted reminder #${row.id} after failed delivery`);
  }
}

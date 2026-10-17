import type { Logger } from '../log/logger.ts';

/** Telegram shows "typing…" for ~5 s per call; refresh at that pace. */
const REFRESH_MS = 5000;
/** Keep the indicator up at least this long so a fast reply doesn't flicker it away. */
const MIN_VISIBLE_MS = 1000;

/**
 * The "typing…" indicator for every chat waiting on the current turn: shown
 * as soon as a message arrives, refreshed every 5 s, and dropped per chat
 * the moment that chat's reply is delivered (or when the turn ends).
 */
export class TypingIndicator {
  private chats = new Set<number>();
  private startedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly deferred = new Map<number, NodeJS.Timeout>();
  private readonly send: (chatId: number) => Promise<void>;
  private readonly log: Logger;

  /** `send` shows the indicator once and never throws. */
  constructor(send: (chatId: number) => Promise<void>, log: Logger) {
    this.send = send;
    this.log = log;
  }

  /** A message just arrived: show typing right away, before debounce and formatting. */
  prime(chatId: number): void {
    if (!this.chats.size) this.startedAt = performance.now();
    if (!this.chats.has(chatId)) {
      this.chats.add(chatId);
      void this.send(chatId);
    }
    this.ensureLoop();
  }

  /** A turn (or its continuation) starts for these chats. */
  async start(chats: ReadonlySet<number>): Promise<void> {
    const shown = chats.size ? `{${[...chats].sort((a, b) => a - b).join(', ')}}` : 'set()';
    this.log.info(`start_typing called: chats=${shown} task_state=${this.timer ? 'running' : 'none'}`);
    if (!chats.size) return;
    if (this.timer) {
      const fresh = [...chats].filter((c) => !this.chats.has(c));
      fresh.forEach((c) => this.chats.add(c));
      await Promise.all(fresh.map((c) => this.send(c)));
      return;
    }
    this.chats = new Set(chats);
    this.startedAt = performance.now();
    for (const chatId of chats) {
      await this.send(chatId);
      this.log.info(`typing fired for chat ${chatId}`);
    }
    this.ensureLoop();
  }

  /** A chat got its reply: stop its indicator, but not before it was visible for a second. */
  replied(chatId: number): void {
    if (!this.chats.has(chatId)) return;
    const remaining = MIN_VISIBLE_MS - (performance.now() - this.startedAt);
    if (remaining <= 0) return this.remove(chatId);
    clearTimeout(this.deferred.get(chatId));
    this.deferred.set(chatId, setTimeout(() => this.remove(chatId), remaining));
  }

  stop(): void {
    this.chats.clear();
    this.deferred.forEach((timer) => clearTimeout(timer));
    this.deferred.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private remove(chatId: number): void {
    this.chats.delete(chatId);
    clearInterval(this.timer);
    this.timer = undefined;
    // The remaining chats are refreshed right away, then on the usual pace.
    this.refresh();
    this.ensureLoop();
  }

  private ensureLoop(): void {
    if (!this.timer && this.chats.size) this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  private refresh(): void {
    for (const chatId of this.chats) void this.send(chatId);
  }
}

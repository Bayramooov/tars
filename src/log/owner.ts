import { clip } from '../text/clip.ts';
import { escapeHtml } from '../text/html.ts';
import { LEVELS, type LogRecord, type LogSink } from './logger.ts';
import { errorText } from './sinks.ts';

/** An owner DM is a message, not a log dump. */
const MAX_BODY = 1200;
/** Identical messages within this window are sent once. */
const COOLDOWN_MS = 60_000;
/** Stay safely under Telegram's 4096-character limit, cause links included. */
const MAX_DM = 4000;

/**
 * Turns every ERROR-or-worse log record into an owner DM — one path for all
 * operator alerts — with a reference to the message the current turn was
 * answering. Records logged while a DM is being sent are dropped, so a
 * failing send can't cascade into more DMs.
 */
export class OwnerNotifier {
  private readonly lastSent = new Map<string, number>();
  private sending: Promise<void> | undefined;
  private readonly send: (html: string) => Promise<void>;
  private readonly causeLinks: () => string;

  constructor(send: (html: string) => Promise<void>, causeLinks: () => string) {
    this.send = send;
    this.causeLinks = causeLinks;
  }

  readonly sink: LogSink = (record) => {
    if (LEVELS[record.level] < LEVELS.ERROR || this.sending) return;
    const text = this.withCause(formatRecord(record));
    const now = record.time.getTime();
    for (const [msg, at] of this.lastSent) if (now - at >= COOLDOWN_MS) this.lastSent.delete(msg);
    if (this.lastSent.has(text)) return;
    this.lastSent.set(text, now);
    this.sending = this.send(text).finally(() => (this.sending = undefined));
  };

  /** Wait for an in-flight DM (e.g. the give-up alert before exiting). */
  async flush(): Promise<void> {
    await this.sending;
  }

  private withCause(text: string): string {
    const refs = this.causeLinks();
    const combined = refs ? `${text}\n\n${refs}` : text;
    return clip(combined, MAX_DM - 1);
  }
}

/** `⚠️ ERROR — logger\nmessage[\n\ntraceback]`, cut to 1200 characters, HTML-escaped. */
export function formatRecord(record: LogRecord): string {
  const icon = LEVELS[record.level] >= LEVELS.CRITICAL ? '🔴' : '⚠️';
  let body = `${icon} ${record.level} — ${record.name}\n${record.msg}`;
  if (record.err !== undefined) body = `${body}\n\n${errorText(record.err)}`;
  return escapeHtml(clip(body, MAX_BODY));
}

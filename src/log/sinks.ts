import type { LogRecord, LogSink } from './logger.ts';
import type { DailyFile } from './daily.ts';

/** Console line: `HH:MM:SS LEVEL logger-name message` (local time), as `docker logs` showed it. */
export function formatConsole(record: LogRecord): string {
  const t = record.time;
  const clock = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const line = `${clock} ${record.level.padEnd(5)} ${record.name.padEnd(22)} ${record.msg}`;
  return record.err === undefined ? line : `${line}\n${errorText(record.err)}`;
}

/**
 * One JSON object per line, the schema `/logs` reads: `ts` (UTC ISO),
 * `level`, `logger`, `msg`, and `event` / `data` / `exc` when present.
 */
export function formatJson(record: LogRecord): string {
  const payload: Record<string, unknown> = { ts: record.time.toISOString(), level: record.level, logger: record.name, msg: record.msg };
  if (record.event !== undefined) payload.event = record.event;
  if (record.data !== undefined) payload.data = record.data;
  if (record.err !== undefined) payload.exc = errorText(record.err);
  return JSON.stringify(payload);
}

/** Stack (or message) of a thrown value. */
export const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

export const consoleSink: LogSink = (record) => {
  process.stderr.write(`${formatConsole(record)}\n`);
};

export const fileSink =
  (file: DailyFile): LogSink =>
  (record) => {
    file.write(`${formatJson(record)}\n`);
  };

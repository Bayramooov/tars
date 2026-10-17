import { existsSync, readFileSync } from 'node:fs';

import { chunkText, TELEGRAM_TEXT_LIMIT } from '../../text/chunk.ts';
import { escapeHtml } from '../../text/html.ts';
import { asText } from '../../text/json.ts';

/** What one message holds once wrapped in `<blockquote></blockquote>`. */
const BUDGET = TELEGRAM_TEXT_LIMIT - '<blockquote></blockquote>'.length;

/**
 * `/logs` replies, as HTML blockquotes of `HH:MM:SS LEVEL logger | msg`
 * lines; empty when there is no log yet. Bare `/logs`: the newest that fits
 * one message, from a line start. `/logs N`: the last N lines (1–200; not a
 * number → 50) in as many messages as needed.
 */
export function logQuotes(path: string, args: string[]): string[] {
  const [arg] = args;
  const lines = tailLog(path, arg === undefined ? 200 : lineCount(arg));
  if (!lines.length) return [];
  const body = escapeHtml(lines.map(fmtLogLine).join('\n'));
  const chunks = arg === undefined ? [tailChars(body, BUDGET)] : chunkText(body, BUDGET);
  return chunks.map((chunk) => `<blockquote>${chunk}</blockquote>`);
}

function lineCount(arg: string): number {
  return /^\d+$/.test(arg) ? Math.max(1, Math.min(Number(arg), 200)) : 50;
}

/** The last `n` lines of the current log file; CR and CRLF end lines too. */
function tailLog(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n);
}

/** One JSON log record as `HH:MM:SS LEVEL logger | msg`; any other line verbatim. */
function fmtLogLine(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw;
  const record = parsed as Record<string, unknown>;
  const field = (key: string) => (Object.hasOwn(record, key) ? asText(record[key]) : '');
  // The clock part of the stored UTC `ts` (`…T10:31:00.000Z`).
  const clock = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(field('ts'))?.[1] ?? field('ts');
  return `${clock} ${field('level')} ${field('logger')} | ${field('msg')}`;
}

/** The newest `limit` UTF-16 units from a line start (or past a split surrogate pair when no line break fits). */
function tailChars(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const clipped = text.slice(-limit);
  const newline = clipped.indexOf('\n');
  if (newline !== -1) return clipped.slice(newline + 1);
  return /^[\uDC00-\uDFFF]/.test(clipped) ? clipped.slice(1) : clipped;
}

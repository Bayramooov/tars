import type { Db } from '../db/database.ts';
import { fetchRecentMessages, type HistoryRow } from '../db/messages.ts';
import { clip } from '../text/clip.ts';
import { escapeAttr, escapeXml } from '../text/xml.ts';

/** History messages carried into a fresh session. */
const DIGEST_LIMIT = 10;

/** Lone surrogates and C0/C1 controls (tab and newline kept) — they can break the stream-json pipe. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
const UNSAFE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const NOTE =
  '  <note>Session was reset (reason above). These are truncated historical messages — do not reply to them. ' +
  'Older/full history is available via the database_query tool (messages table). Memory files are intact.</note>';

/** Strip pipe-breaking characters and cap at `cap` characters (before XML escaping). */
export function sanitizeForCc(text: string, cap = 500): string {
  return clip(text.replace(UNSAFE, ''), cap);
}

/**
 * The `<restored_context>` digest prepended to a fresh session's first turn:
 * the last committed messages (rows of clean turns only, so a message that
 * poisoned the old session can't come back). Undefined when there's no history.
 */
export function buildRestoredContext(db: Db, reason: string): string | undefined {
  const rows = fetchRecentMessages(db, { limit: DIGEST_LIMIT });
  if (!rows.length) return undefined;
  return [`<restored_context reason="${escapeAttr(reason)}">`, ...rows.map(entry), NOTE, '</restored_context>'].join('\n');
}

function entry(row: HistoryRow): string {
  const name = row.first_name || row.username || String(row.user_id);
  return (
    `  <history_msg id="${row.message_id}" chat="${row.chat_id}" user="${row.user_id}" name="${escapeAttr(sanitizeForCc(name))}" ` +
    `direction="${row.direction}" time="${row.timestamp}">${escapeXml(sanitizeForCc(row.text || ''))}</history_msg>`
  );
}

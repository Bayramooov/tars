import type { ChatMessage } from '../message.ts';
import { type Db, sqliteTime } from './database.ts';

/** Telegram ids are unique per chat only, so a message key is always the pair. */
export type MessageKey = readonly [chatId: number, messageId: number];

interface MessageRow {
  chat_id: number;
  message_id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  direction: 'in' | 'out';
  timestamp: string;
  text: string;
  reply_to_id: number | null;
  reply_to_text: string | null;
  raw_update_json?: string | null;
}

/** A history row as the envelope and digests render it. */
export type HistoryRow = Pick<MessageRow, 'chat_id' | 'message_id' | 'user_id' | 'username' | 'first_name' | 'direction' | 'timestamp' | 'text'>;

/** A reply-chain parent (always from the chat being rendered). */
export type ChainRow = Omit<HistoryRow, 'chat_id'>;

/**
 * Idempotent insert. An edit re-fires with the same id and refreshes the row
 * while leaving the `edited`/`deleted`/`consumed`/`processed` flags alone.
 */
export function insertMessage(db: Db, msg: ChatMessage): void {
  db.prepare(
    `INSERT INTO messages (chat_id, message_id, user_id, username, first_name, direction, timestamp, text,
       reply_to_id, reply_to_text, raw_update_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET
       user_id=excluded.user_id, username=excluded.username, first_name=excluded.first_name,
       direction=excluded.direction, timestamp=excluded.timestamp, text=excluded.text,
       reply_to_id=excluded.reply_to_id, reply_to_text=excluded.reply_to_text,
       raw_update_json=excluded.raw_update_json`,
  ).run(
    msg.chatId, msg.messageId, msg.userId, msg.username ?? null, msg.firstName ?? null, msg.direction,
    sqliteTime(msg.timestamp), msg.text, msg.replyToId ?? null, msg.replyToText ?? null, msg.rawUpdateJson ?? null,
  );
}

/** New text, `edited=1`, and the trust flag reset: edited content must re-earn `processed`. */
export function markEdited(db: Db, [chatId, messageId]: MessageKey, text: string): void {
  db.prepare('UPDATE messages SET text=?, edited=1, processed=0 WHERE chat_id=? AND message_id=?').run(text, chatId, messageId);
}

export function markDeleted(db: Db, [chatId, messageId]: MessageKey): void {
  db.prepare('UPDATE messages SET deleted=1 WHERE chat_id=? AND message_id=?').run(chatId, messageId);
}

/** Rows handed to Claude Code; unconsumed inbound rows replay on the next boot. */
export const markConsumed = (db: Db, keys: readonly MessageKey[]) => setFlag(db, 'consumed', keys);

/** Rows of a cleanly finished turn — the only ones a restored-context digest may quote. */
export const markProcessed = (db: Db, keys: readonly MessageKey[]) => setFlag(db, 'processed', keys);

function setFlag(db: Db, column: 'consumed' | 'processed', keys: readonly MessageKey[]): void {
  if (!keys.length) return;
  const rows = keys.map(() => '(?,?)').join(',');
  db.prepare(`UPDATE messages SET ${column}=1 WHERE (chat_id, message_id) IN (VALUES ${rows})`).run(keys.flat());
}

/**
 * Inbound messages buffered but never handed to Claude Code, from the last
 * 24 hours, oldest first; older ones are settled instead so days-old
 * questions don't get a surprise reply. The forum topic is recovered from
 * the stored update so the replayed reply lands in the right topic.
 */
export function takeUnconsumedInbound(db: Db): ChatMessage[] {
  const recent = "direction='in' AND consumed=0 AND timestamp > datetime('now', '-24 hours')";
  const rows = db
    .prepare(`SELECT chat_id, message_id, user_id, username, first_name, direction, timestamp, text, reply_to_id, reply_to_text,
              raw_update_json FROM messages WHERE ${recent} AND message_id > 0 ORDER BY rowid`)
    .all() as MessageRow[];
  db.prepare("UPDATE messages SET consumed=1 WHERE direction='in' AND consumed=0 AND timestamp <= datetime('now', '-24 hours')").run();
  return rows.map((row) => ({ ...toChatMessage(row), messageThreadId: topicOf(row.raw_update_json) }));
}

export interface RecentQuery {
  limit: number;
  includeUnprocessed?: boolean;
  chatId?: number | undefined;
  beforeMessageId?: number | undefined;
}

/**
 * Most recent real messages (no deleted or synthetic rows), oldest first.
 * Unless `includeUnprocessed`, inbound rows of unfinished turns are skipped;
 * outbound rows always count — Telegram confirmed their delivery.
 */
export function fetchRecentMessages(db: Db, query: RecentQuery): HistoryRow[] {
  const where = ['message_id > 0', 'deleted = 0'];
  const params: number[] = [];
  if (!query.includeUnprocessed) where.push("NOT (direction = 'in' AND processed = 0)");
  if (query.chatId !== undefined) {
    where.push('chat_id = ?');
    params.push(query.chatId);
  }
  if (query.beforeMessageId !== undefined) {
    where.push('message_id < ?');
    params.push(query.beforeMessageId);
  }
  const rows = db
    .prepare(`SELECT chat_id, message_id, user_id, username, first_name, direction, timestamp, text FROM messages
              WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
    .all(...params, query.limit) as HistoryRow[];
  return rows.reverse();
}

/**
 * Walk a reply chain back through our own table, at most `maxDepth` hops,
 * stopping at a root, a missing row, or a cycle. Oldest first.
 */
export function fetchReplyChain(db: Db, chatId: number, replyToId: number, maxDepth = 3): ChainRow[] {
  const select = db.prepare(
    'SELECT message_id, user_id, username, first_name, direction, timestamp, text, reply_to_id FROM messages WHERE chat_id = ? AND message_id = ?',
  );
  const chain: ChainRow[] = [];
  const seen = new Set<number>();
  let cursor: number | null = replyToId;
  for (let hop = 0; hop < maxDepth && cursor !== null && !seen.has(cursor); hop++) {
    seen.add(cursor);
    const row = select.get(chatId, cursor) as (ChainRow & { reply_to_id: number | null }) | undefined;
    if (!row) break;
    const { reply_to_id: parent, ...entry } = row;
    chain.push(entry);
    cursor = parent;
  }
  return chain.reverse();
}

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    userId: row.user_id,
    username: row.username ?? undefined,
    firstName: row.first_name ?? undefined,
    direction: row.direction,
    timestamp: new Date(`${row.timestamp.replace(' ', 'T')}Z`),
    text: row.text,
    replyToId: row.reply_to_id ?? undefined,
    replyToText: row.reply_to_text ?? undefined,
  };
}

/** `message_thread_id` of a stored forum-topic update, if it was one. */
function topicOf(rawUpdateJson: string | null | undefined): number | undefined {
  try {
    const message = (JSON.parse(rawUpdateJson ?? 'null') as { message?: { is_topic_message?: boolean; message_thread_id?: number } } | null)?.message;
    return message?.is_topic_message ? message.message_thread_id : undefined;
  } catch {
    return undefined;
  }
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Db, openDatabase } from '../../src/db/database.ts';
import {
  fetchRecentMessages, fetchReplyChain, insertMessage, markConsumed, markDeleted, markEdited, markProcessed, takeUnconsumedInbound,
} from '../../src/db/messages.ts';
import type { ChatMessage } from '../../src/message.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const open = () => openDatabase(join(tempDir(), 'data', 'tars.db'), memoryLogger());
const at = (iso: string) => new Date(iso);

function msg(messageId: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { chatId: 111, messageId, userId: 111, firstName: 'Ali', direction: 'in', timestamp: at('2026-10-17T08:00:00Z'), text: `m${messageId}`, ...extra };
}
const row = (db: Db, messageId: number, chatId = 111) =>
  db.prepare('SELECT rowid, * FROM messages WHERE chat_id=? AND message_id=?').get(chatId, messageId) as Record<string, unknown>;

describe('opening the database', () => {
  it('creates the file and its directories, in WAL mode with a 5 s busy timeout', () => {
    const path = join(tempDir(), 'nested', 'data', 'tars.db');
    const db = openDatabase(path, memoryLogger());
    expect(existsSync(path)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('applies nothing when reopened', () => {
    const path = join(tempDir(), 'tars.db');
    openDatabase(path, memoryLogger()).close();
    const log = memoryLogger();
    openDatabase(path, log);
    expect(log.records).toEqual([]);
  });

  it('rejects a direction other than in/out', () => {
    expect(() => insertMessage(open(), msg(1, { direction: 'sideways' as 'in' }))).toThrow(/CHECK constraint/);
  });
});

describe('messages', () => {
  it('upserts by (chat, message), refreshing content but keeping flags and insertion order', () => {
    const db = open();
    insertMessage(db, msg(1, { timestamp: at('2026-10-17T08:00:00.987Z'), replyToId: 9, replyToText: 'q', rawUpdateJson: '{}' }));
    expect(row(db, 1)).toMatchObject({ timestamp: '2026-10-17 08:00:00', edited: 0, deleted: 0, reactions: null, consumed: 0, processed: 0 });
    markConsumed(db, [[111, 1]]);
    markProcessed(db, [[111, 1]]);
    const { rowid } = row(db, 1);
    insertMessage(db, msg(1, { text: 'again', username: 'ali' }));
    expect(row(db, 1)).toMatchObject({ rowid, text: 'again', username: 'ali', reply_to_id: null, raw_update_json: null, consumed: 1, processed: 1 });
  });

  it('marks edits (re-earning trust) and soft-deletes', () => {
    const db = open();
    insertMessage(db, msg(1));
    markConsumed(db, [[111, 1]]);
    markProcessed(db, [[111, 1]]);
    markEdited(db, [111, 1], 'fixed');
    expect(row(db, 1)).toMatchObject({ text: 'fixed', edited: 1, processed: 0, consumed: 1, timestamp: '2026-10-17 08:00:00' });
    markEdited(db, [111, 404], 'nothing');
    markDeleted(db, [111, 1]);
    expect(row(db, 1)).toMatchObject({ deleted: 1 });
  });

  it('flags only the given keys, and an empty list is a no-op', () => {
    const db = open();
    for (const id of [1, 2, 3]) insertMessage(db, msg(id));
    insertMessage(db, msg(1, { chatId: 222 }));
    markConsumed(db, []);
    markConsumed(db, [[111, 1], [111, 3]]);
    markProcessed(db, [[111, 3]]);
    const flags = db.prepare('SELECT chat_id, message_id, consumed, processed FROM messages ORDER BY rowid').raw().all();
    expect(flags).toEqual([[111, 1, 1, 0], [111, 2, 0, 0], [111, 3, 1, 1], [222, 1, 0, 0]]);
  });
});

describe('history queries', () => {
  it('returns the newest eligible rows oldest-first, by insertion order', () => {
    const db = open();
    insertMessage(db, msg(5, { text: 'inserted first' }));
    insertMessage(db, msg(2, { text: 'unprocessed inbound' }));
    insertMessage(db, msg(3, { direction: 'out', userId: 999, text: 'bot reply' }));
    insertMessage(db, msg(0, { text: 'synthetic' }));
    insertMessage(db, msg(4, { text: 'deleted' }));
    insertMessage(db, msg(6, { chatId: 222, text: 'other chat' }));
    markProcessed(db, [[111, 5], [111, 4], [111, 0], [222, 6]]);
    markDeleted(db, [111, 4]);
    const texts = (rows: { text: string }[]) => rows.map((r) => r.text);
    expect(texts(fetchRecentMessages(db, { limit: 10 }))).toEqual(['inserted first', 'bot reply', 'other chat']);
    expect(texts(fetchRecentMessages(db, { limit: 2 }))).toEqual(['bot reply', 'other chat']);
    expect(texts(fetchRecentMessages(db, { limit: 10, includeUnprocessed: true, chatId: 111 }))).toEqual(['inserted first', 'unprocessed inbound', 'bot reply']);
    expect(texts(fetchRecentMessages(db, { limit: 10, chatId: 111, beforeMessageId: 5 }))).toEqual(['bot reply']);
    expect(Object.keys(fetchRecentMessages(db, { limit: 1 })[0] ?? {})).toEqual(['chat_id', 'message_id', 'user_id', 'username', 'first_name', 'direction', 'timestamp', 'text']);
  });

  it('walks a reply chain up to three hops, stopping at roots, gaps and cycles', () => {
    const db = open();
    insertMessage(db, msg(1));
    for (const id of [2, 3, 4, 5]) insertMessage(db, msg(id, { replyToId: id - 1 }));
    expect(fetchReplyChain(db, 111, 5).map((r) => r.message_id)).toEqual([3, 4, 5]);
    expect(fetchReplyChain(db, 111, 2).map((r) => r.message_id)).toEqual([1, 2]);
    expect(fetchReplyChain(db, 111, 99)).toEqual([]);
    insertMessage(db, msg(7, { replyToId: 8 }));
    insertMessage(db, msg(8, { replyToId: 7 }));
    expect(fetchReplyChain(db, 111, 8, 10).map((r) => r.message_id)).toEqual([7, 8]);
    expect(Object.keys(fetchReplyChain(db, 111, 1)[0] ?? {})).toEqual(['message_id', 'user_id', 'username', 'first_name', 'direction', 'timestamp', 'text']);
  });
});

describe('boot replay', () => {
  it('hands back recent unconsumed inbound rows and settles older ones', () => {
    const db = open();
    const now = Date.now();
    insertMessage(db, msg(1, { timestamp: new Date(now - 60_000), replyToId: 7, replyToText: 'parent' }));
    insertMessage(db, msg(2, { timestamp: new Date(now - 25 * 3600_000) }));
    insertMessage(db, msg(3, { timestamp: new Date(now - 60_000), direction: 'out' }));
    insertMessage(db, msg(0, { timestamp: new Date(now - 60_000) }));
    insertMessage(db, msg(4, { timestamp: new Date(now - 60_000) }));
    markConsumed(db, [[111, 4]]);
    const replay = takeUnconsumedInbound(db);
    expect(replay).toEqual([
      expect.objectContaining({ chatId: 111, messageId: 1, direction: 'in', text: 'm1', replyToId: 7, replyToText: 'parent', messageThreadId: undefined }),
    ]);
    expect(replay[0]?.timestamp).toEqual(new Date(Math.floor((now - 60_000) / 1000) * 1000));
    expect(row(db, 2)).toMatchObject({ consumed: 1 });
    expect(row(db, 3)).toMatchObject({ consumed: 0 });
  });

  it('recovers a replayed message\'s forum topic from its stored update', () => {
    const db = open();
    const timestamp = new Date(Date.now() - 60_000);
    insertMessage(db, msg(1, { chatId: -1001234567890, timestamp, rawUpdateJson: JSON.stringify({ message: { is_topic_message: true, message_thread_id: 7 } }) }));
    insertMessage(db, msg(2, { timestamp, rawUpdateJson: JSON.stringify({ message: { message_thread_id: 3 } }) }));
    expect(takeUnconsumedInbound(db).map((m) => [m.messageId, m.messageThreadId])).toEqual([[1, 7], [2, undefined]]);
  });
});

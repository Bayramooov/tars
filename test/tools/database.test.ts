import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase, openReadOnly } from '../../src/db/database.ts';
import { insertMessage, markDeleted } from '../../src/db/messages.ts';
import { queryReadOnly, selectRows } from '../../src/db/query.ts';
import type { ChatMessage } from '../../src/message.ts';
import { databaseQueryTool, recentMessagesTool } from '../../src/tools/database.ts';
import { expectGoldenTool } from '../golden/tools.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const msg = (messageId: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  chatId: -1,
  messageId,
  userId: 42,
  direction: 'in',
  timestamp: new Date('2026-04-11T10:31:00Z'),
  text,
  ...extra,
});

/** Both tools over a fresh database; `database_query` runs in-thread here, the worker path has its own tests. */
function setup(messages: ChatMessage[] = []) {
  const path = join(tempDir(), 'h.db');
  const db = openDatabase(path, memoryLogger());
  for (const m of messages) insertMessage(db, m);
  const ro = openReadOnly(path);
  const recent = recentMessagesTool(db);
  return {
    db,
    path,
    query: databaseQueryTool((sql) => Promise.resolve(selectRows(ro, sql))),
    recent: (args: object = {}) => recent.run(recent.args.parse(args)),
    recentTool: recent,
  };
}

const REJECTED = { content: 'rejected: only single read-only SELECT statements are allowed', isError: true };
const HEADER = 'timestamp\tdirection\tmessage_id\tchat_id\tname\ttext';
const texts = (content: string) => content.split('\n').slice(1).map((line) => line.split('\t').at(-1));

describe('database_query', () => {
  it('matches the tools/list snapshot', () => {
    expectGoldenTool(setup().query);
  });

  it('returns the rows as TSV under a header line', async () => {
    const { query } = setup([msg(1, 'hi')]);
    expect(await query.run({ sql: 'SELECT direction, text FROM messages' })).toEqual({ content: 'direction\ttext\nin\thi', data: { row_count: 1 } });
  });

  it('respects a smaller LIMIT and clamps a larger one to 100 rows', async () => {
    const { query } = setup(Array.from({ length: 150 }, (_, i) => msg(i, `msg-${i}`)));
    expect((await query.run({ sql: 'SELECT text FROM messages ORDER BY message_id DESC LIMIT 2' })).data).toEqual({ row_count: 2 });
    expect((await query.run({ sql: 'SELECT text FROM messages LIMIT 120' })).data).toEqual({ row_count: 100 });
  });

  it.each([
    'SELECT 1',
    'SELECT * FROM messages',
    'SELECT chat_id, COUNT(*) FROM messages GROUP BY chat_id',
    'WITH recent AS (SELECT * FROM messages ORDER BY timestamp DESC LIMIT 5) SELECT * FROM recent',
  ])('accepts %j', async (sql) => {
    const { query } = setup([msg(1, 'hi')]);
    expect((await query.run({ sql })).isError).toBeUndefined();
  });

  it.each([
    'SELECT 1; DROP TABLE messages;',
    'INSERT INTO messages(chat_id) VALUES (1)',
    'DELETE FROM messages',
    "UPDATE messages SET text='x'",
    'PRAGMA journal_mode',
    "ATTACH DATABASE '/tmp/x' AS x",
    'DROP TABLE messages',
    'CREATE TABLE foo(x INT)',
    '',
    '   ',
    'this is not sql',
    'WITH bad AS (DELETE FROM messages RETURNING *) SELECT * FROM bad',
  ])('rejects %j', async (sql) => {
    const { query, db } = setup([msg(1, 'hi')]);
    expect(await query.run({ sql })).toEqual(REJECTED);
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });

  it("passes SQLite's error message through", async () => {
    const { query } = setup();
    expect(await query.run({ sql: 'SELECT * FROM reactions' })).toEqual({ content: 'sql error: no such table: reactions', isError: true });
  });

  it('says so when no row matches', async () => {
    const { query } = setup();
    expect(await query.run({ sql: 'SELECT * FROM messages' })).toEqual({ content: '(no rows)' });
  });

  it('reports a query that outlives its deadline', async () => {
    const { path } = setup();
    const tool = databaseQueryTool((sql) => queryReadOnly(path, sql, 50));
    const sql = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT count(*) FROM c';
    expect(await tool.run({ sql })).toEqual({ content: 'sql error: query timed out after 0.05 s', isError: true });
  });
});

describe('database_get_recent_messages', () => {
  it('matches the tools/list snapshot', () => {
    expectGoldenTool(setup().recentTool);
  });

  it('returns recent messages oldest-first under a TSV header', async () => {
    const { recent } = setup([msg(1, 'msg-1'), msg(2, 'msg-2'), msg(3, 'msg-3', { direction: 'out' })]);
    expect(await recent()).toEqual({
      content: [HEADER, '2026-04-11 10:31:00\tin\t1\t-1\t42\tmsg-1', '2026-04-11 10:31:00\tin\t2\t-1\t42\tmsg-2', '2026-04-11 10:31:00\tout\t3\t-1\t42\tmsg-3'].join('\n'),
      data: { row_count: 3 },
    });
  });

  it('names the sender by first name, else username, else id, and cuts long text', async () => {
    const { recent } = setup([msg(1, 'a', { firstName: 'Ali', username: 'ali_uz' }), msg(2, 'b', { username: 'bob' }), msg(3, '😀'.repeat(2001))]);
    const rows = (await recent()).content.split('\n').slice(1).map((line) => line.split('\t').slice(4));
    expect(rows).toEqual([['Ali', 'a'], ['bob', 'b'], ['42', `${'😀'.repeat(2000)}…[truncated]`]]);
  });

  it("includes the current turn's unprocessed inbound messages", async () => {
    const { recent } = setup([msg(1, 'live-inbound')]);
    expect((await recent()).content).toContain('live-inbound');
  });

  it('skips deleted and synthetic rows', async () => {
    const { db, recent } = setup([msg(1, 'keep-me'), msg(2, 'delete-me'), msg(0, 'synthetic-reminder')]);
    markDeleted(db, [-1, 2]);
    expect(texts((await recent()).content)).toEqual(['keep-me']);
  });

  it('clamps the limit to 1..100', async () => {
    const { recent } = setup(Array.from({ length: 150 }, (_, i) => msg(i + 1, `msg-${i + 1}`)));
    expect((await recent({ limit: 500 })).data).toEqual({ row_count: 100 });
    expect(texts((await recent({ limit: 0 })).content)).toEqual(['msg-150']);
    expect(texts((await recent({ limit: -5 })).content)).toEqual(['msg-150']);
  });

  it('restricts to one chat', async () => {
    const { recent } = setup([msg(1, 'chat-a', { chatId: 100 }), msg(1, 'chat-b', { chatId: 200 })]);
    expect(texts((await recent({ chat_id: 100 })).content)).toEqual(['chat-a']);
  });

  it('pages back with before_message_id', async () => {
    const { recent } = setup([1, 2, 3, 4, 5].map((id) => msg(id, `msg-${id}`, { chatId: 100 })));
    expect(texts((await recent({ chat_id: 100, before_message_id: 3 })).content)).toEqual(['msg-1', 'msg-2']);
  });

  it('says so when there is nothing to show', async () => {
    const { recent } = setup();
    expect(await recent()).toEqual({ content: '(no rows)' });
  });
});

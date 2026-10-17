import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { openDatabase, openReadOnly } from '../../src/db/database.ts';
import { insertMessage } from '../../src/db/messages.ts';
import { queryReadOnly, selectRows } from '../../src/db/query.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

/** A database whose chat 1 holds `texts` as messages 1..n, plus a read-only handle on it. */
function seeded(texts: string[] = ['hi']) {
  const path = join(tempDir(), 'h.db');
  const db = openDatabase(path, memoryLogger());
  texts.forEach((text, i) => insertMessage(db, { chatId: 1, messageId: i + 1, userId: 42, direction: 'in', timestamp: new Date('2026-04-11T10:31:00Z'), text }));
  return { path, ro: openReadOnly(path) };
}

const many = (n: number) => Array.from({ length: n }, (_, i) => `msg-${i + 1}`);
const SLOW = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT count(*) FROM c';

describe('selectRows', () => {
  it.each([
    'SAVEPOINT s',
    'RELEASE s',
    'COMMIT',
    'ROLLBACK',
    'ANALYZE',
    'REINDEX',
    "VACUUM INTO '/tmp/x'",
    'EXPLAIN QUERY PLAN SELECT 1',
    'INSERT INTO messages(chat_id) SELECT 1',
    'CREATE TABLE t AS SELECT 1',
    'SELECT * INTO t2 FROM messages',
    'WITH x AS (SELECT 1 AS a) INSERT INTO messages(chat_id) SELECT a FROM x RETURNING *',
    'WITH x AS (SELECT 1) DELETE FROM messages',
    '(SELECT 1)',
    '-- only a comment',
    '/* unclosed SELECT 1',
    'SELECT * FROM messages WHERE',
    "SELECT 'unterminated",
  ])('rejects %j', (sql) => {
    expect(selectRows(seeded().ro, sql)).toEqual({ rejected: true });
  });

  it('accepts a SELECT after comments, with statement-like text inside literals', () => {
    const { ro } = seeded();
    expect(selectRows(ro, "/* a */ -- b\n  select count(*) AS n FROM messages WHERE text = 'DROP TABLE x; DELETE FROM y'")).toEqual({ columns: ['n'], rows: [['0']] });
    expect(selectRows(ro, 'WITH x(a) AS (VALUES (7)) SELECT a FROM x;')).toEqual({ columns: ['a'], rows: [['7']] });
  });

  it('finds the first keyword in linear time', () => {
    const { ro } = seeded();
    const started = performance.now();
    for (const sql of [`${' '.repeat(50_000)}x`, '-- --'.repeat(10_000), `${'/* */'.repeat(10_000)}x`]) expect(selectRows(ro, sql)).toEqual({ rejected: true });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reports SQLite's own error message", () => {
    const { ro } = seeded();
    expect(selectRows(ro, 'SELECT * FROM reactions')).toEqual({ error: 'no such table: reactions' });
    expect(selectRows(ro, 'SELECT nope FROM messages')).toEqual({ error: 'no such column: nope' });
    expect(selectRows(ro, "SELECT load_extension('x')")).toEqual({ error: 'not authorized' });
  });

  it('returns at most 100 rows and keeps smaller LIMITs and OFFSETs', () => {
    const { ro } = seeded(many(150));
    const count = (sql: string) => (selectRows(ro, sql) as { rows: string[][] }).rows.length;
    expect(count('SELECT text FROM messages')).toBe(100);
    expect(count('SELECT text FROM messages LIMIT 120')).toBe(100);
    expect(count('SELECT text FROM messages LIMIT -1')).toBe(100);
    expect(count('SELECT text FROM messages LIMIT 2')).toBe(2);
    expect(count('SELECT text FROM messages LIMIT 0')).toBe(0);
    expect(selectRows(ro, 'SELECT message_id FROM messages ORDER BY message_id LIMIT 2 OFFSET 140')).toEqual({ columns: ['message_id'], rows: [['141'], ['142']] });
    // The LIMIT is not rewritten: SQLite evaluates it as written.
    expect(count("SELECT text FROM messages LIMIT '3'")).toBe(3);
    expect(selectRows(ro, 'SELECT text FROM messages LIMIT 1.5')).toEqual({ error: 'datatype mismatch' });
  });

  it('stops reading an endless result at 100 rows', () => {
    const out = selectRows(seeded().ro, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c');
    expect(out).toEqual({ columns: ['x'], rows: Array.from({ length: 100 }, (_, i) => [String(i + 1)]) });
  });

  it('renders cells as text: NULL empty, numbers as JavaScript prints them, BLOBs in hex capped at 1000 bytes', () => {
    const sql = "SELECT NULL, 9223372036854775807, 2.5, 3.0, x'00ff27', zeroblob(0), zeroblob(1001)";
    const cells = ['', '9223372036854775807', '2.5', '3', "x'00ff27'", "x''", `x'${'00'.repeat(1000)}'…[truncated]`];
    expect((selectRows(seeded().ro, sql) as { rows: string[][] }).rows).toEqual([cells]);
  });

  it('cuts text at 2000 code points, never inside a surrogate pair', () => {
    const { ro } = seeded(['😀'.repeat(2001), 'x'.repeat(2000), 'tab\tand\nnewline']);
    expect(selectRows(ro, 'SELECT text FROM messages ORDER BY message_id')).toEqual({
      columns: ['text'],
      rows: [[`${'😀'.repeat(2000)}…[truncated]`], ['x'.repeat(2000)], ['tab\tand\nnewline']],
    });
  });

  it('shows each column its own value, even under a repeated name', () => {
    expect(selectRows(seeded().ro, 'SELECT 1 AS a, 2 AS a, 3 AS A')).toEqual({ columns: ['a', 'a', 'A'], rows: [['1', '2', '3']] });
  });
});

describe('queryReadOnly', () => {
  it('runs the query in a worker thread on its own read-only connection', async () => {
    const { path } = seeded(['hi']);
    expect(await queryReadOnly(path, 'SELECT direction, text FROM messages')).toEqual({ columns: ['direction', 'text'], rows: [['in', 'hi']] });
  });

  it('gives up at the deadline and never blocks the event loop', async () => {
    const { path } = seeded();
    const slow = queryReadOnly(path, SLOW, 50);
    expect(await Promise.race([slow.then(() => 'query'), sleep(10).then(() => 'timer')])).toBe('timer');
    expect(await slow).toEqual({ error: 'query timed out after 0.05 s' });
  });

  it('rejects when the worker fails, e.g. the database file is missing', async () => {
    await expect(queryReadOnly(join(tempDir(), 'missing.db'), 'SELECT 1')).rejects.toThrow('unable to open database file');
  });
});

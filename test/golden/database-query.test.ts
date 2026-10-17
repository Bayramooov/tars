import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { insertMessage } from '../../src/db/messages.ts';
import { queryReadOnly } from '../../src/db/query.ts';
import { databaseQueryTool } from '../../src/tools/database.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';
import { loadGolden } from './load.ts';

interface Case {
  sql: string;
  is_error: boolean;
  content: string;
  data: { row_count: number } | null;
}

const golden = loadGolden<{ seed: string; cases: Case[] }>('database-query.json');

/** The seed the corpus runs on: 130 messages over chats 900..902, a 2500-char text and one with a tab and a newline. */
function seed(path: string): void {
  const db = openDatabase(path, memoryLogger());
  for (let i = 1; i <= 130; i++) {
    const text = i === 1 ? 'L'.repeat(2500) : i === 2 ? 'tab\tand\nnewline' : `ok ${i}`;
    insertMessage(db, { chatId: 900 + (i % 3), messageId: i, userId: 111, username: 'alice', firstName: 'Alice', direction: 'in', timestamp: new Date('2026-03-14T09:26:53Z'), text });
  }
}

describe('database_query (golden)', () => {
  it('answers the SQL corpus as the snapshot records', async () => {
    const path = join(tempDir(), 'dq.db');
    seed(path);
    const tool = databaseQueryTool((sql) => queryReadOnly(path, sql));
    const actual: Case[] = [];
    for (const { sql } of golden.cases) {
      const result = await tool.run({ sql });
      actual.push({ sql, is_error: result.isError ?? false, content: result.content, data: (result.data as Case['data'] | undefined) ?? null });
    }
    expect(actual).toEqual(golden.cases);
  });
});

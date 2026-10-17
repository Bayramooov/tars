import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { upsertUser } from '../../src/db/users.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

describe('users', () => {
  it('creates a per-chat row on the first message and counts the rest', () => {
    const db = openDatabase(join(tempDir(), 'tars.db'), memoryLogger());
    const base = { chatId: -100, messageId: 1, userId: 7, direction: 'in' as const, text: 'x' };
    upsertUser(db, { ...base, firstName: 'Ali', timestamp: new Date('2026-10-01T10:00:00Z') });
    upsertUser(db, { ...base, firstName: 'Ali V', username: 'ali', timestamp: new Date('2026-10-02T11:00:00Z') });
    upsertUser(db, { ...base, chatId: 7, firstName: 'Ali', timestamp: new Date('2026-10-03T12:00:00Z') });
    const rows = db.prepare('SELECT chat_id, user_id, username, first_name, join_date, last_message_date, message_count FROM users ORDER BY chat_id').raw().all();
    expect(rows).toEqual([
      [-100, 7, 'ali', 'Ali V', '2026-10-01 10:00:00', '2026-10-02 11:00:00', 2],
      [7, 7, null, 'Ali', '2026-10-03 12:00:00', '2026-10-03 12:00:00', 1],
    ]);
  });
});

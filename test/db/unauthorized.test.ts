import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { hasRefusal, insertUnauthorized } from '../../src/db/unauthorized.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

describe('unauthorized messages', () => {
  it('logs denied messages, prunes rows older than 30 days, and remembers refusals per chat', () => {
    const db = openDatabase(join(tempDir(), 'tars.db'), memoryLogger());
    const stranger = { chatId: 5, messageId: 1, userId: 5, firstName: 'Eve', direction: 'in' as const, text: 'hi' };
    insertUnauthorized(db, { ...stranger, timestamp: new Date(Date.now() - 31 * 86_400_000) }, 'private', true);
    expect(hasRefusal(db, 5)).toBe(true);
    insertUnauthorized(db, { ...stranger, messageId: 2, timestamp: new Date() }, 'private', false);
    expect(db.prepare('SELECT message_id, chat_type, refusal_sent FROM unauthorized_messages').raw().all()).toEqual([[2, 'private', 0]]);
    expect(hasRefusal(db, 5)).toBe(false);
    insertUnauthorized(db, { ...stranger, chatId: -9, messageId: 3, timestamp: new Date() }, 'group', false);
    expect(hasRefusal(db, -9)).toBe(false);
  });
});

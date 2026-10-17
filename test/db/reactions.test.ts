import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Db, openDatabase } from '../../src/db/database.ts';
import { insertMessage } from '../../src/db/messages.ts';
import { addBotReaction, applyUserReaction } from '../../src/db/reactions.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

function setup() {
  const db = openDatabase(join(tempDir(), 'tars.db'), memoryLogger());
  insertMessage(db, { chatId: 1, messageId: 5, userId: 1, direction: 'in', timestamp: new Date(), text: 'x' });
  return db;
}
const stored = (db: Db) => db.prepare('SELECT reactions FROM messages WHERE chat_id=1 AND message_id=5').pluck().get();

describe('reactions column', () => {
  it('tracks user reactions per emoji in insertion order, JSON with raw emoji, NULL when empty', () => {
    const db = setup();
    applyUserReaction(db, [1, 5], { userId: 77, oldEmoji: [], newEmoji: ['👍'] });
    applyUserReaction(db, [1, 5], { userId: 88, oldEmoji: [], newEmoji: ['👍', '❤️'] });
    applyUserReaction(db, [1, 5], { userId: 88, oldEmoji: [], newEmoji: ['👍'] });
    expect(stored(db)).toBe('{"👍":[77,88],"❤️":[88]}');
    applyUserReaction(db, [1, 5], { userId: 88, oldEmoji: ['❤️', '👍'], newEmoji: ['🔥'] });
    expect(stored(db)).toBe('{"👍":[77],"🔥":[88]}');
    applyUserReaction(db, [1, 5], { userId: 77, oldEmoji: ['👍'], newEmoji: [] });
    applyUserReaction(db, [1, 5], { userId: 88, oldEmoji: ['🔥'], newEmoji: [] });
    expect(stored(db)).toBeNull();
    applyUserReaction(db, [1, 404], { userId: 88, oldEmoji: [], newEmoji: ['👍'] });
  });

  it('keeps one bot reaction per message and tolerates corrupt values', () => {
    const db = setup();
    db.prepare(`UPDATE messages SET reactions='{"👍": [77], "bad": 3}' WHERE message_id=5`).run();
    addBotReaction(db, [1, 5], 999, '👀');
    addBotReaction(db, [1, 5], 999, '👍');
    expect(stored(db)).toBe('{"👍":[77,999]}');
    db.prepare(`UPDATE messages SET reactions='not json' WHERE message_id=5`).run();
    addBotReaction(db, [1, 5], 999, '✅');
    expect(stored(db)).toBe('{"✅":[999]}');
    db.prepare(`UPDATE messages SET reactions='[1, 2]' WHERE message_id=5`).run();
    applyUserReaction(db, [1, 5], { userId: 7, oldEmoji: [], newEmoji: ['👍'] });
    expect(stored(db)).toBe('{"👍":[7]}');
  });
});

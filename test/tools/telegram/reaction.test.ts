import { describe, expect, it } from 'vitest';

import { addReactionTool } from '../../../src/tools/telegram/reaction.ts';
import { expectGoldenTool, goldenTools } from '../../golden/tools.ts';
import { call, messageRow, seedMessage, toolContext } from './harness.ts';

/** The allowlist exactly as the `emoji` field description shows it. */
const DISPLAY = (() => {
  const field = goldenTools.find((t) => t.name === 'telegram_add_reaction')?.inputSchema.properties as Record<string, { description: string }>;
  return field.emoji?.description.replace('One of the Telegram-supported reaction emojis: ', '').slice(0, -1) ?? '';
})();

describe('telegram_add_reaction', () => {
  it('matches the tools/list snapshot: 73 emoji in code-point order', () => {
    expectGoldenTool(addReactionTool(toolContext().ctx));
    expect(DISPLAY.split(' ')).toHaveLength(73);
  });

  it('rejects an emoji Telegram does not accept, echoing it JSON-quoted, without calling Telegram', async () => {
    const t = toolContext();
    const tool = addReactionTool(t.ctx);
    expect(await call(tool, { chat_id: 1, message_id: 2, emoji: '🙅' })).toEqual({
      content: `emoji "🙅" is not a Telegram-supported reaction. Choose one of: ${DISPLAY}`,
      isError: true,
    });
    expect((await call(tool, { chat_id: 1, message_id: 2, emoji: '🧑\u{200D}💻' })).content).toMatch(/^emoji "🧑\u{200D}💻" is not a Telegram-supported reaction\./u);
    expect(t.fake.sent('setMessageReaction')).toEqual([]);
  });

  it('strips U+FE0F, reacts, logs [REACT], and keeps users\' reactions in the row', async () => {
    const t = toolContext();
    seedMessage(t.db, 111, 2);
    t.db.prepare('UPDATE messages SET reactions=? WHERE message_id=2').run('{"👍":[77]}');
    const out = await call(addReactionTool(t.ctx), { chat_id: 111, message_id: 2, emoji: '❤️' });
    expect(t.fake.sent('setMessageReaction')[0]?.payload).toEqual({ chat_id: 111, message_id: 2, reaction: [{ type: 'emoji', emoji: '❤' }] });
    expect(out).toEqual({ content: 'reacted ❤ to 2' });
    expect(messageRow(t.db, 111, 2)?.reactions).toBe('{"👍":[77],"❤":[999]}');
    expect(t.log.text()).toContain('[REACT] DM Ali[111] m2 ❤');
    expect(t.replied).toEqual([]);
  });

  it('replaces the bot\'s previous reaction, and is a no-op on a message we never stored', async () => {
    const t = toolContext();
    seedMessage(t.db, 111, 2);
    const tool = addReactionTool(t.ctx);
    await call(tool, { chat_id: 111, message_id: 2, emoji: '👀' });
    await call(tool, { chat_id: 111, message_id: 2, emoji: '👍' });
    expect(messageRow(t.db, 111, 2)?.reactions).toBe('{"👍":[999]}');
    await call(tool, { chat_id: 111, message_id: 3, emoji: '👍' });
    expect(messageRow(t.db, 111, 3)).toBeUndefined();
  });

  it('surfaces Telegram refusing the reaction', async () => {
    const t = toolContext();
    t.fake.fail('setMessageReaction', 400, 'Bad Request: REACTION_INVALID');
    await expect(call(addReactionTool(t.ctx), { chat_id: 111, message_id: 2, emoji: '🔥' })).rejects.toMatchObject({
      name: 'GrammyError',
      message: "Call to 'setMessageReaction' failed! (400: Bad Request: REACTION_INVALID)",
    });
    expect(t.log.text()).not.toContain('[REACT]');
  });
});

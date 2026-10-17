import type { Message, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { chatTitle, commandOf, toChatMessage } from '../../src/telegram/updates.ts';

const message = (extra: Partial<Message> & Record<string, unknown> = {}): Message =>
  ({ message_id: 10, date: 1_700_000_000, chat: { id: 111, type: 'private', first_name: 'Ali' }, from: { id: 111, is_bot: false, first_name: 'Ali', username: 'ali' }, text: 'hi', ...extra });
const map = (msg: Message) => toChatMessage({ update_id: 1, message: msg } as Update, msg);

describe('update → ChatMessage', () => {
  it('maps the fields and drops sender-less messages', () => {
    expect(map(message())).toMatchObject({ chatId: 111, messageId: 10, userId: 111, username: 'ali', firstName: 'Ali', direction: 'in', text: 'hi', timestamp: new Date(1_700_000_000_000) });
    expect(map(message({ from: undefined }))).toBeUndefined();
    expect(map(message({ text: undefined, caption: 'a caption' }))?.text).toBe('a caption');
  });

  it('captures the reply target and its cleaned text', () => {
    const reply = message({ reply_to_message: message({ message_id: 9, text: 'parent' }) as never });
    expect(map(reply)).toMatchObject({ replyToId: 9, replyToText: 'parent' });
    const sticker = message({ reply_to_message: message({ message_id: 8, text: undefined }) as never });
    expect(map(sticker)).toMatchObject({ replyToId: 8, replyToText: undefined });
  });

  it('keeps the thread id only for real forum-topic messages', () => {
    expect(map(message({ message_thread_id: 55, is_topic_message: true }))?.messageThreadId).toBe(55);
    expect(map(message({ message_thread_id: 55 }))?.messageThreadId).toBeUndefined();
  });

  it('normalises before scrubbing, so obfuscated keys are redacted, and flags what changed', () => {
    const key = `s\u{200B}k-${'a'.repeat(24)}`;
    const cm = map(message({ text: `my key ${key}` }));
    expect(cm?.text).toBe('my key [REDACTED]');
    expect([...(cm?.inputFlags ?? [])]).toEqual(['zero_width_stripped']);
  });

  it('stores the raw update as JSON with secrets scrubbed per value', () => {
    const cm = map(message({ text: 'postgres://u:hunter2@db/x tail' }));
    const raw = JSON.parse(cm?.rawUpdateJson ?? '') as { message: { text: string } };
    expect(raw.message.text).toBe('[REDACTED] tail');
    expect(cm?.rawUpdateJson).toContain('{"update_id":1,"message":{');
  });
});

describe('commands and titles', () => {
  it('recognises a command addressed to us or to nobody, case-insensitively', () => {
    const cmd = (text: string, length: number) => commandOf(message({ text, entities: [{ type: 'bot_command', offset: 0, length }] }), 'tars_bot');
    expect(cmd('/logs 50', 5)).toEqual({ name: 'logs', args: ['50'] });
    expect(cmd('/Health@Tars_Bot', 18)).toEqual({ name: 'health', args: [] });
    expect(cmd('/logs@other_bot', 15)).toBeUndefined();
    expect(commandOf(message({ text: 'not /a command' }), 'tars_bot')).toBeUndefined();
  });

  it('names a chat by title, full name or username', () => {
    expect(chatTitle({ id: -1, type: 'supergroup', title: 'Dev' })).toBe('Dev');
    expect(chatTitle({ id: 1, type: 'private', first_name: 'Ali', last_name: 'V' })).toBe('Ali V');
    expect(chatTitle({ id: 1, type: 'private', first_name: '', username: 'ali' } as never)).toBe('ali');
  });
});

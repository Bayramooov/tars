import { readFileSync } from 'node:fs';

import type { ChatMessage } from '../../src/message.ts';
import type { InputFlag } from '../../src/text/normalize.ts';

/** Parse a golden fixture: a snapshot of model-visible output, changed only on purpose. */
export const loadGolden = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T;

/** A `ChatMessage` as the fixtures store it (snake_case field names). */
export interface GoldenMsg {
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
  message_thread_id: number | null;
  input_flags: InputFlag[];
}

export function toChatMessage(m: GoldenMsg): ChatMessage {
  return {
    chatId: m.chat_id,
    messageId: m.message_id,
    userId: m.user_id,
    username: m.username ?? undefined,
    firstName: m.first_name ?? undefined,
    direction: m.direction,
    timestamp: new Date(m.timestamp),
    text: m.text,
    replyToId: m.reply_to_id ?? undefined,
    replyToText: m.reply_to_text ?? undefined,
    messageThreadId: m.message_thread_id ?? undefined,
    inputFlags: new Set(m.input_flags),
  };
}

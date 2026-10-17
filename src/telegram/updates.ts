import type { Message, Update } from 'grammy/types';

import type { ChatMessage } from '../message.ts';
import { type InputFlag, normalizeInbound } from '../text/normalize.ts';
import { scrub } from '../text/scrub.ts';

/**
 * Map an inbound message update to a `ChatMessage`; undefined when it has no
 * sender. Text and the replied-to text are cleaned (normalised, then
 * scrubbed) and the obfuscation flags kept for the envelope.
 */
export function toChatMessage(update: Update, msg: Message): ChatMessage | undefined {
  if (!msg.from) return undefined;
  const text = clean(msg.text ?? msg.caption);
  const reply = replyOf(msg);
  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    userId: msg.from.id,
    username: msg.from.username,
    firstName: msg.from.first_name,
    direction: 'in',
    timestamp: new Date(msg.date * 1000),
    text: text.text,
    replyToId: reply.id,
    replyToText: reply.text,
    // Only forum topics carry a routable thread id; plain reply threads set one too.
    messageThreadId: msg.is_topic_message ? msg.message_thread_id : undefined,
    rawUpdateJson: JSON.stringify(scrubStrings(update)),
    inputFlags: new Set([...text.flags, ...reply.flags]),
  };
}

/** The replied-to message's id and cleaned text (its caption for media), if this is a reply. */
function replyOf(msg: Message): { id?: number; text?: string; flags: Set<InputFlag> } {
  const reply = msg.reply_to_message;
  if (!reply) return { flags: new Set() };
  const { text, flags } = clean(reply.text ?? reply.caption);
  return { id: reply.message_id, text: text || undefined, flags };
}

/**
 * Normalise first, then scrub: a key split by zero-width characters or typed
 * in fullwidth only looks like a key after normalisation.
 */
function clean(raw: string | undefined): { text: string; flags: Set<InputFlag> } {
  if (!raw) return { text: '', flags: new Set() };
  const { text, flags } = normalizeInbound(raw);
  return { text: scrub(text), flags };
}

/** Scrub every string value, keeping the stored update valid JSON. */
function scrubStrings(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubStrings);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubStrings(v)]));
}

/** A recognised `/command`: the first entity, at offset 0, addressed to us or to nobody. */
export function commandOf(msg: Message, botUsername: string): { name: string; args: string[] } | undefined {
  const entity = msg.entities?.[0];
  if (!msg.text || entity?.type !== 'bot_command' || entity.offset !== 0) return undefined;
  const [name = '', target] = msg.text.slice(1, entity.length).split('@');
  if (target !== undefined && target.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return { name: name.toLowerCase(), args: msg.text.split(/\s+/).filter(Boolean).slice(1) };
}

/** The chat's display name: title, the person's full name, or the username. */
export function chatTitle(chat: Message['chat']): string | undefined {
  if ('title' in chat && chat.title) return chat.title;
  const full = 'first_name' in chat && chat.first_name ? [chat.first_name, chat.last_name].filter(Boolean).join(' ') : '';
  return full || ('username' in chat ? chat.username : undefined) || undefined;
}

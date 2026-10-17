import type { ChatMessage } from '../message.ts';
import { escapeHtml } from '../text/html.ts';
import { clip } from '../text/clip.ts';

/** `t.me/c` deep link for a supergroup/channel message (`-100…` ids); undefined for DMs and basic groups. */
export function messageLink(chatId: number, messageId: number): string | undefined {
  const text = String(chatId);
  return text.startsWith('-100') ? `https://t.me/c/${text.slice(4)}/${messageId}` : undefined;
}

/**
 * HTML reference to the message that caused an error, for the owner DM:
 * which message, who sent it, the group (title + id) and its deep link
 * when there is one, and the quoted text.
 */
export function messageRef(msg: ChatMessage, chatTitle?: string): string {
  let header = `• message ${msg.messageId} from ${escapeHtml(senderLabel(msg))}`;
  if (msg.chatId < 0) header += ` in ${escapeHtml(chatTitle ? `"${chatTitle}" (id ${msg.chatId})` : `(id ${msg.chatId})`)}`;
  const link = messageLink(msg.chatId, msg.messageId);
  if (link !== undefined) header += `: ${escapeHtml(link)}`;
  return `${header}\n${quote(msg.text)}`;
}

/** One `messageRef` per target, ordered by chat id; empty when there are none. */
export function formatMessageRefs(targets: ReadonlyMap<number, ChatMessage>, chatTitles: ReadonlyMap<number, string>): string {
  return [...targets.keys()]
    .sort((a, b) => a - b)
    .map((chatId) => messageRef(targets.get(chatId) as ChatMessage, chatTitles.get(chatId)))
    .join('\n');
}

function senderLabel(msg: ChatMessage): string {
  const name = msg.username ? `@${msg.username}` : msg.firstName || 'unknown';
  return `${name} (id ${msg.userId})`;
}

/** Quoted text as a blockquote, capped at 500 characters (cut before escaping). */
function quote(text: string): string {
  const body = clip(text.trim(), 500);
  return `<blockquote>${escapeHtml(body) || '(no text)'}</blockquote>`;
}

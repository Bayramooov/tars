import { insertMessage } from '../db/messages.ts';
import type { ToolContext } from '../tools/context.ts';

/** Persist one delivered message as an outbound row authored by the bot. */
export function recordOutbound(
  ctx: Pick<ToolContext, 'db' | 'me'>,
  sent: { chatId: number; messageId: number; text: string; replyToId?: number | undefined },
): void {
  const me = ctx.me();
  insertMessage(ctx.db, {
    chatId: sent.chatId,
    messageId: sent.messageId,
    userId: me.id,
    username: me.username,
    firstName: me.first_name,
    direction: 'out',
    timestamp: new Date(),
    text: sent.text,
    replyToId: sent.replyToId,
  });
}

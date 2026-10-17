import { recordOutbound } from '../../telegram/outbound.ts';
import type { ToolContext } from '../context.ts';

export type DeliveryContext = Pick<ToolContext, 'db' | 'me' | 'chatTitles' | 'transcript' | 'onChatReplied'>;

export interface Delivery {
  chatId: number;
  messageId: number;
  replyToId: number | null;
  /** The `[TX]` line's body, e.g. `[photo] <path>`. */
  text: string;
  /** What the stored row says when it says more than the transcript line (a poll's options). */
  dbText?: string;
}

/**
 * After Telegram confirmed a photo, document or poll, in this order: stop the
 * chat's typing indicator, write the `[TX]` line, persist the outbound row.
 */
export function recordDelivery(ctx: DeliveryContext, sent: Delivery): void {
  ctx.onChatReplied(sent.chatId);
  const replyToId = sent.replyToId ?? undefined;
  ctx.transcript.outbound({ chatId: sent.chatId, title: ctx.chatTitles.get(sent.chatId) }, { messageId: sent.messageId, text: sent.text, replyToId });
  recordOutbound(ctx, { chatId: sent.chatId, messageId: sent.messageId, text: sent.dbText ?? sent.text, replyToId });
}

import { z } from 'zod';

import { chunkText } from '../../text/chunk.ts';
import { markdownToTelegramHtml } from '../../text/markdown.ts';
import { defineTool, type Tool, type ToolResult } from '../../mcp/tool.ts';
import type { ToolContext } from '../context.ts';
import { recordOutbound } from './delivery.ts';

type SendContext = Pick<ToolContext, 'api' | 'db' | 'me' | 'chatTitles' | 'transcript' | 'log' | 'onChatReplied'>;

const CHAT_ID = z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.');

export function sendMessageTool(ctx: SendContext): Tool {
  return defineTool({
    name: 'telegram_send_message',
    description: 'Send a NEW, unthreaded text message to a Telegram chat. Use ONLY when there is no inbound message to answer — a scheduled reminder firing on a timer, or a proactive/unprompted post you initiate. Whenever you are answering an inbound message — in a DM or a group, even a quiet one-on-one DM — use telegram_reply_to_message instead so the reply threads to it. Does NOT edit or quote existing messages (use telegram_edit_message / telegram_reply_to_message) and does NOT send images or files (use telegram_send_photo / telegram_send_memory_document). Sends immediately and cannot be unsent. Long text is auto-split at paragraph boundaries; returns the first message_id plus every id in ``message_ids``.',
    args: z.object({
      chat_id: CHAT_ID,
      text: z.string().describe('Message body. Markdown — auto-converted to Telegram HTML.'),
      reply_to_message_id: z.int().nullable().default(null).describe('Optional. Make this a quote-reply to the given message id. When a reply target is required, prefer telegram_reply_to_message.'),
      message_thread_id: z.int().nullable().default(null).describe('Optional. Forum-supergroup topic id. REQUIRED when the inbound <msg> carries a topic="..." attribute — copy that value here, otherwise the message lands in the General topic.'),
    }),
    run: (args) => deliver(ctx, { chatId: args.chat_id, text: args.text, replyTo: args.reply_to_message_id, topic: args.message_thread_id }),
  });
}

/** A reply threads to its target, which also places it in the target's forum topic. */
export function replyToMessageTool(ctx: SendContext): Tool {
  return defineTool({
    name: 'telegram_reply_to_message',
    description: 'Reply to a specific message, threading to it so the parent is unambiguous. This is how you answer EVERY inbound message, in DMs and groups alike — thread to the message you\'re answering. A DM having only one conversation is not a reason to skip threading. Use telegram_send_message only when there is no inbound message to answer (e.g. a scheduled timer reminder or a proactive post). Sends immediately; long text auto-splits at paragraph boundaries.',
    args: z.object({
      chat_id: z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.'),
      reply_to_message_id: z.int().describe('Numeric id of the message to quote-reply within chat_id.'),
      text: z.string().describe('Reply body. Markdown by default — auto-converted to Telegram HTML.'),
    }),
    run: (args) => deliver(ctx, { chatId: args.chat_id, text: args.text, replyTo: args.reply_to_message_id, topic: null }),
  });
}

interface Outgoing {
  chatId: number;
  text: string;
  replyTo: number | null;
  topic: number | null;
}

/**
 * Send markdown text as Telegram HTML, split at paragraph boundaries into
 * as many messages as needed; only the first threads to `replyTo`, and the
 * rest follow it into its forum topic. Every delivered chunk is recorded —
 * also when a later chunk fails.
 */
async function deliver(ctx: SendContext, out: Outgoing): Promise<ToolResult> {
  const chunks = chunkText(out.text);
  const ids: number[] = [];
  let topic = out.topic ?? undefined;
  try {
    for (const [i, chunk] of chunks.entries()) {
      const sent = await ctx.api.sendMessage(out.chatId, markdownToTelegramHtml(chunk), {
        parse_mode: 'HTML',
        ...(i === 0 && out.replyTo !== null ? { reply_parameters: { message_id: out.replyTo } } : {}),
        message_thread_id: topic,
      });
      topic ??= sent.is_topic_message ? sent.message_thread_id : undefined;
      ids.push(sent.message_id);
      ctx.log.info(`hot-path stage=delivered chat=${out.chatId} msg=${sent.message_id} chunk=${i + 1}/${chunks.length}`);
      if (i === 0) ctx.onChatReplied(out.chatId);
    }
  } finally {
    record(ctx, out, chunks, ids);
  }
  const content = ids.length === 1 ? `sent message_id=${ids[0]}` : `sent ${ids.length} chunks: message_ids=[${ids.join(', ')}]`;
  return { content, data: { message_id: ids[0], message_ids: ids, chat_id: out.chatId } };
}

function record(ctx: SendContext, out: Outgoing, chunks: string[], ids: number[]): void {
  if (!ids.length) return;
  const replyToId = out.replyTo ?? undefined;
  ctx.transcript.outbound({ chatId: out.chatId, title: ctx.chatTitles.get(out.chatId) }, { messageId: ids[0] ?? 0, text: out.text, replyToId });
  ids.forEach((messageId, i) => recordOutbound(ctx, { chatId: out.chatId, messageId, text: chunks[i] ?? '', replyToId: i === 0 ? replyToId : undefined }));
}

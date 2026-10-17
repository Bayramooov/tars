import { basename } from 'node:path';

import { InputFile } from 'grammy';
import { z } from 'zod';

import { defineTool, type Tool } from '../../mcp/tool.ts';
import type { ToolContext } from '../context.ts';
import { type DeliveryContext, recordDelivery } from './delivery.ts';

/** The memory store, as far as shipping a memory file needs it. */
export interface MemoryFiles {
  /** Absolute path of an existing `memories/<path>` file; throws otherwise. */
  resolveReadable(path: string): string;
}

/** Uploads a memory file as a document; only files under the memory root can leave this way. */
export function sendMemoryDocumentTool(ctx: DeliveryContext & Pick<ToolContext, 'api' | 'log'>, memory: MemoryFiles): Tool {
  return defineTool({
    name: 'telegram_send_memory_document',
    description: 'Send a memory file (memories/...) to a chat as a downloadable document. Use when the user asks for a memory file as an attachment rather than pasted text — handy for csv/log/large markdown. For a rendered image use telegram_send_photo; for plain text use telegram_send_message. Path-locked to the memories root (same hardening as memory_read); sends immediately.',
    args: z.object({
      chat_id: z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.'),
      path: z.string().describe('Full project path to the memory — same shape as memory_read: \'memories/<path>\'. The prefix is required. No \'..\', no absolute paths, no symlinks.'),
      caption: z.string().max(1024).nullable().default(null).describe('Optional plain-text caption shown under the file (max 1024 chars).'),
      reply_to_message_id: z.int().nullable().default(null).describe('Optional. Quote-reply the document to this message id; omit for a standalone send.'),
    }),
    run: async ({ chat_id, path, caption, reply_to_message_id }) => {
      let file: string;
      try {
        file = memory.resolveReadable(path);
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      const filename = basename(file);
      const reply_parameters = reply_to_message_id === null ? undefined : { message_id: reply_to_message_id };
      const sent = await ctx.api.sendDocument(chat_id, new InputFile(file, filename), { caption: caption ?? undefined, reply_parameters });
      ctx.log.info(`hot-path stage=delivered chat=${chat_id} msg=${sent.message_id} document=${path}`);
      recordDelivery(ctx, { chatId: chat_id, messageId: sent.message_id, replyToId: reply_to_message_id, text: caption ? `[document] ${path} — ${caption}` : `[document] ${path}` });
      return { content: `sent document message_id=${sent.message_id} (${filename})`, data: { message_id: sent.message_id, chat_id, filename, path } };
    },
  });
}

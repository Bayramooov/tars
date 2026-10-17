import { basename } from 'node:path';

import { InputFile } from 'grammy';
import { z } from 'zod';

import { defineTool, type Tool } from '../../mcp/tool.ts';
import type { ToolContext } from '../context.ts';
import { type DeliveryContext, recordDelivery } from './delivery.ts';

/** The renders store, as far as sending a render needs it. */
export interface RenderFiles {
  /** Absolute path of a renders-relative one; throws when the path is unsafe. */
  resolvePath(path: string): string;
  /** True when `path` (absolute) is an existing regular file. */
  isFile(path: string): boolean;
}

/** Uploads a rendered image (render_html, render_latex, browser screenshots) as a photo. */
export function sendPhotoTool(ctx: DeliveryContext & Pick<ToolContext, 'api' | 'log'>, renders: RenderFiles): Tool {
  return defineTool({
    name: 'telegram_send_photo',
    description: 'Deliver a rendered image (from data/renders/, e.g. the path returned by render_html or render_latex) to a chat as an inline Telegram photo with preview. Use for tables/charts/math that Telegram markdown can\'t show. For an arbitrary file as a download use telegram_send_memory_document; for plain text use telegram_send_message. Path-locked to the renders root; sends immediately.',
    args: z.object({
      chat_id: z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.'),
      path: z.string().describe('Relative path under data/renders/ — typically the value returned by render_html. No \'..\', no absolute paths.'),
      caption: z.string().max(1024).nullable().default(null).describe('Optional plain-text caption shown under the photo (max 1024 chars).'),
      reply_to_message_id: z.int().nullable().default(null).describe('Optional. Quote-reply the photo to this message id; omit for a standalone send.'),
    }),
    run: async ({ chat_id, path, caption, reply_to_message_id }) => {
      let file: string;
      try {
        file = renders.resolvePath(path);
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      if (!renders.isFile(file)) return { content: `render not found: ${path}`, isError: true };
      const reply_parameters = reply_to_message_id === null ? undefined : { message_id: reply_to_message_id };
      const sent = await ctx.api.sendPhoto(chat_id, new InputFile(file), { caption: caption ?? undefined, reply_parameters });
      ctx.log.info(`hot-path stage=delivered chat=${chat_id} msg=${sent.message_id} photo=${path}`);
      recordDelivery(ctx, { chatId: chat_id, messageId: sent.message_id, replyToId: reply_to_message_id, text: caption ? `[photo] ${path} — ${caption}` : `[photo] ${path}` });
      const filename = basename(file);
      return { content: `sent photo message_id=${sent.message_id} (${filename})`, data: { message_id: sent.message_id, chat_id, filename, path } };
    },
  });
}

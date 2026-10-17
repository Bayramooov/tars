import { z } from 'zod';

import { markEdited } from '../../db/messages.ts';
import { defineTool, type Tool } from '../../mcp/tool.ts';
import { markdownToTelegramHtml } from '../../text/markdown.ts';
import type { ToolContext } from '../context.ts';

/** Replaces a sent message's text; no typing stop, since nothing new reaches the chat. */
export function editMessageTool(ctx: Pick<ToolContext, 'api' | 'db' | 'chatTitles' | 'transcript'>): Tool {
  return defineTool({
    name: 'telegram_edit_message',
    description: 'Replace the text of a message THIS BOT already sent. Use for in-progress updates on a long task — edits do NOT trigger a Telegram push notification, unlike a new message. Only works on the bot\'s own recent messages; to post fresh text use telegram_send_message.',
    args: z.object({
      chat_id: z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.'),
      message_id: z.int().describe('Numeric id of the bot\'s own message to edit (e.g. a message_id returned by telegram_send_message).'),
      text: z.string().describe('New body, replacing the old text entirely. Markdown by default — auto-converted to Telegram HTML.'),
    }),
    run: async ({ chat_id, message_id, text }) => {
      await ctx.api.editMessageText(chat_id, message_id, markdownToTelegramHtml(text), { parse_mode: 'HTML' });
      ctx.transcript.edit({ chatId: chat_id, title: ctx.chatTitles.get(chat_id) }, message_id, text);
      markEdited(ctx.db, [chat_id, message_id], text);
      return { content: `edited message_id=${message_id}`, data: { message_id, chat_id } };
    },
  });
}

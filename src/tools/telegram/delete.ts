import { z } from 'zod';

import { markDeleted } from '../../db/messages.ts';
import { defineTool, type Tool } from '../../mcp/tool.ts';
import type { ToolContext } from '../context.ts';

/** Deletes any message the bot may delete (not only its own); the row stays, flagged `deleted`. */
export function deleteMessageTool(ctx: Pick<ToolContext, 'api' | 'db' | 'chatTitles' | 'transcript'>): Tool {
  return defineTool({
    name: 'telegram_delete_message',
    description: 'Permanently delete a message by id. IRREVERSIBLE — the message is gone for everyone, with no undo. Use sparingly (e.g. removing a mistaken send); do NOT use to \'take back\' content the user has already read. Bots can only delete fairly recent messages.',
    args: z.object({
      chat_id: z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.'),
      message_id: z.int().describe('Numeric id of the message to delete.'),
    }),
    run: async ({ chat_id, message_id }) => {
      await ctx.api.deleteMessage(chat_id, message_id);
      ctx.transcript.delete({ chatId: chat_id, title: ctx.chatTitles.get(chat_id) }, message_id);
      markDeleted(ctx.db, [chat_id, message_id]);
      return { content: `deleted message_id=${message_id}` };
    },
  });
}

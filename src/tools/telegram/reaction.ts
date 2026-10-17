import type { ReactionTypeEmoji } from 'grammy/types';
import { z } from 'zod';

import { addBotReaction } from '../../db/reactions.ts';
import { defineTool, type Tool } from '../../mcp/tool.ts';
import type { ToolContext } from '../context.ts';

/** The only emoji the Bot API accepts as a reaction, in code-point order — the list the model is shown. */
const REACTIONS =
  '☃ ⚡ ✍ ❤ ❤\u{200D}🔥 🆒 🌚 🌭 🍌 🍓 🍾 🎃 🎄 🎅 🎉 🏆 🐳 👀 👌 👍 👎 👏 👨\u{200D}💻 👻 👾 💅 💊 💋 💔 💘 💩 💯 🔥 🕊 🖕 🗿 😁 😇 😈 😍 😎 😐 😘 😡 😢 😨 😭 😱 😴 🙈 🙉 🙊 🙏 🤓 🤔 🤗 🤝 🤡 🤣 🤨 🤩 🤪 🤬 🤮 🤯 🤷 🤷\u{200D}♀ 🤷\u{200D}♂ 🥰 🥱 🥴 🦄 🫡';
const ALLOWED = new Set(REACTIONS.split(' '));

/** The bot's reaction replaces its earlier one, on Telegram and in `messages.reactions`. */
export function addReactionTool(ctx: Pick<ToolContext, 'api' | 'db' | 'me' | 'chatTitles' | 'transcript'>): Tool {
  return defineTool({
    name: 'telegram_add_reaction',
    description: 'React to a Telegram message with a single emoji from Telegram\'s fixed allowlist (see the emoji parameter for the exact set). Prefer a reaction over a throwaway \'ok\'/\'👍\' text message in groups. Replaces any previous reaction the bot left on that message.',
    args: z.object({
      chat_id: z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.'),
      message_id: z.int().describe('Numeric id of the message to react to.'),
      emoji: z.string().describe(`One of the Telegram-supported reaction emojis: ${REACTIONS}.`),
    }),
    run: async ({ chat_id, message_id, emoji: given }) => {
      // Keyboards append the emoji presentation selector (❤️); Telegram's list has none.
      const emoji = given.replaceAll('\u{FE0F}', '');
      if (!ALLOWED.has(emoji)) {
        return { content: `emoji ${JSON.stringify(given)} is not a Telegram-supported reaction. Choose one of: ${REACTIONS}`, isError: true };
      }
      await ctx.api.setMessageReaction(chat_id, message_id, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]);
      ctx.transcript.reaction({ chatId: chat_id, title: ctx.chatTitles.get(chat_id) }, message_id, emoji);
      addBotReaction(ctx.db, [chat_id, message_id], ctx.me().id, emoji);
      return { content: `reacted ${emoji} to ${message_id}` };
    },
  });
}

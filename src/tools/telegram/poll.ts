import { z } from 'zod';

import { defineTool, type Tool, type ToolResult } from '../../mcp/tool.ts';
import type { ToolContext } from '../context.ts';
import { type DeliveryContext, recordDelivery } from './delivery.ts';

type PollContext = DeliveryContext & Pick<ToolContext, 'api' | 'log'>;

const pollArgs = z.object({
  chat_id: z.int().describe('Numeric Telegram chat id (e.g. -1001234567890 for a group, a positive int for a DM). Not an @username.'),
  question: z.string().min(1).max(300).describe('Poll question (1–300 chars).'),
  options: z.array(z.string()).min(2).max(10).describe('Answer options: 2–10 strings, each 1–100 chars.'),
  is_anonymous: z.boolean().default(true).describe('Whether votes are anonymous. Default true.'),
  type: z.enum(['regular', 'quiz']).default('regular').describe('\'regular\' for a normal vote, \'quiz\' for a single-correct-answer quiz. Default \'regular\'.'),
  allows_multiple_answers: z.boolean().default(false).describe('Let voters pick several options. Regular polls only; must be false for quizzes. Default false.'),
  correct_option_id: z.int().min(0).max(9).nullable().default(null).describe('0-based index of the correct option. Required when type=\'quiz\'; omit for regular polls.'),
  explanation: z.string().max(200).nullable().default(null).describe('Shown when a quiz answer is wrong. Quiz only.'),
  open_period: z.int().min(5).max(600).nullable().default(null).describe('Auto-close after N seconds (5-600). Mutually exclusive with close_date.'),
  close_date: z.int().nullable().default(null).describe('Unix timestamp 5-600s in the future. Mutually exclusive with open_period.'),
  reply_to_message_id: z.int().nullable().default(null).describe('Optional. Quote-reply the poll to this message id; omit for a standalone poll.'),
});

type PollArgs = z.output<typeof pollArgs>;

export function createPollTool(ctx: PollContext): Tool {
  return defineTool({
    name: 'telegram_create_poll',
    description: 'Send a Telegram poll — a regular vote or a quiz with one correct answer. Use for structured voting; for plain text use telegram_send_message. Sends immediately. Rules: 2–10 options, each 1–100 chars; for type=\'quiz\' you MUST set correct_option_id and must NOT set allows_multiple_answers; for type=\'regular\' omit correct_option_id and explanation; open_period and close_date are mutually exclusive. Returns message_id and poll_id (pass them to telegram_stop_poll to close the poll early).',
    args: pollArgs,
    run: (args) => sendPoll(ctx, args),
  });
}

async function sendPoll(ctx: PollContext, args: PollArgs): Promise<ToolResult> {
  const broken = brokenRule(args);
  if (broken) throw new Error(broken);
  const sent = await ctx.api.sendPoll(args.chat_id, args.question, args.options, {
    is_anonymous: args.is_anonymous,
    type: args.type,
    allows_multiple_answers: args.allows_multiple_answers,
    // The Bot API now takes the quiz answer as a list.
    correct_option_ids: args.correct_option_id === null ? undefined : [args.correct_option_id],
    explanation: args.explanation ?? undefined,
    open_period: args.open_period ?? undefined,
    close_date: args.close_date ?? undefined,
    reply_parameters: args.reply_to_message_id === null ? undefined : { message_id: args.reply_to_message_id },
  });
  const pollId = sent.poll.id;
  ctx.log.info(`hot-path stage=delivered chat=${args.chat_id} msg=${sent.message_id} poll=${pollId}`);
  const text = `[poll] ${args.question}`;
  const dbText = [text, ...args.options.map((option) => `- ${option}`)].join('\n');
  recordDelivery(ctx, { chatId: args.chat_id, messageId: sent.message_id, replyToId: args.reply_to_message_id, text, dbText });
  return { content: `poll sent message_id=${sent.message_id} poll_id=${pollId}`, data: { message_id: sent.message_id, poll_id: pollId, chat_id: args.chat_id } };
}

/**
 * The first cross-field rule the arguments break. Lengths are code points,
 * as zod counts the schema's.
 */
function brokenRule(a: PollArgs): string | undefined {
  const bad = a.options.findIndex((option) => !option || [...option].length > 100);
  const quiz = a.type === 'quiz';
  const rules: [broken: boolean, message: string][] = [
    [bad >= 0, `option ${bad} must be 1-100 chars`],
    [quiz && a.correct_option_id === null, "correct_option_id is required when type='quiz'"],
    [quiz && a.allows_multiple_answers, 'allows_multiple_answers is only valid for regular polls'],
    [!quiz && a.correct_option_id !== null, "correct_option_id is only valid when type='quiz'"],
    [!quiz && a.explanation !== null, "explanation is only valid when type='quiz'"],
    [a.correct_option_id !== null && a.correct_option_id >= a.options.length, 'correct_option_id is out of range'],
    [a.open_period !== null && a.close_date !== null, 'open_period and close_date are mutually exclusive'],
  ];
  return rules.find(([isBroken]) => isBroken)?.[1];
}

/** Closes a poll and reports the final tallies; nothing is persisted. */
export function stopPollTool(ctx: Pick<ToolContext, 'api' | 'log'>): Tool {
  return defineTool({
    name: 'telegram_stop_poll',
    description: 'Close an open Telegram poll early and return the final vote tallies. Use the chat_id and message_id returned by the telegram_create_poll that created it. The poll stops accepting votes immediately.',
    args: z.object({
      chat_id: z.int().describe('Numeric Telegram chat id where the poll was sent.'),
      message_id: z.int().describe('Numeric message_id of the poll to close.'),
    }),
    run: async ({ chat_id, message_id }) => {
      const poll = await ctx.api.stopPoll(chat_id, message_id);
      ctx.log.info(`poll closed chat=${chat_id} msg=${message_id} votes=${poll.total_voter_count}`);
      const options = poll.options.map((o) => ({ text: o.text, voter_count: o.voter_count }));
      const content = [`poll closed: ${poll.total_voter_count} votes`, ...options.map((o) => `- ${o.text}: ${o.voter_count}`)].join('\n');
      return { content, data: { poll_id: poll.id, total_voter_count: poll.total_voter_count, options, is_closed: poll.is_closed, chat_id, message_id } };
    },
  });
}

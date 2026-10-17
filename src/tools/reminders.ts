import { z } from 'zod';

import { type Db, sqliteTime } from '../db/database.ts';
import { cancelReminder, fetchReminder, insertReminder, listPendingReminders } from '../db/reminders.ts';
import { defineTool, type Tool, type ToolResult } from '../mcp/tool.ts';
import { isValidCron } from '../scheduler/cron.ts';

const refuse = (content: string): ToolResult => ({ content, isError: true });

const SET_ARGS = z.object({
  chat_id: z.int().describe('Numeric Telegram chat id where the reminder should fire.'),
  user_id: z.int().describe('Numeric Telegram user id who requested the reminder.'),
  text: z.string().describe('The reminder message text.'),
  trigger_at: z.string().describe('When to fire, as a UTC ISO-8601 datetime string with offset (e.g. \'2026-04-15T14:30:00Z\'). Must be in the FUTURE. Convert the user\'s local time to UTC before passing this value.'),
  cron_expr: z.string().nullable().default(null).describe('Optional 5-field cron expression (evaluated in UTC) for recurring reminders, e.g. \'0 9 * * 1-5\' for weekdays at 09:00 UTC. Leave null for one-shot reminders.'),
});

/** `reminder_set`: one-shot at `trigger_at`, or recurring — first at `trigger_at`, then on the cron. */
export function reminderSetTool(db: Db): Tool {
  return defineTool({
    name: 'reminder_set',
    description: 'Schedule a reminder to fire later — one-shot (trigger_at only) or recurring (also set cron_expr). trigger_at is UTC ISO-8601 and must be in the future; ask the user\'s timezone if unknown and convert to UTC first. Do NOT use for something to do right now — just do it. Manage existing reminders with reminder_list and reminder_cancel.',
    args: SET_ARGS,
    run: (args) => Promise.resolve(setReminder(db, args)),
  });
}

function setReminder(db: Db, args: z.output<typeof SET_ARGS>): ToolResult {
  const at = parseTriggerAt(args.trigger_at);
  if (at === 'format') return refuse(`invalid trigger_at format: ${JSON.stringify(args.trigger_at)}`);
  if (at === 'naive') return refuse("trigger_at must include a timezone offset (use UTC, e.g. '...Z')");
  const year = new Date(at).getUTCFullYear();
  if (year < 1 || year > 9999) return refuse('trigger_at is out of range');
  if (at <= Date.now()) return refuse('trigger_at must be in the future');
  if (args.cron_expr !== null && !isValidCron(args.cron_expr, new Date(at))) return refuse(`invalid cron expression: ${JSON.stringify(args.cron_expr)}`);
  const id = insertReminder(db, { chatId: args.chat_id, userId: args.user_id, text: args.text, triggerAt: sqliteTime(new Date(at)), cronExpr: args.cron_expr });
  return { content: `reminder #${id} (${args.cron_expr ? 'recurring' : 'one-shot'}) set for ${args.trigger_at}`, data: { reminder_id: id } };
}

export function reminderListTool(db: Db): Tool {
  return defineTool({
    name: 'reminder_list',
    description: 'List all pending reminders for a chat, ordered by trigger time. Use to find a reminder\'s id before calling reminder_cancel.',
    args: z.object({ chat_id: z.int().describe('Numeric Telegram chat id to list reminders for.') }),
    run: ({ chat_id }) => {
      const rows = listPendingReminders(db, chat_id);
      if (!rows.length) return Promise.resolve({ content: 'no pending reminders' });
      const lines = rows.map((r) => `${r.id}\t${r.trigger_at}\t${r.cron_expr || '-'}\t${r.text}`);
      return Promise.resolve({ content: ['id\ttrigger_at\tcron\ttext', ...lines].join('\n'), data: { count: rows.length } });
    },
  });
}

/** `reminder_cancel`: auto-seeded rows (self-reflection, default-reminders.json) are operator-owned and refused. */
export function reminderCancelTool(db: Db): Tool {
  return defineTool({
    name: 'reminder_cancel',
    description: 'Cancel a pending reminder by id (get ids from reminder_list). Auto-seeded mandatory reminders (e.g. the self-reflection loop) cannot be cancelled through this tool — attempts are refused and the reminder continues to fire on schedule.',
    args: z.object({ reminder_id: z.int().describe('Numeric id of the reminder to cancel, as shown by reminder_list.') }),
    run: ({ reminder_id: id }) => {
      const key = fetchReminder(db, id)?.auto_seed_key;
      if (key) return Promise.resolve(refuse(`reminder #${id} is an auto-seeded mandatory loop (${key}) and cannot be cancelled`));
      return Promise.resolve(cancelReminder(db, id) ? { content: `reminder #${id} cancelled` } : refuse(`reminder #${id} not found or already sent/cancelled`));
    },
  });
}

/** `YYYY-MM-DD`, `T` or a space, `HH:MM[:SS[.fraction]]`, then `Z` or `±HH:MM`. */
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** The instant `trigger_at` names in epoch ms, or why it can't be used: unparseable (`format`) or without an offset (`naive`). */
function parseTriggerAt(text: string): number | 'format' | 'naive' {
  const match = ISO.exec(text);
  if (!match || !realDateTime(match)) return 'format';
  if (!match[7]) return 'naive';
  const ms = Date.parse(text.replace(' ', 'T'));
  return Number.isNaN(ms) ? 'format' : ms;
}

/** A real calendar day and clock time; `Date.parse` alone would roll Feb 30 over into March. */
function realDateTime(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); // unlike Date.UTC, keeps years 0–99 as they are
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59;
}

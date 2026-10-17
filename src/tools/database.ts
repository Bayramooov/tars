import { z } from 'zod';

import type { Db } from '../db/database.ts';
import { fetchRecentMessages } from '../db/messages.ts';
import { capText, type QueryOutcome } from '../db/query.ts';
import { defineTool, type Tool } from '../mcp/tool.ts';

const tsv = (rows: (string | number)[][]) => rows.map((row) => row.join('\t')).join('\n');

/** `database_query`: model-written SQL, run by `query` (read-only, off the event loop). */
export function databaseQueryTool(query: (sql: string) => Promise<QueryOutcome>): Tool {
  return defineTool({
    name: 'database_query',
    description: 'Run a single read-only SELECT against the agent\'s local SQLite. Returns rows as TSV with a header line. Capped at 100 rows; text columns truncated to 2000 chars. If the query already has a LIMIT, it is respected (and clamped down to 100 if larger).\n\nTables and their time columns:\n  messages(chat_id, message_id, user_id, username, first_name,\n           direction, timestamp, text, reply_to_id, reply_to_text,\n           edited, deleted)  -- time column: `timestamp` (NOT created_at)\n  users(chat_id, user_id, username, first_name, join_date,\n        last_message_date, message_count)\n  reactions(id, chat_id, message_id, user_id, emoji, created_at)\n  tool_calls(id, tool_name, args_json, result_json, error,\n             duration_ms, created_at)\n  reminders -- see reminder_set docs',
    args: z.object({
      sql: z.string().describe('A single SELECT statement. No semicolons, no DML, no PRAGMA. Capped at 100 rows; text columns truncated to 2000 chars.'),
    }),
    run: async ({ sql }) => {
      const outcome = await query(sql);
      if ('rejected' in outcome) return { content: 'rejected: only single read-only SELECT statements are allowed', isError: true };
      if ('error' in outcome) return { content: `sql error: ${outcome.error}`, isError: true };
      if (!outcome.rows.length) return { content: '(no rows)' };
      return { content: tsv([outcome.columns, ...outcome.rows]), data: { row_count: outcome.rows.length } };
    },
  });
}

/** `database_get_recent_messages`: the live conversation, including the current turn's unprocessed inbound rows. */
export function recentMessagesTool(db: Db): Tool {
  return defineTool({
    name: 'database_get_recent_messages',
    description: 'Return the most recent messages (both directions), oldest-first, as TSV with a header line. Includes the current turn\'s own inbound messages. Use this for quick conversation recall; use database_query for filtering, joins, or other tables. Capped at 100 rows; text columns truncated to 2000 chars.',
    args: z.object({
      limit: z.int().default(20).describe('How many recent messages to return, oldest-first. Defaults to 20, clamped to 100.'),
      chat_id: z.int().nullable().default(null).describe('Restrict to one chat. Omit to span all chats.'),
      before_message_id: z.int().nullable().default(null).describe('Return only messages older than this message id, for paging back through history. Message ids are per-chat, so pass it with chat_id.'),
    }),
    run: (args) => {
      const rows = fetchRecentMessages(db, {
        limit: Math.max(1, Math.min(args.limit, 100)),
        includeUnprocessed: true,
        chatId: args.chat_id ?? undefined,
        beforeMessageId: args.before_message_id ?? undefined,
      });
      if (!rows.length) return Promise.resolve({ content: '(no rows)' });
      const lines = rows.map((r) => [r.timestamp, r.direction, r.message_id, r.chat_id, r.first_name || r.username || r.user_id, capText(r.text)]);
      const header = ['timestamp', 'direction', 'message_id', 'chat_id', 'name', 'text'];
      return Promise.resolve({ content: tsv([header, ...lines]), data: { row_count: rows.length } });
    },
  });
}

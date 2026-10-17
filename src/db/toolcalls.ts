import { type Db, sqliteTime } from './database.ts';

export interface ToolCallRow {
  toolName: string;
  /** Validated arguments, defaults included, in schema order. */
  args: Record<string, unknown>;
  /** Content and data of a returned result; undefined when the tool threw. */
  result?: { content: string; data?: unknown } | undefined;
  /** `"<ErrorType>: <message>"` when the tool threw. */
  error?: string | undefined;
  durationMs: number;
}

/** One `tool_calls` audit row; its JSON columns are readable via `database_query`. */
export function insertToolCall(db: Db, call: ToolCallRow): void {
  const result = call.result ? JSON.stringify({ content: call.result.content, data: call.result.data ?? null }) : null;
  db.prepare(
    'INSERT INTO tool_calls(tool_name, args_json, result_json, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(call.toolName, JSON.stringify(call.args), result, call.error ?? null, Math.trunc(call.durationMs), sqliteTime(new Date()));
}

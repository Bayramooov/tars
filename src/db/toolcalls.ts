import { type Db, sqliteTime } from './database.ts';

/** Days an audit row is kept: every tool call adds one, full arguments and result included. */
const RETENTION_DAYS = 30;

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

/** Drop audit rows older than the retention window; run at boot. */
export function pruneToolCalls(db: Db): void {
  db.prepare(`DELETE FROM tool_calls WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')`).run();
}

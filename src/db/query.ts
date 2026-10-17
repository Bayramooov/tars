import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { cpSlice } from '../text/clip.ts';
import type { Db } from './database.ts';

/** One model-written query's result: up to 100 rendered rows, a refusal, or SQLite's error message. */
export type QueryOutcome = { columns: string[]; rows: string[][] } | { rejected: true } | { error: string };

const WORKER = new URL('./query-worker.ts', import.meta.url);

/** The first keyword, after any whitespace and comments, is SELECT or WITH. */
const SELECT_FIRST = /^(?:\s|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*(?:select|with)\b/i;

/** SQLite's words for text it can't parse: reported as a refusal, like any other non-SELECT. */
const SYNTAX_ERROR = /syntax error|incomplete input|unrecognized token/;

/**
 * Run model-written SQL on its own read-only connection in a worker thread,
 * so a slow query never blocks the event loop; past `timeoutMs` the caller
 * gets an error. Terminating the worker only takes effect once SQLite hands
 * control back: neither better-sqlite3 nor node:sqlite can interrupt a running
 * statement, so an endless one keeps its thread spinning, and `process.exit`
 * waiting on it, until the process is killed.
 */
export function queryReadOnly(path: string, sql: string, timeoutMs = 30_000): Promise<QueryOutcome> {
  const worker = new Worker(WORKER, { workerData: { path, sql } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ error: `query timed out after ${timeoutMs / 1000} s` });
    }, timeoutMs);
    worker.once('message', (outcome: QueryOutcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
    worker.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run one SELECT (or WITH … SELECT) verbatim; anything else is rejected.
 * `stmt.readonly` alone is not enough: SQLite counts PRAGMA, EXPLAIN and
 * VALUES as read-only too, hence the keyword check. `prepare` refuses a
 * second statement.
 */
export function selectRows(db: Db, sql: string): QueryOutcome {
  if (!SELECT_FIRST.test(sql)) return { rejected: true };
  let stmt: Database.Statement;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    return prepareFailure(err);
  }
  if (!stmt.reader || !stmt.readonly) return { rejected: true };
  try {
    return collect(stmt);
  } catch (err) {
    if (!(err instanceof Database.SqliteError)) throw err;
    return { error: err.message };
  }
}

function prepareFailure(err: unknown): QueryOutcome {
  if (err instanceof RangeError) return { rejected: true }; // more than one statement
  if (!(err instanceof Database.SqliteError)) throw err;
  return SYNTAX_ERROR.test(err.message) ? { rejected: true } : { error: err.message };
}

/** The first 100 rows; iteration stops there, so a huge result is never read. */
function collect(stmt: Database.Statement): QueryOutcome {
  const columns = stmt.columns().map((column) => column.name);
  const rows: string[][] = [];
  for (const row of stmt.raw().safeIntegers().iterate() as IterableIterator<unknown[]>) {
    rows.push(row.map(cellText));
    if (rows.length === 100) break;
  }
  return { columns, rows };
}

/** A SQLite value as text: NULL is empty, INTEGERs arrive as bigint, a BLOB is a hex literal; long values are capped. */
function cellText(value: unknown): string {
  if (value === null) return '';
  if (typeof value === 'string') return capText(value);
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  const blob = value as Buffer;
  return blob.length > 1000 ? `x'${blob.subarray(0, 1000).toString('hex')}'…[truncated]` : `x'${blob.toString('hex')}'`;
}

/** Both database tools cut text cells at 2000 code points. */
export function capText(text: string): string {
  const { text: head, cut } = cpSlice(text, 2000);
  return cut ? `${head}…[truncated]` : head;
}


import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { insertToolCall } from '../../src/db/toolcalls.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

describe('tool-call audit rows', () => {
  it('stores arguments and results as JSON, or the error when the tool threw', () => {
    const db = openDatabase(join(tempDir(), 'tars.db'), memoryLogger());
    insertToolCall(db, { toolName: 'time_now', args: { tz: 'Asia/Tashkent' }, result: { content: 'Ўз 12:00' }, durationMs: 12.9 });
    insertToolCall(db, { toolName: 'memory_read', args: { path: '../x' }, error: 'Error: nope', durationMs: 1 });
    const rows = db.prepare('SELECT tool_name, args_json, result_json, error, duration_ms, created_at FROM tool_calls ORDER BY id').all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ args_json: '{"tz":"Asia/Tashkent"}', result_json: '{"content":"Ўз 12:00","data":null}', error: null, duration_ms: 12 });
    expect(rows[1]).toMatchObject({ result_json: null, error: 'Error: nope', duration_ms: 1 });
    expect(rows[0]?.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });
});

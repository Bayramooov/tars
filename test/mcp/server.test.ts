import { request } from 'node:http';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../../src/db/database.ts';
import { insertToolCall } from '../../src/db/toolcalls.ts';
import { McpHttpServer } from '../../src/mcp/server.ts';
import { defineTool } from '../../src/mcp/tool.ts';
import { timeNowTool } from '../../src/tools/time.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const servers: McpHttpServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((s) => s.stop())));

const failing = defineTool({
  name: 'memory_read',
  description: 'test',
  args: z.object({ path: z.string() }),
  run: () => Promise.reject(new Error('memory path must start with \'memories/\': got "../x"')),
});
const bounded = defineTool({
  name: 'bounded',
  description: 'x',
  args: z.object({ n: z.int().min(1).max(200).default(5), s: z.string().max(3).default(''), l: z.array(z.string()).min(2).default(['a', 'b']) }),
  run: () => Promise.resolve({ content: 'ok' }),
});
const handled = defineTool({ name: 'handled', description: 'x', args: z.object({ n: z.int().nullable().default(null) }), run: () => Promise.resolve({ content: 'database unavailable', isError: true }) });

async function setup() {
  const log = memoryLogger();
  const db = openDatabase(join(tempDir(), 'h.db'), log);
  let beats = 0;
  const server = new McpHttpServer({ tools: [timeNowTool(), failing, handled, bounded], log, beat: () => void beats++, audit: (row) => insertToolCall(db, row) });
  servers.push(server);
  await server.start();
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  return { server, client, db, log, beats: () => beats };
}

describe('MCP server over Streamable HTTP', () => {
  it('serves tools/list and calls on 127.0.0.1/mcp', async () => {
    const t = await setup();
    expect(t.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await t.client.listTools()).tools.map((x) => x.name)).toEqual(['time_now', 'memory_read', 'handled', 'bounded']);
    const res = await t.client.callTool({ name: 'time_now', arguments: {} });
    expect(res.isError).toBe(false);
    expect((res.content as { text: string }[])[0]?.text).toMatch(/^utc=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00 local=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });

  it('returns failures as error results', async () => {
    const t = await setup();
    const text = async (name: string, args: Record<string, unknown>) => {
      const res = await t.client.callTool({ name, arguments: args });
      return [res.isError, (res.content as { text: string }[])[0]?.text];
    };
    expect(await text('memory_read', { path: '../x' })).toEqual([true, 'Error: memory path must start with \'memories/\': got "../x"']);
    expect(await text('handled', {})).toEqual([true, 'database unavailable']);
    expect(await text('nope', {})).toEqual([true, 'Unknown tool: nope']);
    expect(await text('memory_read', {})).toEqual([true, 'Invalid arguments:\n✖ Invalid input: expected string, received undefined\n  → at path']);
    expect(t.log.text()).toContain('ERROR tool memory_read failed');
  });

  it('reports invalid arguments in zod\'s words, never decoding strings for other types', async () => {
    const t = await setup();
    const error = async (args: Record<string, unknown>) => {
      const res = await t.client.callTool({ name: 'bounded', arguments: args });
      return (res.content as { text: string }[])[0]?.text.split('\n').slice(1).join(' | ');
    };
    expect(await error({ n: '5' })).toBe('✖ Invalid input: expected number, received string |   → at n');
    expect(await error({ n: 1.5 })).toBe('✖ Invalid input: expected int, received number |   → at n');
    expect(await error({ n: 0 })).toBe('✖ Too small: expected number to be >=1 |   → at n');
    expect(await error({ s: 'four' })).toBe('✖ Too big: expected string to have <=3 characters |   → at s');
    expect(await error({ s: '😀😀😀' })).toBe('');
    expect(await error({ l: ['x'] })).toBe('✖ Too small: expected array to have >=2 items |   → at l');
  });

  it('audits every executed call and beats the heartbeat around it', async () => {
    const t = await setup();
    await t.client.callTool({ name: 'handled', arguments: { n: 5 } });
    await t.client.callTool({ name: 'memory_read', arguments: { path: '../x' } });
    expect(t.db.prepare('SELECT tool_name, args_json, result_json, error FROM tool_calls ORDER BY id').all()).toEqual([
      { tool_name: 'handled', args_json: '{"n":5}', result_json: '{"content":"database unavailable","data":null}', error: null },
      { tool_name: 'memory_read', args_json: '{"path":"../x"}', result_json: null, error: 'Error: memory path must start with \'memories/\': got "../x"' },
    ]);
    expect(t.beats()).toBe(4);
  });

  it('rejects requests with a foreign Host header', async () => {
    const t = await setup();
    // fetch() won't let a caller set Host, so speak raw HTTP.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(t.server.url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }));
    });
    expect(status).toBe(403);
  });

  it('drops the previous session when a new client connects: a killed claude never says goodbye', async () => {
    const { server, client } = await setup();
    const next = new Client({ name: 'respawned', version: '1' });
    await next.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    await expect(client.listTools()).rejects.toThrow(/Session not found/);
    expect((await next.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('stops serving on stop(), and stopping twice is harmless', async () => {
    const t = await setup();
    const url = t.server.url;
    await t.server.stop();
    await t.server.stop();
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
  });
});


import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { insertToolCall } from '../../src/db/toolcalls.ts';
import { McpHttpServer } from '../../src/mcp/server.ts';
import { MemoryStore } from '../../src/stores/memory.ts';
import * as memoryTools from '../../src/tools/memory.ts';
import { expectGoldenTool } from '../golden/tools.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

/** A minimal templated memory file. */
const mem = (body = '', name = 'note', desc = 'a test memory') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;

function setup() {
  const root = join(tempDir(), 'memories');
  mkdirSync(root);
  const store = new MemoryStore(root);
  const put = (sub: string, text: string) => {
    mkdirSync(dirname(join(root, sub)), { recursive: true });
    writeFileSync(join(root, sub), text);
  };
  const get = (sub: string) => readFileSync(join(root, sub), 'utf8');
  return {
    store,
    put,
    get,
    list: memoryTools.memoryListTool(store),
    read: memoryTools.memoryReadTool(store),
    search: memoryTools.memorySearchTool(store),
    write: memoryTools.memoryWriteTool(store),
    append: memoryTools.memoryAppendTool(store),
  };
}

/** The memory tools behind the real MCP server, auditing into a database. */
function serve(store: MemoryStore) {
  const log = memoryLogger();
  const db = openDatabase(join(tempDir(), 'h.db'), log);
  const tools = Object.values(memoryTools).map((factory) => factory(store));
  const server = new McpHttpServer({ tools, log, beat: () => {}, audit: (row) => insertToolCall(db, row) });
  return { server, db, log };
}

describe('memory tools', () => {
  it('are exactly the five memory tools — no delete — matching the tools/list snapshot', () => {
    const tools = Object.values(memoryTools).map((factory) => factory(setup().store));
    expect(tools.map((t) => t.name)).toEqual(['memory_append', 'memory_list', 'memory_read', 'memory_search', 'memory_write']);
    for (const tool of tools) expectGoldenTool(tool);
  });

  it('memory_list shows the description, or the size for a legacy file', async () => {
    const { store, put, list } = setup();
    expect(await list.run({})).toEqual({ content: '(no memory files)' });
    store.write('memories/notes/alice.md', mem('body', 'alice', "Alice's prefs"));
    put('legacy.md', 'old notes\n');
    expect(await list.run({})).toEqual({
      content: "- memories/legacy.md\t10 bytes (no description)\n- memories/notes/alice.md — Alice's prefs",
      data: { files: [{ path: 'memories/legacy.md', description: null }, { path: 'memories/notes/alice.md', description: "Alice's prefs" }] },
    });
  });

  it('memory_search lists hits as path:line: text, best first, and says plainly when nothing matches', async () => {
    const { put, search } = setup();
    put('n.md', 'acme only\nacme deadline today');
    expect(await search.run({ query: 'acme deadline', max_results: 50 })).toEqual({
      content: 'memories/n.md:2: acme deadline today\nmemories/n.md:1: acme only',
      data: { hits: ['memories/n.md', 'memories/n.md'] },
    });
    expect(await search.run({ query: 'missing', max_results: 50 })).toEqual({ content: '(no matches)' });
    expect(search.args.parse({ query: 'x' })).toEqual({ query: 'x', max_results: 50 });
    for (const n of [0, 201, 1.5]) expect(search.args.safeParse({ query: 'x', max_results: n }).success).toBe(false);
  });

  it('memory_read returns the text, and store errors as error results', async () => {
    const { put, read } = setup();
    put('diary.md', 'Day 1: hello\n');
    expect(await read.run({ path: 'memories/diary.md' })).toEqual({ content: 'Day 1: hello\n', data: { path: 'memories/diary.md' } });
    expect(await read.run({ path: 'memories/x.md' })).toEqual({ content: 'memory file not found: memories/x.md', isError: true });
    expect(await read.run({ path: 'notes/x.md' })).toEqual({ content: 'memory path must start with \'memories/\': got "notes/x.md"', isError: true });
  });

  it('memory_write reports the bytes written and refuses a blind overwrite', async () => {
    const { put, get, write } = setup();
    expect(await write.run({ path: 'memories/notes/test.md', content: mem('hi') })).toEqual({
      content: 'wrote 49 bytes to memories/notes/test.md',
      data: { path: 'memories/notes/test.md', bytes: 49 },
    });
    put('policy.md', 'careful');
    expect(await write.run({ path: 'memories/policy.md', content: mem('oops') })).toEqual({
      content: 'refusing to overwrite memories/policy.md: must call memory_read first in this session (read-before-write invariant)',
      isError: true,
    });
    expect(get('policy.md')).toBe('careful');
  });

  it('round-trips list → read → append → write', async () => {
    const { put, get, list, read, append, write } = setup();
    put('diary.md', 'Day 1: hello\n');
    expect((await list.run({})).content).toBe('- memories/diary.md\t13 bytes (no description)');
    expect((await read.run({ path: 'memories/diary.md' })).content).toBe('Day 1: hello\n');
    expect(await append.run({ path: 'memories/diary.md', content: 'Day 2: more\n', description: 'diary' })).toEqual({
      content: 'appended; memories/diary.md is now 65 bytes',
      data: { path: 'memories/diary.md', bytes: 65 },
    });
    expect(get('diary.md')).toBe('---\nname: diary\ndescription: diary\n---\n\nDay 1: hello\nDay 2: more\n');
    expect(await write.run({ path: 'memories/diary.md', content: mem('reset') })).toEqual({ content: 'wrote 52 bytes to memories/diary.md', data: { path: 'memories/diary.md', bytes: 52 } });
    expect(get('diary.md')).toBe(mem('reset'));
  });
});

describe('memory tools behind the MCP server', () => {
  it('show the model the store\'s error text, and audit store errors as results, not exceptions', async () => {
    const { store } = setup();
    const { server, db, log } = serve(store);
    expect(await server.call('memory_read', { path: 'memories/x.md' })).toEqual({
      content: [{ type: 'text', text: 'memory file not found: memories/x.md' }],
      isError: true,
    });
    expect(await server.call('memory_write', { path: 'memories/a.md', content: mem('a') })).toEqual({ content: [{ type: 'text', text: 'wrote 48 bytes to memories/a.md' }], isError: false });
    expect(db.prepare('SELECT tool_name, args_json, result_json, error FROM tool_calls ORDER BY id').all()).toEqual([
      { tool_name: 'memory_read', args_json: '{"path":"memories/x.md"}', result_json: '{"content":"memory file not found: memories/x.md","data":null}', error: null },
      {
        tool_name: 'memory_write',
        args_json: `{"path":"memories/a.md","content":${JSON.stringify(mem('a'))}}`,
        result_json: '{"content":"wrote 48 bytes to memories/a.md","data":{"path":"memories/a.md","bytes":48}}',
        error: null,
      },
    ]);
    expect(log.text()).not.toContain('failed');
  });

  // Each append rewrites the whole file, so interleaved ones would lose updates.
  it('lose no update when appends to one file arrive in parallel', async () => {
    const { store, get } = setup();
    const { server } = serve(store);
    const entries = Array.from({ length: 20 }, (_, i) => `entry ${i}\n`);
    await Promise.all(entries.map((content) => server.call('memory_append', { path: 'memories/log.md', content, description: 'log' })));
    expect(get('log.md')).toBe(`---\nname: log\ndescription: log\n---\n\n${entries.join('')}`);
  });
});

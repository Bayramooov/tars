import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MemoryStore, renderMemoryIndex } from '../../src/stores/memory.ts';
import { loadGolden } from '../golden/load.ts';
import { tempDir } from '../helpers/tmp.ts';

/** A store on a fresh `<tmp>/memories`, with helpers that touch its files behind its back. */
function setup() {
  const base = realpathSync(tempDir());
  const root = join(base, 'memories');
  mkdirSync(root);
  const put = (sub: string, text: string | Buffer) => {
    mkdirSync(dirname(join(root, sub)), { recursive: true });
    writeFileSync(join(root, sub), text);
  };
  const get = (sub: string) => readFileSync(join(root, sub), 'utf8');
  return { base, root, store: new MemoryStore(root), put, get };
}

/** A minimal templated memory file. */
const mem = (body = '', name = 'note', desc = 'a test memory') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;

/** Every entry point that resolves a path must reject it with the same message. */
function expectRejectedEverywhere(store: MemoryStore, path: string, message: string) {
  expect(() => store.read(path)).toThrow(message);
  expect(() => store.write(path, mem('pwned'))).toThrow(message);
  expect(() => store.append(path, 'pwned', 'd')).toThrow(message);
  expect(() => store.resolveReadable(path)).toThrow(message);
}

describe('MemoryStore paths', () => {
  it('requires the exact memories/ prefix', () => {
    const { store } = setup();
    for (const path of ['notes/ref.md', 'data/memories/ref.md', '', 'Memories/x.md', './memories/x.md', ' memories/x.md', '/etc/passwd', '../../../etc/passwd']) {
      expectRejectedEverywhere(store, path, `memory path must start with 'memories/': got "${path}"`);
    }
  });

  it('rejects empty, absolute and dot-dot subpaths on reads and writes alike, naming the stripped subpath', () => {
    const { base, root, store } = setup();
    const cases: [string, string][] = [
      ['memories/', 'memory path must be a non-empty string'],
      ['memories//etc/passwd', `memory path must be relative to ${root}, got "/etc/passwd"`],
      ['memories/memories/../../../etc/passwd', `memory path may not contain '..': "memories/../../../etc/passwd"`],
      ['memories/notes/../../etc/passwd', `memory path may not contain '..': "notes/../../etc/passwd"`],
      ['memories/../../../etc/passwd', `memory path may not contain '..': "../../../etc/passwd"`],
      ['memories/../../secret/passwd', `memory path may not contain '..': "../../secret/passwd"`],
      ['memories/..', `memory path may not contain '..': ".."`],
      ['memories/a\tb/../x', `memory path may not contain '..': "a\\tb/../x"`],
    ];
    for (const [path, message] of cases) expectRejectedEverywhere(store, path, message);
    expect(existsSync(join(base, 'secret'))).toBe(false);
  });

  it('refuses symlinks on the way, so nothing outside the root is read or written', () => {
    const { base, root, store, put } = setup();
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'secret.txt'), 'operator data');
    symlinkSync(join(base, 'outside'), join(root, 'escape'));
    symlinkSync(join(base, 'outside'), join(base, 'intermediate'));
    symlinkSync(join(base, 'intermediate'), join(root, 'evil'));
    symlinkSync(join(base, 'outside', 'secret.txt'), join(root, 'shortcut.md'));
    put('real/inner.md', 'inner');
    symlinkSync(join(root, 'real'), join(root, 'inlnk'));
    expectRejectedEverywhere(store, 'memories/escape/secret.txt', `symlink in memory path: ${root}/escape`);
    expectRejectedEverywhere(store, 'memories/evil/secret.txt', `symlink in memory path: ${root}/evil`);
    expectRejectedEverywhere(store, 'memories/shortcut.md', `symlink in memory path: ${root}/shortcut.md`);
    expectRejectedEverywhere(store, 'memories/inlnk/inner.md', `symlink in memory path: ${root}/inlnk`);
    expect(() => store.write('memories/escape/new.md', mem('pwned'))).toThrow(`symlink in memory path: ${root}/escape`);
    expect(readFileSync(join(base, 'outside', 'secret.txt'), 'utf8')).toBe('operator data');
    expect(existsSync(join(base, 'outside', 'new.md'))).toBe(false);
  });

  it('ignores . and empty components and a trailing slash', () => {
    const { store, put } = setup();
    put('a/b.md', 'nested');
    for (const path of ['memories/a/b.md', 'memories/./a//b.md', 'memories/a/b.md/']) expect(store.read(path)).toBe('nested');
  });

  it('addresses memories/ wherever the root lives, canonicalising a root reached through a symlink', () => {
    const base = realpathSync(tempDir());
    mkdirSync(join(base, 'real', 'elsewhere'), { recursive: true });
    symlinkSync(join(base, 'real'), join(base, 'alias'));
    const store = new MemoryStore(join(base, 'alias', 'elsewhere'));
    expect(store.write('memories/x.md', mem('x'))).toBe(48);
    expect(readFileSync(join(base, 'real', 'elsewhere', 'x.md'), 'utf8')).toBe(mem('x'));
    expect(() => store.read('memories//x')).toThrow(`memory path must be relative to ${join(base, 'real', 'elsewhere')}, got "/x"`);
  });

  it('allows any name or extension; dot-named files are reachable by path but never listed', () => {
    const { store } = setup();
    store.write('memories/data.csv', mem('a,b'));
    store.write('memories/.hidden.md', mem('hidden'));
    expect(store.read('memories/data.csv')).toBe(mem('a,b'));
    expect(store.read('memories/.hidden.md')).toBe(mem('hidden'));
    expect(store.list().map((f) => f.path)).toEqual(['memories/data.csv']);
  });

  it('has no way to delete a memory', () => {
    const methods = Object.getOwnPropertyNames(MemoryStore.prototype);
    for (const forbidden of ['delete', 'edit', 'remove', 'unlink', 'rm', 'drop']) expect(methods).not.toContain(forbidden);
    expect(methods).toEqual(expect.arrayContaining(['list', 'read', 'search', 'write', 'append', 'resolveReadable']));
  });
});

describe('MemoryStore.read', () => {
  it('returns the file verbatim — CR, BOM and all — and fails on anything but a regular file', () => {
    const { root, store, put } = setup();
    put('fact.md', 'the sky is blue');
    put('bom.md', '\u{FEFF}hello\r\nworld\r');
    put('bin.md', Buffer.from([0x6f, 0x6b, 0xff, 0xed, 0xa0, 0x80, 0xe2, 0x82]));
    mkdirSync(join(root, 'sub'));
    expect(store.read('memories/fact.md')).toBe('the sky is blue');
    expect(store.read('memories/bom.md')).toBe('\u{FEFF}hello\r\nworld\r');
    expect(store.read('memories/bin.md')).toBe(`ok${'\u{FFFD}'.repeat(5)}`);
    expect(() => store.read('memories/nope.md')).toThrow('memory file not found: memories/nope.md');
    expect(() => store.read('memories/sub')).toThrow('memory file not found: memories/sub');
    expect(() => store.read('memories/fact.md/x')).toThrow('memory file not found: memories/fact.md/x');
  });

  it('cuts files over 64 KiB at the byte cap and says so', () => {
    const { store, put } = setup();
    put('big.md', 'x'.repeat(200_000));
    put('exact.md', 'y'.repeat(65536));
    put('split.md', `${'y'.repeat(65535)}é`);
    expect(store.read('memories/big.md')).toBe(`${'x'.repeat(65536)}\n\n[truncated to 65536 bytes]`);
    expect(store.read('memories/exact.md')).toBe('y'.repeat(65536));
    expect(store.read('memories/split.md')).toBe(`${'y'.repeat(65535)}\u{FFFD}\n\n[truncated to 65536 bytes]`);
  });
});

describe('read-before-write', () => {
  it('refuses to overwrite or append to a file this store never read, leaving it intact', () => {
    const { store, put, get } = setup();
    put('policy.md', 'CRITICAL: do not delete this');
    expect(() => store.write('memories/policy.md', mem('lol replaced'))).toThrow(
      'refusing to overwrite memories/policy.md: must call memory_read first in this session (read-before-write invariant)',
    );
    expect(() => store.append('memories/policy.md', 'more', 'desc')).toThrow(
      'refusing to append to memories/policy.md: must call memory_read first in this session (read-before-write invariant)',
    );
    expect(get('policy.md')).toBe('CRITICAL: do not delete this');
  });

  it('is unlocked by a read, or by this store writing the file; spellings of one path share the credit', () => {
    const { store, put, get } = setup();
    put('policy.md', 'v1');
    expect(store.read('memories/policy.md')).toBe('v1');
    store.write('memories/policy.md', mem('v2'));
    expect(get('policy.md')).toBe(mem('v2'));
    store.write('memories/journal.md', mem('entry 1'));
    store.write('memories/journal.md', mem('entry 2'));
    store.append('memories/log.md', 'a', 'log');
    store.append('memories/log.md', 'b', 'log');
    expect(get('log.md')).toBe('---\nname: log\ndescription: log\n---\n\nab');
    put('al/b.md', 'alias');
    store.read('memories/al/./b.md');
    expect(store.write('memories/al//b.md', mem('aliased'))).toBe(54);
  });

  it('is not unlocked by search, list, resolveReadable or a failed read', () => {
    const { store, put, get } = setup();
    put('policy.md', 'CRITICAL config');
    expect(store.search('config', 50)).toHaveLength(1);
    store.list();
    store.resolveReadable('memories/policy.md');
    expect(() => store.write('memories/policy.md', mem('overwritten'))).toThrow('read-before-write');
    expect(() => store.read('memories/later.md')).toThrow('memory file not found');
    put('later.md', 'appeared afterwards');
    expect(() => store.write('memories/later.md', mem('x'))).toThrow('read-before-write');
    expect(get('policy.md')).toBe('CRITICAL config');
  });

  it('lasts only as long as the store: a new instance must read again', () => {
    const { root, store } = setup();
    store.write('memories/doc.md', mem('first run wrote this'));
    expect(() => new MemoryStore(root).write('memories/doc.md', mem('second run blindly overwrites'))).toThrow('read-before-write');
  });

  it('still requires a regular file once unlocked', () => {
    const { root, store, put } = setup();
    put('x.md', 'a');
    store.read('memories/x.md');
    rmSync(join(root, 'x.md'));
    mkdirSync(join(root, 'x.md'));
    expect(() => store.write('memories/x.md', mem())).toThrow('memories/x.md exists but is not a regular file');
    expect(() => store.append('memories/x.md', 'b', 'd')).toThrow('memories/x.md exists but is not a regular file');
  });
});

describe('MemoryStore.write', () => {
  it('creates the file and its parents, stores the content verbatim and returns its UTF-8 size', () => {
    const { store, get } = setup();
    const content = mem('Alice loves cats — и собак', 'alice', "Alice's profile");
    expect(store.write('memories/notes/users/alice.md', content)).toBe(Buffer.byteLength(content));
    expect(get('notes/users/alice.md')).toBe(content);
    store.write('memories/a/b/c/deep.md', mem('x'));
    expect(get('a/b/c/deep.md')).toBe(mem('x'));
  });

  it('requires name/description frontmatter, checked before the path, and writes nothing otherwise', () => {
    const { store, root } = setup();
    const rejected: [string, string][] = [
      ['just a plain note, no frontmatter', "memory file must start with YAML frontmatter delimiter '---'"],
      ['---\nname: a\n', "memory file frontmatter block is not closed with '---'"],
      ['---\n- a\n---\n', 'memory file frontmatter must be a YAML mapping'],
      ['---\ndescription: only a description\n---\n\nbody', "memory file frontmatter must include a non-empty 'name' field"],
      ['---\nname: 123\ndescription: d\n---\n', "memory file frontmatter must include a non-empty 'name' field"],
      ['---\nname: just-a-name\n---\n\nbody', "memory file frontmatter must include a non-empty 'description' field"],
      ["---\nname: a\ndescription: '   '\n---\n", "memory file frontmatter must include a non-empty 'description' field"],
      [mem('body', 'n'.repeat(65)), 'memory file name exceeds 64 chars'],
      [mem('body', 'note', 'd'.repeat(1025)), 'memory file description exceeds 1024 chars (1025)'],
    ];
    for (const [content, message] of rejected) expect(() => store.write('memories/n.md', content)).toThrow(message);
    expect(() => store.write('../x', 'no frontmatter')).toThrow("memory file must start with YAML frontmatter delimiter '---'");
    expect(existsSync(join(root, 'n.md'))).toBe(false);
  });

  it('caps a file at 64 KiB of UTF-8', () => {
    const { store, root } = setup();
    const atCap = mem() + 'x'.repeat(65536 - Buffer.byteLength(mem()));
    expect(store.write('memories/ceiling.md', atCap)).toBe(65536);
    expect(() => store.write('memories/huge.md', mem('x'.repeat(65536)))).toThrow('memory file too large: 65583 bytes > 65536 cap');
    expect(() => store.write('memories/wide.md', mem('é'.repeat(40000)))).toThrow('memory file too large: 80047 bytes > 65536 cap');
    expect(existsSync(join(root, 'huge.md'))).toBe(false);
  });
});

describe('MemoryStore.append', () => {
  it('starts a new file on the template, named after its stem, and keeps the body growing', () => {
    const { store, get } = setup();
    expect(store.append('memories/notes/journal.md', 'first entry\n', 'running journal')).toBe(64);
    expect(get('notes/journal.md')).toBe('---\nname: journal\ndescription: running journal\n---\n\nfirst entry\n');
    store.append('memories/notes/journal.md', 'second entry', 'two entries');
    expect(get('notes/journal.md')).toBe('---\nname: journal\ndescription: two entries\n---\n\nfirst entry\nsecond entry');
  });

  it('migrates a legacy file onto the template, keeping all of it as the body', () => {
    const { store, put, get } = setup();
    put('scratch.md', 'old line\n');
    put('bad.md', '---\nname: [unclosed\n---\nbody\n');
    store.read('memories/scratch.md');
    store.read('memories/bad.md');
    store.append('memories/scratch.md', 'new line\n', 'scratch notes');
    store.append('memories/bad.md', '!', 'was malformed');
    expect(get('scratch.md')).toBe('---\nname: scratch\ndescription: scratch notes\n---\n\nold line\nnew line\n');
    expect(get('bad.md')).toBe('---\nname: bad\ndescription: was malformed\n---\n\n---\nname: [unclosed\n---\nbody\n!');
  });

  it('keeps the stored name, drops other keys, leaves one blank line and turns CRLF into LF', () => {
    const { store, put, get } = setup();
    put('extra.md', '---\r\nname: keep-me\r\ndescription: old\r\ntags: [a, b]\r\n---\r\n\r\n\r\nbody\r\nkept\r');
    put('numname.md', '---\nname: 123\ndescription: x\n---\nbody');
    store.read('memories/extra.md');
    store.read('memories/numname.md');
    store.append('memories/extra.md', 'more', 'new summary');
    store.append('memories/numname.md', '+', 'no string name');
    expect(get('extra.md')).toBe('---\nname: keep-me\ndescription: new summary\n---\n\nbody\nkept\nmore');
    expect(get('numname.md')).toBe('---\nname: numname\ndescription: no string name\n---\n\nbody+');
  });

  it('derives the name from the file stem and validates it', () => {
    const { store, get } = setup();
    store.append('memories/a.b.c', 'x', 'd');
    store.append('memories/x.', 'x', 'd');
    store.append('memories/.env', 'x', 'd');
    store.append('memories/2024-01-01.md', 'x', 'd');
    expect([get('a.b.c'), get('x.'), get('.env'), get('2024-01-01.md')].map((text) => text.split('\n')[1])).toEqual([
      'name: a.b',
      'name: x.',
      'name: .env',
      'name: 2024-01-01',
    ]);
    expect(() => store.append(`memories/${'s'.repeat(65)}.md`, 'x', 'd')).toThrow('memory file name exceeds 64 chars');
  });

  it('validates the description and the 64 KiB total', () => {
    const { store, get } = setup();
    expect(() => store.append('memories/d.md', 'x', '   ')).toThrow("memory file frontmatter must include a non-empty 'description' field");
    expect(() => store.append('memories/d.md', 'x', 'd'.repeat(1025))).toThrow('memory file description exceeds 1024 chars (1025)');
    store.write('memories/file.md', mem('x'.repeat(65536 - 200)));
    expect(() => store.append('memories/file.md', 'y'.repeat(300), 'desc')).toThrow('append would exceed cap: 65674 bytes > 65536');
    expect(get('file.md')).toBe(mem('x'.repeat(65536 - 200)));
  });

  it('writes descriptions as YAML that reads back the same', () => {
    const { store, get } = setup();
    const descriptions = ['ratio is 3:1, see notes', 'has: colon space', 'yes', 'emoji 👍 тест', '#hash', 'trailing space '];
    descriptions.forEach((d, i) => store.append(`memories/d${i}.md`, 'x', d));
    expect(store.list().map((f) => f.description)).toEqual(descriptions.map((d) => d.trim()));
    expect(descriptions.map((_, i) => get(`d${i}.md`).split('\n')[2])).toEqual([
      'description: ratio is 3:1, see notes',
      'description: "has: colon space"',
      'description: yes',
      'description: emoji 👍 тест',
      'description: "#hash"',
      'description: "trailing space "',
    ]);
  });
});

describe('MemoryStore.list', () => {
  it('lists regular files by full path in sorted order with their size and description', () => {
    const { base, root, store, put } = setup();
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'o.md'), 'outside');
    put('real.md', 'a');
    put('.hidden', 'b');
    symlinkSync(join(base, 'outside', 'o.md'), join(root, 'link.md'));
    symlinkSync(join(base, 'outside'), join(root, 'linkdir'));
    put('.hid/h.md', '---\nname: h\ndescription: in a hidden dir\n---\n');
    put('a/x.md', 'ax');
    put('a-b/x.md', 'abx');
    expect(store.list()).toEqual([
      { path: 'memories/.hid/h.md', size: 45, description: 'in a hidden dir' },
      { path: 'memories/a-b/x.md', size: 3, description: undefined },
      { path: 'memories/a/x.md', size: 2, description: undefined },
      { path: 'memories/real.md', size: 1, description: undefined },
    ]);
  });

  it('reads descriptions best effort: stripped, and absent when missing, blank, not a string or unparsable', () => {
    const { store, put } = setup();
    put('t1.md', "---\nname: t\ndescription: '  padded  '\n---\n");
    put('t2.md', '---\nname: t\ndescription: 5\n---\n');
    put('t3.md', "---\nname: t\ndescription: '   '\n---\n");
    put('t4.md', '---\rname: t\rdescription: cr only\r---\rbody');
    put('t5.md', '---\nname: t\ndescription: [bad\n---\n');
    put('t6.md', Buffer.from('---\nname: t\ndescription: caf\xe9\n---\n', 'latin1'));
    expect(store.list().map((f) => f.description)).toEqual(['padded', undefined, undefined, 'cr only', undefined, 'caf\u{FFFD}']);
  });

  it('is empty when the root does not exist yet', () => {
    expect(new MemoryStore(join(tempDir(), 'missing')).list()).toEqual([]);
  });
});

describe('MemoryStore.search', () => {
  it('finds lines holding any term, case-insensitively, best first, across files', () => {
    const { store, put } = setup();
    put('notes.md', 'first line\nthe budget was approved\nlast');
    put('a.md', 'auth uses JWT');
    put('b.md', 'the Authentication flow');
    put('n.md', `only the deadline matters\nacme deadline today\n${'acme only\n'.repeat(5)}`);
    const hit = (path: string, lineNumber: number, line: string, score: number) => ({ path: `memories/${path}`, lineNumber, line, score });
    expect(store.search('budget', 50)).toEqual([hit('notes.md', 2, 'the budget was approved', 1)]);
    expect(store.search('AUTH', 50)).toEqual([hit('a.md', 1, 'auth uses JWT', 1), hit('b.md', 1, 'the Authentication flow', 1)]);
    expect(store.search('acme deadline', 2)).toEqual([hit('n.md', 2, 'acme deadline today', 2), hit('n.md', 1, 'only the deadline matters', 1)]);
    expect(store.search('acme deadline', 50)).toHaveLength(7);
    expect(store.search('acme acme', 1)).toEqual([hit('n.md', 2, 'acme deadline today', 2)]);
    expect(store.search('absent', 50)).toEqual([]);
    expect(store.search(' \t\u{3000} ', 50)).toEqual([]);
  });

  it('breaks lines only at LF, CRLF and CR, splits terms on any whitespace and trims the reported line', () => {
    const { store, put } = setup();
    put('lb.md', 'a\vb key\fc key\x1cd key\x85e key\u{2028}f key\r\ng key\rh key\n');
    put('sp.md', '  \u{A0} spaced key\t \n---\nname: fm\n---\n');
    put('.hidden.md', 'key hidden');
    const lines = (query: string) => store.search(query, 50).map((h) => `${h.path}:${h.lineNumber}: ${h.line}`);
    expect(lines('key')).toEqual(['memories/lb.md:1: a\vb key\fc key\x1cd key\x85e key\u{2028}f key', 'memories/lb.md:2: g key', 'memories/lb.md:3: h key', 'memories/sp.md:1: spaced key']);
    expect(lines('fm\u{3000}spaced')).toEqual(['memories/sp.md:1: spaced key', 'memories/sp.md:3: name: fm']);
  });
});

interface ArgvGolden {
  cases: { argv: string[] }[];
}

describe('renderMemoryIndex', () => {
  it('renders the "# Your memory" block exactly as the golden system prompt has it', () => {
    const { store, put } = setup();
    // The fixture memories the golden prompts were rendered from.
    put('notes/references.md', '---\nname: references\ndescription: Useful links\n---\n\n- x\n');
    put('people.md', '---\nname: people\ndescription: Who is who\n---\n\nAlice.\n');
    put('legacy.md', 'no frontmatter at all\n');
    const argv = loadGolden<ArgvGolden>('argv.json').cases[0]?.argv ?? [];
    const prompt = argv[argv.indexOf('--system-prompt') + 1] ?? '';
    const start = prompt.indexOf('# Your memory');
    expect(start).toBeGreaterThan(0);
    expect(renderMemoryIndex(store)).toBe(prompt.slice(start, prompt.indexOf('\n\n# Your tools', start)));
  });

  it('is empty when there are no memories', () => {
    expect(renderMemoryIndex(setup().store)).toBe('');
  });
});

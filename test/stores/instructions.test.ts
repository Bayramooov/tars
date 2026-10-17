import type * as Fs from 'node:fs';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InstructionsStore } from '../../src/stores/instructions.ts';
import { tempDir } from '../helpers/tmp.ts';

// renameSync passes through to the real one unless a test makes it fail once.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(renameSync).mockClear();
});

const MAX = 128 * 1024;

function setup() {
  const dir = tempDir();
  const path = join(dir, 'prompts', 'project.md');
  mkdirSync(dirname(path));
  writeFileSync(path, 'PROJECT v1\n');
  const backups = join(dir, 'backups');
  return { dir, path, backups, store: new InstructionsStore(path, backups) };
}

const failRenameOnce = (code: string) =>
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw Object.assign(new Error(`${code}: rename failed`), { code });
  });

describe('InstructionsStore.read', () => {
  it('returns the file text', () => {
    expect(setup().store.read()).toBe('PROJECT v1\n');
  });

  it('decodes strict UTF-8 with every newline as LF, keeping a BOM and refusing invalid bytes', () => {
    const { path, store } = setup();
    writeFileSync(path, '\u{FEFF}a\r\nb\rc\n');
    expect(store.read()).toBe('\u{FEFF}a\nb\nc\n');
    writeFileSync(path, Buffer.from([0x61, 0xff]));
    expect(() => store.read()).toThrow();
  });

  it('refuses every operation when project.md is missing (it is never created)', () => {
    const { path, store } = setup();
    unlinkSync(path);
    const missing = `project.md not present at ${realpathSync(dirname(path))}/project.md`;
    expect(() => store.read()).toThrow(missing);
    expect(() => store.append('anything\n')).toThrow(missing);
    expect(() => store.rewrite('anything\n')).toThrow(missing);
  });
});

describe('InstructionsStore.append / rewrite', () => {
  it('appends verbatim and returns the new size and a backup of the old body', () => {
    const { path, store } = setup();
    const { bytes, backup } = store.append('line 2 — ok\n');
    expect(readFileSync(path, 'utf8')).toBe('PROJECT v1\nline 2 — ok\n');
    expect(bytes).toBe(Buffer.byteLength('PROJECT v1\nline 2 — ok\n'));
    expect(readFileSync(backup, 'utf8')).toBe('PROJECT v1\n');
  });

  it('rewrite replaces the body and backs up the old one', () => {
    const { path, store } = setup();
    const { bytes, backup } = store.rewrite('PROJECT v2\n');
    expect(readFileSync(path, 'utf8')).toBe('PROJECT v2\n');
    expect(bytes).toBe(11);
    expect(readFileSync(backup, 'utf8')).toBe('PROJECT v1\n');
  });

  it('caps the resulting size at 128 KiB, before any backup or write', () => {
    const { path, backups, store } = setup();
    writeFileSync(path, 'y'.repeat(MAX - 100));
    expect(() => store.append('z'.repeat(200))).toThrow(`append would exceed cap: ${MAX + 100} bytes > 131072`);
    expect(() => store.rewrite('z'.repeat(MAX + 1))).toThrow(`rewrite would exceed cap: ${MAX + 1} bytes > 131072`);
    expect(readFileSync(path, 'utf8')).toBe('y'.repeat(MAX - 100));
    expect(() => readdirSync(backups)).toThrow();
    expect(store.append('z'.repeat(100)).bytes).toBe(MAX);
  });

  it("names backups project-<UTC stamp>Z.md and keeps the file's timestamps", () => {
    const { path, backups, store } = setup();
    const modified = new Date('2020-01-02T03:04:05Z');
    utimesSync(path, modified, modified);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T01:02:03.456Z'));
    const { backup } = store.append('more\n');
    expect(backup).toBe(join(realpathSync(backups), 'project-20261017T010203Z.md'));
    expect(statSync(backup).mtime).toEqual(modified);
    // Same second, same name: the second backup replaces the first.
    store.rewrite('PROJECT v3\n');
    expect(readdirSync(backups)).toEqual(['project-20261017T010203Z.md']);
    expect(readFileSync(backup, 'utf8')).toBe('PROJECT v1\nmore\n');
  });

  it('writes atomically, leaving no project.md.tmp', () => {
    const { path, store } = setup();
    store.append('more\n');
    store.rewrite('PROJECT v2\n');
    expect(readdirSync(dirname(path))).toEqual(['project.md']);
  });

  it('falls back to an in-place write when rename hits EBUSY (single-file bind mount)', () => {
    const { path, store } = setup();
    failRenameOnce('EBUSY');
    store.append('line 2\n');
    expect(readFileSync(path, 'utf8')).toBe('PROJECT v1\nline 2\n');
    failRenameOnce('EBUSY');
    store.rewrite('PROJECT v2\n');
    expect(readFileSync(path, 'utf8')).toBe('PROJECT v2\n');
    expect(readdirSync(dirname(path))).toEqual(['project.md']);
    expect(vi.mocked(renameSync).mock.results.map((r) => r.type)).toEqual(['throw', 'throw']);
  });

  it('surfaces any other rename failure and removes the tmp file', () => {
    const { path, store } = setup();
    failRenameOnce('EACCES');
    expect(() => store.append('line 2\n')).toThrow('EACCES: rename failed');
    expect(readFileSync(path, 'utf8')).toBe('PROJECT v1\n');
    expect(readdirSync(dirname(path))).toEqual(['project.md']);
  });

  it('edits the target of a symlinked project.md and keeps the link', () => {
    const { dir, backups } = setup();
    const target = join(dir, 'overlay.md');
    writeFileSync(target, 'v1\n');
    const link = join(dir, 'prompts', 'linked.md');
    symlinkSync(target, link);
    const { backup } = new InstructionsStore(link, backups).append('v2\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('v1\nv2\n');
    expect(basename(backup)).toMatch(/^project-\d{8}T\d{6}Z\.md$/);
  });
});

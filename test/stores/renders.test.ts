import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RenderStore } from '../../src/stores/renders.ts';
import { tempDir } from '../helpers/tmp.ts';

const PNG = Buffer.from('\x89PNG\r\n\x1a\nfake');

function store(): RenderStore {
  return new RenderStore(join(tempDir(), 'renders'));
}

afterEach(() => vi.useRealTimers());

describe('RenderStore.save', () => {
  it('names a render by UTC stamp, slug and random hex, and writes the bytes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T14:30:05.999Z'));
    const s = store();
    const a = s.save('My Report', PNG);
    const b = s.save('My Report', PNG);
    expect(a).toMatch(/^20261017T143005-my-report-[0-9a-f]{6}\.png$/);
    expect(b).not.toBe(a);
    expect(readFileSync(join(s.root, a))).toEqual(PNG);
  });

  it('leaves the slug segment out when there is no title or it slugs to nothing', () => {
    const s = store();
    expect(s.save(null, PNG)).toMatch(/^\d{8}T\d{6}-[0-9a-f]{6}\.png$/);
    expect(s.save('', PNG)).toMatch(/^\d{8}T\d{6}-[0-9a-f]{6}\.png$/);
    expect(s.save('Привет', PNG)).toMatch(/^\d{8}T\d{6}-[0-9a-f]{6}\.png$/);
  });

  // lowercasing comes first, so "İ" leaves an "i" and the Kelvin sign a "k"
  it.each([
    ['My Report', 'my-report'],
    ['  --Hello, World!--  ', 'hello-world'],
    ['Отчёт 2024', '2024'],
    ['Q3 Sales: EMEA/APAC', 'q3-sales-emea-apac'],
    ['İstanbul', 'i-stanbul'],
    [`${'a'.repeat(39)} b`, `${'a'.repeat(39)}-`],
    ['x'.repeat(100), 'x'.repeat(40)],
    ['Ünïcödé Tëst', 'n-c-d-t-st'],
    ['KELVIN \u{212A}', 'kelvin-k'],
    ['ß straße', 'stra-e'],
    ['a--b__c', 'a-b-c'],
    [`${'-'.repeat(50)}z`, 'z'],
  ])('slugs %j as %j', (title, slug) => {
    expect(store().save(title, PNG)).toMatch(new RegExp(`^\\d{8}T\\d{6}-${slug}-[0-9a-f]{6}\\.png$`));
  });

  it('recreates the directory if the operator deleted it', () => {
    const s = store();
    rmSync(s.root, { recursive: true });
    expect(s.isFile(join(s.root, s.save('x', PNG)))).toBe(true);
  });
});

describe('RenderStore.resolvePath / isFile', () => {
  it('resolves a saved name back to its file', () => {
    const s = store();
    const name = s.save('chart', PNG);
    expect(s.resolvePath(name)).toBe(join(s.root, name));
    expect(s.isFile(s.resolvePath(name))).toBe(true);
    expect(s.isFile(s.resolvePath('missing.png'))).toBe(false);
  });

  it.each([
    ['', 'render path must be a non-empty string'],
    ['/etc/passwd', 'render path must be relative to <root>, got "/etc/passwd"'],
    ['../../../etc/passwd', `render path may not contain '..': "../../../etc/passwd"`],
    ['a/../../b.png', `render path may not contain '..': "a/../../b.png"`],
  ])('rejects %j', (path, message) => {
    const s = store();
    expect(() => s.resolvePath(path)).toThrow(message.replace('<root>', s.root));
  });

  it('rejects a symlink inside the root', () => {
    const s = store();
    const outside = join(tempDir(), 'secret.png');
    writeFileSync(outside, PNG);
    symlinkSync(outside, join(s.root, 'link.png'));
    expect(() => s.resolvePath('link.png')).toThrow(`symlink in render path: ${join(s.root, 'link.png')}`);
  });

  it('works on the canonical root when the configured path goes through a symlink', () => {
    const real = join(tempDir(), 'real');
    mkdirSync(real);
    const link = join(tempDir(), 'link');
    symlinkSync(real, link);
    const s = new RenderStore(link);
    const name = s.save(null, PNG);
    expect(s.root).not.toBe(link);
    expect(s.resolvePath(name)).toBe(join(s.root, name));
  });
});

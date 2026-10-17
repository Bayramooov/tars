import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveUnderRoot } from '../../src/stores/paths.ts';
import { tempDir } from '../helpers/tmp.ts';

function setup() {
  const root = realpathSync(tempDir());
  return { root, resolve: (relative: string) => resolveUnderRoot(root, relative, 'memory') };
}

describe('resolveUnderRoot', () => {
  it('rejects empty, absolute and dot-dot paths, in that order', () => {
    const { root, resolve } = setup();
    expect(() => resolve('')).toThrow('memory path must be a non-empty string');
    expect(() => resolve('/etc/passwd')).toThrow(`memory path must be relative to ${root}, got "/etc/passwd"`);
    expect(() => resolve('..')).toThrow(`memory path may not contain '..': ".."`);
    expect(() => resolve('notes/../../etc/passwd')).toThrow(`memory path may not contain '..': "notes/../../etc/passwd"`);
    expect(() => resolve('a/\0b')).toThrow(/^could not stat /);
  });

  it('drops empty and . components and keeps every other name verbatim', () => {
    const { root, resolve } = setup();
    expect(resolve('.')).toBe(root);
    for (const path of ['./a/f.md', 'a//f.md', 'a/./f.md']) expect(resolve(path)).toBe(join(root, 'a', 'f.md'));
    expect(resolve('a/')).toBe(join(root, 'a'));
    for (const name of ['...', 'a\\..\\b', ' ', '~/x', 'new/dir/file.md']) expect(resolve(name)).toBe(join(root, name));
  });

  it('refuses every symlink on the way, even dangling ones or links inside the root', () => {
    const { root, resolve } = setup();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'f.md'), 'x');
    symlinkSync(join(root, 'real'), join(root, 'inlnk'));
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
    symlinkSync(join(root, 'real', 'f.md'), join(root, 'real', 'alias.md'));
    expect(() => resolve('inlnk/f.md')).toThrow(`symlink in memory path: ${join(root, 'inlnk')}`);
    expect(() => resolve('dangling')).toThrow(`symlink in memory path: ${join(root, 'dangling')}`);
    expect(() => resolve('real/alias.md')).toThrow(`symlink in memory path: ${join(root, 'real', 'alias.md')}`);
    expect(resolve('real/f.md')).toBe(join(root, 'real', 'f.md'));
  });
});

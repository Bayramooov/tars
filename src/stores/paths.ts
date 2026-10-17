import { lstatSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Resolve `relative` inside `root` (which must already be canonical), the
 * way every store does it: non-empty, relative, no `..` component, no
 * symlink anywhere on the way, and still under `root` once resolved.
 * `noun` names the store in messages ("memory", "attachment", "render").
 */
export function resolveUnderRoot(root: string, relative: string, noun: string): string {
  if (!relative) throw new Error(`${noun} path must be a non-empty string`);
  if (isAbsolute(relative)) throw new Error(`${noun} path must be relative to ${root}, got ${JSON.stringify(relative)}`);
  // Empty and "." components vanish, ".." stays.
  const parts = relative.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) throw new Error(`${noun} path may not contain '..': ${JSON.stringify(relative)}`);
  let check = root;
  for (const part of parts) {
    check = `${check}${sep}${part}`;
    if (isSymlink(check)) throw new Error(`symlink in ${noun} path: ${check}`);
  }
  const resolved = resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error(`resolved ${noun} path escapes root: ${resolved} not under ${root}`);
  return resolved;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw new Error(`could not stat ${path}: ${(err as Error).message}`, { cause: err });
  }
}

import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Replace `path` atomically: write `<path>.tmp`, then rename it over `path`.
 * A single-file Docker bind mount refuses the rename with EBUSY; then the
 * file is written in place. The tmp file never outlives a failed rename.
 */
export function writeAtomic(path: string, data: Uint8Array): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
    writeFileSync(path, data);
  }
}

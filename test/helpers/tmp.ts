import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach } from 'vitest';

/** A fresh temp directory, removed after the current test. */
export function tempDir(prefix = 'tars-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

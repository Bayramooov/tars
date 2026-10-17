import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { acquireInstanceLock } from '../src/lock.ts';
import { tempDir } from './helpers/tmp.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('entry point', () => {
  it('exits 1 on invalid configuration, before touching the network', () => {
    // Real environment variables win over a local .env, so this fails at config parsing whatever .env holds.
    const run = spawnSync(process.execPath, [MAIN], { env: { PATH: process.env.PATH, TARS_LOG_LEVEL: 'LOUD', TELEGRAM_BOT_TOKEN: '' }, encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown log level "LOUD"');
  });

  it('exits 1 when another instance holds the data directory, without writing into its log', () => {
    const dataDir = tempDir();
    const release = acquireInstanceLock(dataDir);
    try {
      const env = { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: '1:test', TARS_OWNER_ID: '1', TARS_MODEL: 'm', TARS_EFFORT: 'high', TARS_DATA_DIR: dataDir };
      const run = spawnSync(process.execPath, [MAIN], { env, encoding: 'utf8', timeout: 20_000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('another tars instance is already running');
      expect(existsSync(join(dataDir, 'logs'))).toBe(false);
    } finally {
      release();
    }
  });
});

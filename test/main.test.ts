import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('entry point', () => {
  it('exits 1 on invalid configuration, before touching the network', () => {
    // Real environment variables win over a local .env, so this fails at config parsing whatever .env holds.
    const run = spawnSync(process.execPath, [MAIN], { env: { PATH: process.env.PATH, TARS_LOG_LEVEL: 'LOUD', TELEGRAM_BOT_TOKEN: '' }, encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown log level "LOUD"');
  });
});

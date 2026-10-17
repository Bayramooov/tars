import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, PROJECT_ROOT } from '../src/config.ts';

const REQUIRED = { TELEGRAM_BOT_TOKEN: '1:t', TARS_OWNER_ID: '42', TARS_MODEL: 'm', TARS_EFFORT: 'high' };
const load = (env: Record<string, string> = {}) => loadConfig({ ...REQUIRED, ...env }, '/srv/app');

describe('config', () => {
  it('requires the four core variables and parses the owner id', () => {
    expect(() => loadConfig({}, '/x')).toThrow('missing required environment variable: TELEGRAM_BOT_TOKEN');
    expect(() => loadConfig({ ...REQUIRED, TARS_OWNER_ID: 'abc' }, '/x')).toThrow('TARS_OWNER_ID must be an integer, got "abc"');
    expect(load()).toMatchObject({ telegramBotToken: '1:t', ownerId: 42, model: 'm', effort: 'high', claudeCodeBin: 'claude' });
  });

  it('treats empty as unset and parses numbers, surrounding spaces allowed', () => {
    expect(load({ TARS_DEBOUNCE_MS: '' }).debounceMs).toBe(0);
    expect(load({ TARS_RATE_LIMIT_PER_MIN: ' 1000 ' }).rateLimitPerMin).toBe(1000);
    expect(() => load({ TARS_RATE_LIMIT_PER_MIN: '1_000' })).toThrow('TARS_RATE_LIMIT_PER_MIN must be an integer, got "1_000"');
    expect(load({ TARS_CRASH_BACKOFF_BASE: '0.5' }).crashBackoffBase).toBe(0.5);
    expect(load({ TARS_LIVENESS_TIMEOUT_SECONDS: '1e3' }).livenessTimeoutSeconds).toBe(1000);
    expect(() => load({ TARS_CRASH_LIMIT: '10.0' })).toThrow('TARS_CRASH_LIMIT must be an integer, got "10.0"');
    expect(() => load({ TARS_CRASH_BACKOFF_CAP: 'soon' })).toThrow('TARS_CRASH_BACKOFF_CAP must be a number, got "soon"');
  });

  it('reads booleans: 1/true/yes/on are true, anything else false', () => {
    for (const yes of ['1', 'true', 'YES', ' on ']) expect(load({ TARS_BROWSER_HEADLESS: yes }).browserHeadless).toBe(true);
    for (const no of ['0', 'false', 'no', 'off', 'maybe']) expect(load({ TARS_SELF_REFLECTION_ENABLED: no }).selfReflectionEnabled).toBe(false);
    expect(load().selfReflectionEnabled).toBe(true);
  });

  it('validates the log level and transcript mode', () => {
    expect(load({ TARS_LOG_LEVEL: 'warn' }).logLevel).toBe('WARNING');
    expect(() => load({ TARS_LOG_LEVEL: 'loud' })).toThrow('unknown log level "loud"');
    expect(load({ TARS_LOG_TRANSCRIPT: 'FULL' }).logTranscript).toBe('full');
    expect(() => load({ TARS_LOG_TRANSCRIPT: 'all' })).toThrow('TARS_LOG_TRANSCRIPT must be "compact" or "full", got "all"');
  });

  it('derives data paths from TARS_DATA_DIR and operator files from the repo root', () => {
    const config = load({ TARS_DATA_DIR: 'var/data', TARS_ACCESS_PATH: 'conf/access.json' });
    expect(config.dataDir).toBe('/srv/app/var/data');
    expect(config.dbPath).toBe('/srv/app/var/data/tars.db');
    expect(config.sessionIdPath).toBe('/srv/app/var/data/session_id');
    expect(config.logDir).toBe('/srv/app/var/data/logs');
    expect(config.accessPath).toBe('/srv/app/conf/access.json');
    expect(config.pluginsPath).toBe(resolve(PROJECT_ROOT, 'plugins.json'));
    expect(config.memoriesDir).toBe(resolve(PROJECT_ROOT, 'memories'));
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('turns self-reflection on by default at midnight UTC; any value but 1/true/yes/on turns it off', () => {
    expect(load()).toMatchObject({ selfReflectionEnabled: true, selfReflectionCron: '0 0 * * *' });
    expect(load({ TARS_SELF_REFLECTION_ENABLED: '', TARS_SELF_REFLECTION_CRON: '' })).toMatchObject({ selfReflectionEnabled: true, selfReflectionCron: '0 0 * * *' });
    expect(load({ TARS_SELF_REFLECTION_ENABLED: '  ', TARS_SELF_REFLECTION_CRON: '30 2 * * 1' })).toMatchObject({ selfReflectionEnabled: false, selfReflectionCron: '30 2 * * 1' });
  });
});


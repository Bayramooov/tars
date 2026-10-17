import { existsSync } from 'node:fs';

import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserManager } from '../../src/browser/manager.ts';
import { memoryLogger } from '../helpers/log.ts';

// Real Chromium; skipped where `npx playwright install chromium` hasn't run.
const HAS_CHROMIUM = existsSync(chromium.executablePath());
const VIEWPORT = { width: 800, height: 600 };

describe.skipIf(!HAS_CHROMIUM)('BrowserManager', () => {
  const managers: BrowserManager[] = [];
  const manager = (log = memoryLogger()) => {
    const created = new BrowserManager({ headless: true, log });
    managers.push(created);
    return created;
  };
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
  });

  it('launches once, even for concurrent callers, and hands out isolated contexts', async () => {
    const log = memoryLogger();
    const m = manager(log);
    await m.warm();
    const [a, b] = await Promise.all([m.newContext(VIEWPORT), m.newContext({ width: 640, height: 480 })]);
    expect(a.browser()).toBe(b.browser());
    await a.addCookies([{ name: 'k', value: 'v', url: 'https://example.com' }]);
    expect(await b.cookies()).toEqual([]);
    expect((await b.newPage()).viewportSize()).toEqual({ width: 640, height: 480 });
    expect(log.text()).toBe('INFO warm chromium launched (headless=true)');
  });

  it('relaunches on the next use after Chromium went away', async () => {
    const m = manager();
    const first = (await m.newContext(VIEWPORT)).browser();
    await first?.close();
    const second = (await m.newContext(VIEWPORT)).browser();
    expect(second).not.toBe(first);
    expect(second?.isConnected()).toBe(true);
  });

  // close is final, so no Chromium outlives the app shutdown
  it('closes Chromium idempotently and never launches again', async () => {
    const log = memoryLogger();
    const m = manager(log);
    const browser = (await m.newContext(VIEWPORT)).browser();
    await m.close();
    await m.close();
    expect(browser?.isConnected()).toBe(false);
    await expect(m.newContext(VIEWPORT)).rejects.toThrow('browser manager is closed');
    await m.warm();
    expect(log.text()).toContain('WARNING browser warm-up failed: Error: browser manager is closed');
  });

  it('waits out a launch in flight when closing', async () => {
    const m = manager();
    const opening = m.newContext(VIEWPORT).then((context) => context.browser(), () => null);
    await m.close();
    expect((await opening)?.isConnected() ?? false).toBe(false);
  });
});

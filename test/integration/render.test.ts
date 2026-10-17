import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { OWNER, testApp } from '../helpers/app.ts';
import { until } from '../helpers/wait.ts';

// Real Chromium; skipped where `npx playwright install chromium` hasn't run.
const HAS_CHROMIUM = existsSync(chromium.executablePath());

type TestApp = ReturnType<typeof testApp>;
const running: TestApp[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((t) => t.app.stop()));
});

describe.skipIf(!HAS_CHROMIUM)('rendering, end to end', () => {
  it('warms Chromium at boot, renders HTML into data/renders and sends it as a photo', async () => {
    const t = testApp();
    running.push(t);
    await t.app.start();
    await until(() => t.log.text().includes('INFO warm chromium launched (headless=true)'), 15_000);
    t.telegram.message({ id: OWNER.id }, OWNER, '#fake tool render_html {"html": "<h1>Salom</h1>", "width": 300, "height": 200, "title": "Greeting"}');
    const rendered = await until(() => t.claudeLog().find((e) => e.kind === 'tool' && e.name === 'render_html'), 30_000);
    const path = /rendered to (\S+) \(/.exec(JSON.stringify(rendered))?.[1] ?? '';
    expect(path).toMatch(/^\d{8}T\d{6}-greeting-[0-9a-f]{6}\.png$/);
    expect(existsSync(join(t.config.rendersDir, path))).toBe(true);
    t.telegram.message({ id: OWNER.id }, OWNER, `#fake tool telegram_send_photo {"chat_id": ${OWNER.id}, "path": "${path}"}`);
    await t.telegram.waitFor('sendPhoto', (p) => p.chat_id === OWNER.id, 15_000);
  });

  it('closes Chromium at shutdown', async () => {
    const t = testApp();
    await t.app.start();
    await until(() => t.log.text().includes('warm chromium launched'), 15_000);
    await t.app.stop();
    expect(t.log.text().split('\n').at(-1)).toBe('INFO clean shutdown complete');
    expect(t.log.text()).not.toMatch(/close (hung|failed)/);
  });
});

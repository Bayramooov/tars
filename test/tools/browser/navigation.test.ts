import { describe, expect, it } from 'vitest';

import { backTool, navigateTool, reloadTool, resetTool } from '../../../src/tools/browser/navigation.ts';
import { FakePage, fakeSession } from '../../fakes/browser.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { memoryLogger } from '../../helpers/log.ts';

/** A public literal: passes the SSRF guard without DNS. */
const PUBLIC = 'http://8.8.8.8/';

describe('browser navigation tools', () => {
  it('match the golden tools/list entries', () => {
    const session = fakeSession();
    for (const tool of [navigateTool(session, memoryLogger()), backTool(session), reloadTool(session), resetTool(session)]) expectGoldenTool(tool);
  });

  it('browser_navigate loads the URL at DOMContentLoaded and reports the final URL and status', async () => {
    const page = new FakePage();
    const log = memoryLogger();
    const result = await navigateTool(fakeSession(page), log).run({ url: PUBLIC });
    expect(page.calls).toEqual([['goto', PUBLIC, { waitUntil: 'domcontentloaded', timeout: 30_000 }]]);
    expect(result).toEqual({ content: `loaded ${PUBLIC} (HTTP 200)`, data: { url: PUBLIC, status: 200 } });
    expect(log.text()).toBe(`INFO browser navigated to ${PUBLIC} (status 200)`);
  });

  it('reports status 0 when goto returns no response (same-document navigation)', async () => {
    const page = Object.assign(new FakePage(), { gotoStatus: null });
    const result = await navigateTool(fakeSession(page), memoryLogger()).run({ url: `${PUBLIC}#top` });
    expect(result.content).toBe(`loaded ${PUBLIC}#top (HTTP 0)`);
  });

  // a block is an exception, not an error result
  it('refuses an internal URL before any page is opened', async () => {
    const session = fakeSession();
    await expect(navigateTool(session, memoryLogger()).run({ url: 'http://127.0.0.1/admin' })).rejects.toThrow(
      new Error('blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'),
    );
    expect(session.page).toBeUndefined();
  });

  it('browser_back and browser_reload act on the open page and report its URL', async () => {
    const page = Object.assign(new FakePage(), { currentUrl: 'https://now/' });
    const session = fakeSession(page);
    expect(await backTool(session).run({})).toEqual({ content: 'went back to https://prev/', data: { url: 'https://prev/' } });
    expect(await reloadTool(session).run({})).toEqual({ content: 'reloaded https://prev/', data: { url: 'https://prev/' } });
    expect(page.calls).toEqual([['goBack'], ['reload']]);
  });

  it('browser_back and browser_reload ask for a navigate first', async () => {
    for (const tool of [backTool(fakeSession()), reloadTool(fakeSession())]) {
      await expect(tool.run({})).rejects.toThrow(new Error('no page open — call browser_navigate first'));
    }
  });

  it('browser_reset drops the session and says to navigate again', async () => {
    const session = fakeSession();
    expect(await resetTool(session).run({})).toEqual({ content: 'browser reset — navigate to start again' });
    expect(session.resets).toBe(1);
  });
});

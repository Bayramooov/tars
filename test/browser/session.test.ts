import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { BrowserManager } from '../../src/browser/manager.ts';
import { BrowserSession } from '../../src/browser/session.ts';
import { checkNavigable } from '../../src/browser/ssrf.ts';
import { memoryLogger } from '../helpers/log.ts';
import { until } from '../helpers/wait.ts';

// Real Chromium; skipped where `npx playwright install chromium` hasn't run.
const HAS_CHROMIUM = existsSync(chromium.executablePath());

/** A loopback server: `/redirect?to=<url>` redirects, `*.png` is an image, anything else a small page. Records every path. */
async function server(): Promise<{ origin: string; hits: string[]; close(): void }> {
  const hits: string[] = [];
  const http: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const to = new URL(req.url ?? '/', 'http://x').searchParams.get('to');
    if (to) res.writeHead(302, { location: to }).end();
    else if (req.url?.endsWith('.png')) res.writeHead(200, { 'content-type': 'image/png' }).end('png');
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<p>internal secret</p>');
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return { origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, hits, close: () => http.close() };
}

describe.skipIf(!HAS_CHROMIUM)('BrowserSession', () => {
  const manager = new BrowserManager({ headless: true, log: memoryLogger() });
  const sessions: BrowserSession[] = [];
  let internal: Awaited<ReturnType<typeof server>>;
  let allowed: Awaited<ReturnType<typeof server>>;

  /** A session whose guard treats the `allowed` server as public (a local proxy would look the same) and is real otherwise. */
  const session = (log = memoryLogger()) => {
    const created = new BrowserSession({ manager, log, guard: (url) => (url.startsWith(allowed.origin) ? Promise.resolve() : checkNavigable(url)) });
    sessions.push(created);
    return created;
  };

  beforeAll(async () => {
    [internal, allowed] = await Promise.all([server(), server()]);
  });
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    await manager.close();
    internal.close();
    allowed.close();
  });

  it('asks for a navigate before any page exists', () => {
    expect(() => session().requirePage()).toThrow(new Error('no page open — call browser_navigate first'));
  });

  it('opens one 1280x800 page lazily and keeps handing it out', async () => {
    const s = session();
    const page = await s.ensurePage();
    expect(await s.ensurePage()).toBe(page);
    expect(s.requirePage()).toBe(page);
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
  });

  it('follows a popup, and falls back to the newest open tab when it closes', async () => {
    const s = session();
    const first = await s.ensurePage();
    const [popup] = await Promise.all([first.context().waitForEvent('page'), first.evaluate("void window.open('about:blank')")]);
    expect(s.requirePage()).toBe(popup);
    await popup.close();
    expect(s.requirePage()).toBe(first);
  });

  // a reset drops cookies with the context; the warm browser stays up
  it('closes idempotently and starts the next navigate clean', async () => {
    const s = session();
    const page = await s.ensurePage();
    await page.context().addCookies([{ name: 'k', value: 'v', url: 'https://example.com' }]);
    await s.close();
    await s.close();
    expect(page.isClosed()).toBe(true);
    expect(() => s.requirePage()).toThrow('no page open — call browser_navigate first');
    const fresh = await s.ensurePage();
    expect(await fresh.context().cookies()).toEqual([]);
    expect(fresh.context().browser()?.isConnected()).toBe(true);
  });

  // B-10: a context whose pages all closed used to leak when the next navigate opened another
  it('drops a context left without pages before opening a new one', async () => {
    const s = session();
    const page = await s.ensurePage();
    const closed = page.context().waitForEvent('close');
    await page.close();
    const next = await s.ensurePage();
    await closed;
    expect(next.context()).not.toBe(page.context());
  });

  // after a crash the next navigate gets a page on a relaunched browser
  it('recovers from Chromium going away', async () => {
    const s = session();
    await (await s.ensurePage()).context().browser()?.close();
    expect(() => s.requirePage()).toThrow('no page open — call browser_navigate first');
    expect((await s.ensurePage()).context().browser()?.isConnected()).toBe(true);
  });

  // a page that reaches an internal address (here a sub-resource) loses the session
  it('closes the session when a response comes from an internal address and reports it once', async () => {
    const log = memoryLogger();
    const s = session(log);
    const page = await s.ensurePage();
    await page.setContent(`<img src="${internal.origin}/pixel.png">`);
    await until(() => page.isClosed(), 10_000);
    expect(() => s.requirePage()).toThrow(new Error('blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'));
    expect(() => s.requirePage()).toThrow('no page open — call browser_navigate first');
    expect(log.text()).toBe('WARNING browser session closed: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1');
  });

  // Playwright can't stop a redirect hop, but the page never survives it
  it('fails a navigation that redirects to an internal address with the guard’s error', async () => {
    const s = session();
    const page = await s.ensurePage();
    const target = `${internal.origin}/latest/meta-data/`;
    await expect(s.load(page.goto(`${allowed.origin}/redirect?to=${encodeURIComponent(target)}`))).rejects.toThrow(
      new Error('blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'),
    );
    expect(page.isClosed()).toBe(true);
    expect(() => s.requirePage()).toThrow('no page open — call browser_navigate first');
  });

  // pages served from a public address (here: allowed by the guard) load as before
  it('lets ordinary navigation through', async () => {
    const s = session();
    const page = await s.ensurePage();
    const response = await s.load(page.goto(`${allowed.origin}/redirect?to=${encodeURIComponent(`${allowed.origin}/page`)}`, { waitUntil: 'domcontentloaded' }));
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`${allowed.origin}/page`);
    expect(await s.requirePage().innerText('body')).toBe('internal secret');
  });
});

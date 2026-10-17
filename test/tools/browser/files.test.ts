import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

import { BrowserManager } from '../../../src/browser/manager.ts';
import { BrowserSession } from '../../../src/browser/session.ts';
import type { Tool } from '../../../src/mcp/tool.ts';
import { RenderStore } from '../../../src/stores/renders.ts';
import { downloadTool, screenshotTool } from '../../../src/tools/browser/files.ts';
import { FakeApiResponse, FakePage, fakeSession } from '../../fakes/browser.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { memoryLogger } from '../../helpers/log.ts';
import { tempDir } from '../../helpers/tmp.ts';

const call = (tool: Tool, raw: object) => tool.run(tool.args.parse(raw));
const PUBLIC = 'http://8.8.8.8/';
const NAME = /^\d{8}T\d{6}-browser-[0-9a-f]{6}\.png$/;

/** The tools over a fake page; `null`: nothing navigated yet. */
function setup(page: FakePage | null = new FakePage()) {
  const store = new RenderStore(join(tempDir(), 'renders'));
  const log = memoryLogger();
  const session = fakeSession(page ?? undefined);
  return { page: page ?? new FakePage(), store, log, screenshot: screenshotTool(session, store, log), download: downloadTool(session, store, log) };
}

const saved = (store: RenderStore, data: unknown) => readFileSync(join(store.root, (data as { path: string }).path));

describe('browser_screenshot', () => {
  it('matches the golden tools/list entries', () => {
    const { screenshot, download } = setup();
    expectGoldenTool(screenshot);
    expectGoldenTool(download);
  });

  it('saves the full page under data/renders and returns the path, not an image', async () => {
    const { page, store, log, screenshot } = setup();
    const result = await call(screenshot, {});
    const path = (result.data as { path: string }).path;
    expect(path).toMatch(NAME);
    expect(result).toEqual({ content: `screenshot saved to ${path} (9 bytes). Pass this path to telegram_send_photo to deliver it.`, data: { path, size_bytes: 9 } });
    expect(saved(store, result.data).toString('latin1')).toBe('\x89PNG-page');
    expect(page.calls).toEqual([['screenshot', { fullPage: true }]]);
    expect(log.text()).toBe(`INFO browser screenshot → ${path} (9 bytes)`);
  });

  it('captures the viewport only, or one element with a selector', async () => {
    const { page, store, screenshot } = setup();
    await call(screenshot, { full_page: false });
    const element = await call(screenshot, { selector: 'img.first', full_page: false });
    expect(saved(store, element.data).toString('latin1')).toBe('\x89PNG-element');
    expect(page.calls).toEqual([['screenshot', { fullPage: false }], ['locator.screenshot', 'img.first']]);
  });

  it('asks for a navigate first', async () => {
    await expect(call(setup(null).screenshot, {})).rejects.toThrow('no page open — call browser_navigate first');
  });
});

describe('browser_download', () => {
  it('fetches through the page’s request context and saves the bytes under the title’s slug', async () => {
    const { page, store, log, download } = setup();
    const url = `${PUBLIC}images/${'a'.repeat(80)}.png`;
    const result = await call(download, { url, title: 'Cat Photo' });
    const path = (result.data as { path: string }).path;
    expect(path).toMatch(/^\d{8}T\d{6}-cat-photo-[0-9a-f]{6}\.png$/);
    expect(result).toEqual({ content: `downloaded to ${path} (8 bytes). Pass this path to telegram_send_photo to deliver it.`, data: { path, size_bytes: 8 } });
    expect(saved(store, result.data).toString()).toBe('IMGBYTES');
    expect(page.calls).toEqual([['request.get', url, { maxRedirects: 0 }]]);
    expect(log.text()).toBe(`INFO browser downloaded ${url.slice(0, 60)} → ${path} (8 bytes)`);
  });

  it('fails on a non-2xx response', async () => {
    const { page, download } = setup();
    page.fetched.set(PUBLIC, new FakeApiResponse(404));
    await expect(call(download, { url: PUBLIC })).rejects.toThrow(new Error('download failed: HTTP 404'));
  });

  it('refuses an internal URL before fetching it', async () => {
    const { page, download } = setup();
    await expect(call(download, { url: 'http://169.254.169.254/meta' })).rejects.toThrow('blocked: 169.254.169.254 resolves to non-public address 169.254.169.254');
    expect(page.calls).toEqual([]);
  });

  // redirects are followed hop by hop, each through the SSRF guard
  it('follows redirects itself, resolving relative locations and releasing each response', async () => {
    const { page, store, download } = setup();
    const hop = new FakeApiResponse(302, Buffer.from(''), { location: '/b.png' });
    const last = new FakeApiResponse(200, Buffer.from('FINAL'));
    page.fetched.set(`${PUBLIC}a.png`, hop);
    page.fetched.set(`${PUBLIC}b.png`, last);
    const result = await call(download, { url: `${PUBLIC}a.png` });
    expect(saved(store, result.data).toString()).toBe('FINAL');
    expect(page.calls.map((c) => c[1])).toEqual([`${PUBLIC}a.png`, `${PUBLIC}b.png`]);
    expect([hop.disposed, last.disposed]).toEqual([true, true]);
  });

  // a public URL redirecting to an internal one used to be fetched
  it('refuses a redirect to an internal address', async () => {
    const { page, download } = setup();
    page.fetched.set(PUBLIC, new FakeApiResponse(301, Buffer.from(''), { location: 'http://169.254.169.254/latest/meta-data/' }));
    await expect(call(download, { url: PUBLIC })).rejects.toThrow(
      new Error('blocked: 169.254.169.254 resolves to non-public address 169.254.169.254'),
    );
    expect(page.calls).toHaveLength(1);
  });

  it('treats a redirect without a location as the final (failed) response, and stops after 20 redirects', async () => {
    const { page, download } = setup();
    page.fetched.set(PUBLIC, new FakeApiResponse(302));
    await expect(call(download, { url: PUBLIC })).rejects.toThrow('download failed: HTTP 302');
    page.fetched.set(PUBLIC, new FakeApiResponse(307, Buffer.from(''), { location: PUBLIC }));
    await expect(call(download, { url: PUBLIC })).rejects.toThrow('Max redirect count exceeded');
    expect(page.calls).toHaveLength(1 + 21);
  });

  it('decodes a data: URI locally, but still needs an open page', async () => {
    const { page, store, download } = setup();
    const result = await call(download, { url: 'data:text/plain;base64,SGk=' });
    expect(saved(store, result.data).toString()).toBe('Hi');
    expect(page.calls).toEqual([]);
    await expect(call(setup(null).download, { url: 'data:,x' })).rejects.toThrow('no page open — call browser_navigate first');
  });

  // C2: titles are limited to 80 characters, counted as code points
  it('limits the title to 80 characters', () => {
    const { download } = setup();
    expect(download.args.safeParse({ url: 'x', title: '🙂'.repeat(80) }).success).toBe(true);
    expect(download.args.safeParse({ url: 'x', title: 'a'.repeat(81) }).success).toBe(false);
  });
});

describe.skipIf(!existsSync(chromium.executablePath()))('browser file tools in Chromium', () => {
  const manager = new BrowserManager({ headless: true, log: memoryLogger() });
  const session = new BrowserSession({ manager, log: memoryLogger() });
  afterAll(async () => {
    await session.close();
    await manager.close();
  });

  // against the real Playwright API
  it('screenshot the page or one element, and save a data: URI, as PNG files', async () => {
    const store = new RenderStore(join(tempDir(), 'renders'));
    const page = await session.ensurePage();
    await page.setContent('<div id="box" style="width:120px;height:80px;background:red"></div><div style="height:2000px"></div>');
    const size = (data: unknown) => {
      const png = saved(store, data);
      return [png.subarray(0, 4).toString('latin1'), png.readUInt32BE(16), png.readUInt32BE(20)];
    };
    const screenshot = screenshotTool(session, store, memoryLogger());
    expect(size((await call(screenshot, {})).data)).toEqual(['\x89PNG', 1280, 2096]);
    expect(size((await call(screenshot, { full_page: false })).data)).toEqual(['\x89PNG', 1280, 800]);
    expect(size((await call(screenshot, { selector: '#box' })).data)).toEqual(['\x89PNG', 120, 80]);
    const download = downloadTool(session, store, memoryLogger());
    expect(saved(store, (await call(download, { url: 'data:text/plain,hi%21' })).data).toString()).toBe('hi!');
    await expect(call(download, { url: 'http://127.0.0.1:9/x.png' })).rejects.toThrow('blocked: 127.0.0.1 resolves to non-public address 127.0.0.1');
  });
});

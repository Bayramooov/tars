import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type BrowserContext, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BrowserManager } from '../../src/browser/manager.ts';
import { type RenderRequest, renderPng } from '../../src/browser/render.ts';
import { memoryLogger } from '../helpers/log.ts';
import { until } from '../helpers/wait.ts';

// Real Chromium; skipped where `npx playwright install chromium` hasn't run.
const HAS_CHROMIUM = existsSync(chromium.executablePath());
const REQ: RenderRequest = { html: '<p>x</p>', width: 800, height: 600, waitUntil: 'domcontentloaded' };
const WALL_CLOCK = 'render exceeded its 30 s budget';

describe('renderPng wall clock', () => {
  afterEach(() => vi.useRealTimers());

  // a launch that hangs is abandoned, and a context arriving late is closed unused
  it('gives up on a hung launch after 30 s', async () => {
    vi.useFakeTimers();
    const late = { close: vi.fn(() => Promise.resolve()) };
    const manager = { newContext: () => new Promise<BrowserContext>((resolve) => setTimeout(() => resolve(late as unknown as BrowserContext), 40_000)) };
    const rendering = expect(renderPng(manager, REQ, memoryLogger())).rejects.toThrow(new Error(WALL_CLOCK));
    await vi.advanceTimersByTimeAsync(30_000);
    await rendering;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(late.close).toHaveBeenCalledOnce();
  });

  // a page that never finishes is cut off by closing its context before the error surfaces
  it('closes a context still drawing before reporting the timeout', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const context = {
      route: () => Promise.resolve(),
      routeWebSocket: () => Promise.resolve(),
      newPage: () => new Promise(() => {}),
      close: () => {
        events.push('closed');
        return Promise.resolve();
      },
    };
    const rendering = renderPng({ newContext: () => Promise.resolve(context as unknown as BrowserContext) }, REQ, memoryLogger()).catch((err: Error) => {
      events.push(err.message);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rendering;
    expect(events).toEqual(['closed', WALL_CLOCK]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.skipIf(!HAS_CHROMIUM)('renderPng in Chromium', () => {
  const manager = new BrowserManager({ headless: true, log: memoryLogger() });
  const hits: string[] = [];
  let origin = '';
  const http = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/png' }).end('png');
  });
  http.on('upgrade', (req: { url?: string }, socket: { destroy(): void }) => {
    hits.push(`upgrade ${req.url}`);
    socket.destroy();
  });

  beforeAll(async () => {
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterEach(() => void hits.splice(0));
  afterAll(async () => {
    await manager.close();
    http.close();
  });

  // viewport width, whole page height
  it('draws the full page as a PNG', async () => {
    const png = await renderPng(manager, { ...REQ, html: '<div style="height:1500px">tall</div>' }, memoryLogger());
    expect(png.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([800, 1516]);
  });

  // nothing leaves the page, popups and WebSockets included
  it('blocks every request the page makes', async () => {
    const ws = origin.replace('http', 'ws');
    const html = `<link rel="stylesheet" href="${origin}/a.css"><img src="${origin}/b.png"><iframe src="${origin}/c"></iframe>
      <script>fetch('${origin}/d').catch(() => {}); window.open('${origin}/e'); new WebSocket('${ws}/f');</script>`;
    // With the host allowed the same page does reach out (WebSockets stay closed either way)...
    await renderPng(manager, { ...REQ, html, allowedHosts: ['127.0.0.1'], waitUntil: 'networkidle' }, memoryLogger());
    await until(() => hits.includes('/e'));
    expect(hits).toEqual(expect.arrayContaining(['/a.css', '/b.png', '/c', '/d', '/e']));
    expect(hits.filter((hit) => hit.startsWith('upgrade'))).toEqual([]);
    hits.splice(0);
    // ...and by default nothing gets out.
    await renderPng(manager, { ...REQ, html }, memoryLogger());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hits).toEqual([]);
  });

  // allowed by exact host name, whatever the scheme, port or path
  it('lets through only the allowed hosts', async () => {
    const html = `<img src="${origin}/ok.png"><img src="${origin.replace('127.0.0.1', 'localhost')}/no.png">`;
    await renderPng(manager, { ...REQ, html, allowedHosts: ['127.0.0.1'], waitUntil: 'networkidle' }, memoryLogger());
    expect(hits).toEqual(['/ok.png']);
  });
});

import type { BrowserContext } from 'playwright';

import type { Logger } from '../log/logger.ts';
import { safeClose } from './close.ts';
import type { BrowserManager } from './manager.ts';

export interface RenderRequest {
  html: string;
  width: number;
  height: number;
  /** Hosts the page may load from (render_latex's CDN); without them every request is aborted. */
  allowedHosts?: readonly string[];
  waitUntil: 'domcontentloaded' | 'networkidle';
}

/** The whole render, a browser launch included. */
const WALL_CLOCK_MS = 30_000;

/**
 * Render `html` to a full-page PNG in a fresh context that is closed
 * afterwards. Network policy is context-wide, so popups and WebSockets the
 * page opens are covered too. The wall clock closes a context still drawing,
 * so no late screenshot outlives the error.
 */
export async function renderPng(manager: Pick<BrowserManager, 'newContext'>, req: RenderRequest, log: Logger): Promise<Buffer> {
  let context: BrowserContext | undefined;
  const opening = manager.newContext({ width: req.width, height: req.height }).then((opened) => (context = opened));
  try {
    return await withinWallClock(opening.then((opened) => draw(opened, req)));
  } finally {
    if (context) await safeClose(context, 'render context', log);
    else void opening.then((late) => safeClose(late, 'render context', log), () => undefined); // opened after the deadline
  }
}

async function draw(context: BrowserContext, req: RenderRequest): Promise<Buffer> {
  await context.route('**/*', (route) => (allowed(route.request().url(), req.allowedHosts) ? route.continue() : route.abort()));
  await context.routeWebSocket(/./, (ws) => ws.close());
  const page = await context.newPage();
  await page.setContent(req.html, { waitUntil: req.waitUntil, timeout: 15_000 });
  return page.screenshot({ fullPage: true });
}

/** `data:`/`about:`/`blob:` never touch the network; anything else needs an allowed host (any scheme, port or path). */
function allowed(url: string, hosts: readonly string[] | undefined): boolean {
  if (!hosts) return false;
  if (/^(data|about|blob):/i.test(url)) return true;
  return hosts.includes(URL.parse(url)?.hostname ?? '');
}

async function withinWallClock<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('render exceeded its 30 s budget')), WALL_CLOCK_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

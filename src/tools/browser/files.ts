import { z } from 'zod';

import type { BrowserSession } from '../../browser/session.ts';
import { checkNavigable } from '../../browser/ssrf.ts';
import type { Logger } from '../../log/logger.ts';
import { defineTool, type Tool } from '../../mcp/tool.ts';
import type { RenderStore } from '../../stores/renders.ts';
import { cpSlice } from '../../text/clip.ts';
import { decodeDataUri } from './datauri.ts';

type Session = Pick<BrowserSession, 'requirePage'>;
type Store = Pick<RenderStore, 'save'>;
type Requests = ReturnType<Session['requirePage']>['request'];

/** The statuses Playwright follows as redirects. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function screenshotTool(session: Session, store: Store, log: Logger): Tool {
  return defineTool({
    name: 'browser_screenshot',
    description: 'Screenshot the current browser page to a PNG under data/renders/ and return its path (call browser_navigate first). Pass a CSS selector to capture just one element. Pass the returned path to telegram_send_photo to deliver it to a chat.',
    args: z.object({
      selector: z.string().nullable().default(null).describe('CSS selector to capture a single element; omit to capture the page.'),
      full_page: z.boolean().default(true).describe('Capture the whole scrollable page (ignored when selector is set).'),
    }),
    run: async ({ selector, full_page }) => {
      const page = session.requirePage();
      // A strict locator with Playwright's 30 s default: a missing element is an error here, not a miss.
      const png = selector === null ? await page.screenshot({ fullPage: full_page }) : await page.locator(selector).screenshot();
      const path = store.save('browser', png);
      log.info(`browser screenshot → ${path} (${png.length} bytes)`);
      // The path, not an image: the model needs it for telegram_send_photo.
      return { content: `screenshot saved to ${path} (${png.length} bytes). Pass this path to telegram_send_photo to deliver it.`, data: { path, size_bytes: png.length } };
    },
  });
}

export function downloadTool(session: Session, store: Store, log: Logger): Tool {
  return defineTool({
    name: 'browser_download',
    description: 'Download the original file at a URL (typically an image) through the browser session and save it under data/renders/, returning its path. Pass that path to telegram_send_photo to deliver it. Get the URL first with browser_get_attribute (e.g. an <img>\'s \'src\'). Accepts http(s) (private hosts blocked) and data: URIs.',
    args: z.object({
      url: z.string().min(1).describe('http(s) URL or data: URI of the file, e.g. an image\'s src.'),
      title: z.string().max(80).nullable().default(null).describe('Optional label baked into the saved filename.'),
    }),
    run: async ({ url, title }) => {
      const page = session.requirePage(); // required for data: URIs too
      const bytes = url.startsWith('data:') ? decodeDataUri(url) : await fetchBytes(page.request, url);
      const path = store.save(title, bytes);
      log.info(`browser downloaded ${cpSlice(url, 60).text} → ${path} (${bytes.length} bytes)`);
      return { content: `downloaded to ${path} (${bytes.length} bytes). Pass this path to telegram_send_photo to deliver it.`, data: { path, size_bytes: bytes.length } };
    },
  });
}

/**
 * GET `url` with the session's cookies. Redirects are followed here, up to
 * Playwright's 20, so that every hop passes the SSRF guard, not just the first.
 */
async function fetchBytes(request: Requests, url: string): Promise<Buffer> {
  let target = url;
  for (let hops = 0; ; hops++) {
    await checkNavigable(target);
    const response = await request.get(target, { maxRedirects: 0 });
    try {
      const location = REDIRECTS.has(response.status()) && response.headers().location;
      if (!location) {
        if (!response.ok()) throw new Error(`download failed: HTTP ${response.status()}`);
        return await response.body();
      }
      if (hops === 20) throw new Error('Max redirect count exceeded');
      target = new URL(location, target).href;
    } finally {
      await response.dispose(); // otherwise the body stays in memory until the session closes
    }
  }
}

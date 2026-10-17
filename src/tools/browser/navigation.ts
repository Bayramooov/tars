import { z } from 'zod';

import type { BrowserSession } from '../../browser/session.ts';
import { checkNavigable } from '../../browser/ssrf.ts';
import type { Logger } from '../../log/logger.ts';
import { defineTool, type Tool } from '../../mcp/tool.ts';

export function navigateTool(session: Pick<BrowserSession, 'ensurePage' | 'load'>, log: Logger): Tool {
  return defineTool({
    name: 'browser_navigate',
    description: 'Open a URL in a shared headless Chromium page and wait for the DOM to load. Start here, then use the other browser_* tools (get_text, click, fill, screenshot, wait_for) on the SAME page. Unlike render_html the browser has live network access, but private/internal hosts are blocked. ~30s load budget.',
    args: z.object({
      url: z.string().min(1).describe('Absolute http(s) URL to load. Internal/private hosts (localhost, 10.x, 192.168.x, link-local) and non-http schemes are refused.'),
    }),
    run: async ({ url }) => {
      await checkNavigable(url); // before any browser work: a blocked URL never launches Chromium
      const page = await session.ensurePage();
      const response = await session.load(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
      const status = response?.status() ?? 0; // no response: a same-document (hash) navigation
      log.info(`browser navigated to ${page.url()} (status ${status})`);
      return { content: `loaded ${page.url()} (HTTP ${status})`, data: { url: page.url(), status } };
    },
  });
}

export function backTool(session: Pick<BrowserSession, 'requirePage' | 'load'>): Tool {
  return defineTool({
    name: 'browser_back',
    description: 'Go back one entry in the browser history on the current page (call browser_navigate first). Returns the URL landed on.',
    args: z.object({}),
    run: async () => {
      const page = session.requirePage();
      await session.load(page.goBack());
      return { content: `went back to ${page.url()}`, data: { url: page.url() } };
    },
  });
}

export function reloadTool(session: Pick<BrowserSession, 'requirePage' | 'load'>): Tool {
  return defineTool({
    name: 'browser_reload',
    description: 'Reload the current browser page (call browser_navigate first). Use when content changed or didn\'t finish loading.',
    args: z.object({}),
    run: async () => {
      const page = session.requirePage();
      await session.load(page.reload());
      return { content: `reloaded ${page.url()}`, data: { url: page.url() } };
    },
  });
}

export function resetTool(session: Pick<BrowserSession, 'close'>): Tool {
  return defineTool({
    name: 'browser_reset',
    description: 'Close the current browser page and clear its cookies/state. The next browser_navigate opens a fresh isolated tab. Use to start clean between unrelated tasks or to recover a stuck page.',
    args: z.object({}),
    run: async () => {
      await session.close();
      return { content: 'browser reset — navigate to start again' };
    },
  });
}

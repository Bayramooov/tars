import { z } from 'zod';

import type { BrowserSession } from '../../browser/session.ts';
import { defineTool, type Tool, type ToolResult } from '../../mcp/tool.ts';
import { cpSlice } from '../../text/clip.ts';
import { miss, trySelector } from './selector.ts';

type Session = Pick<BrowserSession, 'requirePage'>;

/** How long a read waits for its element: short, so a wrong selector fails fast. */
const LOCATE = { timeout: 5000 };

export function getTextTool(session: Session): Tool {
  return defineTool({
    name: 'browser_get_text',
    description: 'Return the visible text of the current browser page (call browser_navigate first). Pass a CSS selector to scope to one element, else the whole body. Truncated to 10000 characters.',
    args: z.object({
      selector: z.string().min(1).default('body').describe('CSS selector to scope extraction; defaults to the whole page body.'),
    }),
    run: async ({ selector }) => {
      const hit = await trySelector(session.requirePage().innerText(selector, LOCATE));
      return hit ? capped(hit.value, 10_000) : miss('get_text', selector);
    },
  });
}

export function getHtmlTool(session: Session): Tool {
  return defineTool({
    name: 'browser_get_html',
    description: 'Return the HTML of the current page, or one element\'s inner HTML with a selector (call browser_navigate first). Use when structure/attributes matter; for plain reading prefer browser_get_text. Truncated to 20000 characters.',
    args: z.object({
      selector: z.string().nullable().default(null).describe('CSS selector for one element\'s inner HTML; omit for the full page.'),
    }),
    run: async ({ selector }) => {
      const page = session.requirePage();
      if (selector === null) return capped(await page.content(), 20_000);
      const hit = await trySelector(page.innerHTML(selector, LOCATE));
      return hit ? capped(hit.value, 20_000) : miss('get_html', selector);
    },
  });
}

export function getAttributeTool(session: Session): Tool {
  return defineTool({
    name: 'browser_get_attribute',
    description: 'Read one HTML attribute of an element on the current page (call browser_navigate first), e.g. an image\'s \'src\' or a link\'s \'href\'. Returns the value, or notes the attribute is absent.',
    args: z.object({
      selector: z.string().min(1).describe('CSS selector of the element to read.'),
      name: z.string().min(1).describe('Attribute name to read, e.g. \'href\', \'src\', \'value\'.'),
    }),
    run: async ({ selector, name }) => {
      const hit = await trySelector(session.requirePage().getAttribute(selector, name, LOCATE));
      if (!hit) return miss('get_attribute', selector);
      if (hit.value === null) return { content: `${JSON.stringify(selector)} has no attribute ${JSON.stringify(name)}`, data: { value: null } };
      return { content: hit.value, data: { value: hit.value } };
    },
  });
}

export function listTool(session: Session): Tool {
  return defineTool({
    name: 'browser_list',
    description: 'List the elements matching a selector on the current page (call browser_navigate first) with their text and href/src — handy for choosing which link/image to act on. Reports up to 50.',
    args: z.object({
      selector: z.string().min(1).describe('CSS selector matching the elements to list, e.g. \'a\', \'img\', \'.result\'.'),
    }),
    run: async ({ selector }) => {
      const { count, items } = await session.requirePage().locator(selector).evaluateAll(describeElements);
      const lines = items.map(([text, href, src]) => {
        const link = href || src;
        return `- ${cpSlice(text.trim().replaceAll('\n', ' '), 120).text}${link ? `  [${link}]` : ''}`;
      });
      const more = count > 50 ? `\n…(+${count - 50} more)` : '';
      return { content: `${lines.length ? lines.join('\n') : '(no matches)'}${more}`, data: { count } };
    },
  });
}

export function waitForTool(session: Session): Tool {
  return defineTool({
    name: 'browser_wait_for',
    description: 'Wait for an element to appear on the current browser page (call browser_navigate first). Use after a click that loads content asynchronously, before reading or acting on it.',
    args: z.object({
      selector: z.string().min(1).describe('CSS selector to wait for until it appears in the DOM.'),
      timeout_ms: z.int().min(1).max(30_000).default(10_000).describe('How long to wait in milliseconds (default 10000, max 30000).'),
    }),
    run: async ({ selector, timeout_ms }) => {
      // Playwright waits for the element to be visible, not merely attached.
      const hit = await trySelector(session.requirePage().waitForSelector(selector, { timeout: timeout_ms }));
      return hit ? { content: `element ${JSON.stringify(selector)} is present` } : miss('wait_for', selector);
    },
  });
}

/** The first `limit` characters (code points), flagged when cut; `chars` counts the whole text. */
function capped(text: string, limit: number): ToolResult {
  const { text: body, cut } = cpSlice(text, limit);
  return { content: cut ? `${body}\n\n[truncated at ${limit} chars]` : body, data: { chars: Array.from(text).length } };
}

interface Described {
  innerText?: string;
  getAttribute(name: string): string | null;
}

/** Runs in the page: the match count, and text, href and src of the first 50 matches in one round trip. */
function describeElements(elements: Described[]): { count: number; items: [string, string | null, string | null][] } {
  return {
    count: elements.length,
    items: elements.slice(0, 50).map((el) => {
      // Like Playwright's innerText(): SVG and other non-HTML elements have no text to give.
      if (typeof el.innerText !== 'string') throw new Error('Node is not an HTMLElement');
      return [el.innerText, el.getAttribute('href'), el.getAttribute('src')];
    }),
  };
}

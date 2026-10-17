import { z } from 'zod';

import type { BrowserSession } from '../../browser/session.ts';
import { defineTool, type Tool } from '../../mcp/tool.ts';
import { miss, trySelector } from './selector.ts';

type Session = Pick<BrowserSession, 'requirePage'>;

/** How long an action waits for its element to exist and become actionable. */
const ACTION = { timeout: 10_000 };

export function clickTool(session: Session): Tool {
  return defineTool({
    name: 'browser_click',
    description: 'Click an element on the current browser page (call browser_navigate first). Waits up to ~10s for the element to be actionable.',
    args: z.object({
      selector: z.string().min(1).describe('CSS selector of the element to click.'),
    }),
    run: async ({ selector }) => {
      const hit = await trySelector(session.requirePage().click(selector, ACTION));
      return hit ? { content: `clicked ${JSON.stringify(selector)}` } : miss('click', selector);
    },
  });
}

export function fillTool(session: Session): Tool {
  return defineTool({
    name: 'browser_fill',
    description: 'Type a value into an input/textarea on the current browser page (call browser_navigate first). Replaces existing content. Pair with browser_click to submit.',
    args: z.object({
      selector: z.string().min(1).describe('CSS selector of the input or textarea to fill.'),
      value: z.string().describe('Text to type into the field (replaces any existing value).'),
    }),
    run: async ({ selector, value }) => {
      const hit = await trySelector(session.requirePage().fill(selector, value, ACTION));
      return hit ? { content: `filled ${JSON.stringify(selector)}` } : miss('fill', selector);
    },
  });
}

export function pressKeyTool(session: Session): Tool {
  return defineTool({
    name: 'browser_press_key',
    description: 'Press a keyboard key on the current page (call browser_navigate first). Use \'Enter\' to submit a search/form, \'Tab\' to move focus. Pass a selector to target a field, else the key goes to the focused element.',
    args: z.object({
      key: z.string().min(1).describe('Key to press, e.g. \'Enter\', \'Tab\', \'Escape\', \'ArrowDown\'.'),
      selector: z.string().nullable().default(null).describe('CSS selector to focus first; omit to send to the focused element.'),
    }),
    run: async ({ key, selector }) => {
      const page = session.requirePage();
      if (selector === null) {
        await page.keyboard.press(key); // to the focused element; an unknown key is a real error
      } else {
        const hit = await trySelector(page.press(selector, key, ACTION));
        if (!hit) return miss('press_key', selector);
      }
      return { content: `pressed ${JSON.stringify(key)}` };
    },
  });
}

export function selectOptionTool(session: Session): Tool {
  return defineTool({
    name: 'browser_select_option',
    description: 'Choose an option in a <select> dropdown on the current page (call browser_navigate first). Use this instead of browser_fill for native dropdowns.',
    args: z.object({
      selector: z.string().min(1).describe('CSS selector of the <select> element.'),
      value: z.string().min(1).describe('Option to choose — matched against its value, then its label.'),
    }),
    run: async ({ selector, value }) => {
      const hit = await trySelector(session.requirePage().selectOption(selector, value, ACTION));
      if (!hit) return miss('select_option', selector);
      return { content: `selected ${JSON.stringify(value)} in ${JSON.stringify(selector)}`, data: { selected: hit.value } };
    },
  });
}

export function scrollTool(session: Session): Tool {
  return defineTool({
    name: 'browser_scroll',
    description: 'Scroll the current page (call browser_navigate first) to reveal lazy-loaded content. Pass a selector to scroll that element into view, or omit it to scroll the window by `pixels`.',
    args: z.object({
      selector: z.string().nullable().default(null).describe('CSS selector to scroll into view; omit to scroll the window.'),
      pixels: z.int().default(1000).describe('Vertical pixels to scroll when no selector is given (negative = up).'),
    }),
    run: async ({ selector, pixels }) => {
      const page = session.requirePage();
      if (selector === null) {
        await page.mouse.wheel(0, pixels);
        return { content: `scrolled ${pixels}px` };
      }
      // A strict locator: more than one match is an error, not a miss.
      const hit = await trySelector(page.locator(selector).scrollIntoViewIfNeeded(ACTION));
      return hit ? { content: `scrolled ${JSON.stringify(selector)} into view` } : miss('scroll', selector);
    },
  });
}

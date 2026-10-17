import { errors, type Page } from 'playwright';

import type { BrowserSession } from '../../src/browser/session.ts';

/** A `page.request.get()` response. */
export class FakeApiResponse {
  disposed = false;
  readonly code: number;
  readonly bytes: Buffer;
  readonly head: Record<string, string>;

  constructor(code = 200, bytes: Buffer = Buffer.from('IMGBYTES'), head: Record<string, string> = {}) {
    this.code = code;
    this.bytes = bytes;
    this.head = head;
  }

  status = () => this.code;
  ok = () => this.code >= 200 && this.code <= 299;
  headers = () => this.head;
  body = () => Promise.resolve(this.bytes);
  dispose = () => {
    this.disposed = true;
    return Promise.resolve();
  };
}

interface FakeElement {
  innerText?: string;
  getAttribute(name: string): string | null;
}

export const element = (innerText: string | undefined, attrs: Record<string, string> = {}): FakeElement => ({ innerText, getAttribute: (name) => attrs[name] ?? null });

/**
 * Stands in for a Playwright page with Node API shapes (`url()`, `status()`
 * are methods). Every call is recorded; a selector in `missing` times out
 * like Playwright does when the element never shows up.
 */
export class FakePage {
  calls: unknown[][] = [];
  currentUrl = 'about:blank';
  text = 'hello world';
  html = '<html><body>hi</body></html>';
  attrs: Record<string, string | null> = { href: 'https://x/y', src: 'https://i/p' };
  elements: FakeElement[] = [];
  missing = new Set<string>();
  gotoStatus: number | null = 200;
  /** `page.request.get` answers by URL; anything else gets a 200 with `IMGBYTES`. */
  fetched = new Map<string, FakeApiResponse>();

  readonly keyboard = { press: (key: string) => this.record('keyboard.press', key) };
  readonly mouse = { wheel: (dx: number, dy: number) => this.record('mouse.wheel', dx, dy) };
  readonly request = {
    get: (url: string, options: unknown) => {
      this.calls.push(['request.get', url, options]);
      return Promise.resolve(this.fetched.get(url) ?? new FakeApiResponse());
    },
  };

  url = () => this.currentUrl;
  goto = (url: string, options: unknown) => {
    this.calls.push(['goto', url, options]);
    this.currentUrl = url;
    return Promise.resolve(this.gotoStatus === null ? null : { status: () => this.gotoStatus });
  };
  goBack = () => {
    this.currentUrl = 'https://prev/';
    return this.record('goBack');
  };
  reload = () => this.record('reload');
  click = (selector: string, options: unknown) => this.located(selector, undefined, 'click', selector, options);
  fill = (selector: string, value: string, options: unknown) => this.located(selector, undefined, 'fill', selector, value, options);
  press = (selector: string, key: string, options: unknown) => this.located(selector, undefined, 'press', selector, key, options);
  selectOption = (selector: string, value: string, options: unknown) => this.located(selector, [value], 'selectOption', selector, value, options);
  innerText = (selector: string, options: unknown) => this.located(selector, this.text, 'innerText', selector, options);
  innerHTML = (selector: string, options: unknown) => this.located(selector, this.html, 'innerHTML', selector, options);
  getAttribute = (selector: string, name: string, options: unknown) => this.located(selector, this.attrs[name] ?? null, 'getAttribute', selector, name, options);
  waitForSelector = (selector: string, options: unknown) => this.located(selector, null, 'waitForSelector', selector, options);
  content = () => Promise.resolve(this.html);
  screenshot = (options: unknown) => this.located('', Buffer.from('\x89PNG-page', 'latin1'), 'screenshot', options);
  locator = (selector: string) => ({
    scrollIntoViewIfNeeded: (options: unknown) => this.located(selector, undefined, 'locator.scrollIntoViewIfNeeded', selector, options),
    screenshot: () => this.located(selector, Buffer.from('\x89PNG-element', 'latin1'), 'locator.screenshot', selector),
    evaluateAll: <R>(fn: (elements: FakeElement[]) => R) => this.located(selector, fn(this.elements), 'locator.evaluateAll', selector),
  });

  /** This fake as the Playwright type the tools expect. */
  get asPage(): Page {
    return this as unknown as Page;
  }

  private record(...call: unknown[]): Promise<undefined> {
    this.calls.push(call);
    return Promise.resolve(undefined);
  }

  private located<T>(selector: string, value: T, ...call: unknown[]): Promise<T> {
    this.calls.push(call);
    if (this.missing.has(selector)) return Promise.reject(new errors.TimeoutError(`Timeout exceeded waiting for ${selector}`));
    return Promise.resolve(value);
  }
}

/** Stands in for `BrowserSession`: hands out `page` (none: navigate first), counts resets. */
class FakeSession implements Pick<BrowserSession, 'ensurePage' | 'requirePage' | 'load' | 'close'> {
  page: FakePage | undefined;
  resets = 0;

  constructor(page?: FakePage) {
    this.page = page;
  }

  ensurePage = () => Promise.resolve((this.page ??= new FakePage()).asPage);
  requirePage = () => {
    if (!this.page) throw new Error('no page open — call browser_navigate first');
    return this.page.asPage;
  };
  load = <T>(navigation: Promise<T>) => navigation;
  close = () => {
    this.resets++;
    return Promise.resolve();
  };
}

export const fakeSession = (page?: FakePage) => new FakeSession(page);

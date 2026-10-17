import type { BrowserContext, Page, Response } from 'playwright';

import type { Logger } from '../log/logger.ts';
import { safeClose } from './close.ts';
import type { BrowserManager } from './manager.ts';
import { checkNavigable, isGlobal } from './ssrf.ts';

export interface SessionOptions {
  manager: Pick<BrowserManager, 'newContext'>;
  log: Logger;
  /** Throws for a URL Chromium may not reach; tests swap in their own. */
  guard?: (url: string) => Promise<void>;
}

/**
 * The one page (and its context: cookies, storage, logins) that the
 * browser_* tools share across calls, turns and chats until `close()`
 * (browser_reset, shutdown) or a crash. browser_navigate opens it lazily; a
 * popup or new tab becomes the active page.
 *
 * Playwright can't intercept redirect hops, so a public page can still lead
 * Chromium to an internal address. Each response is therefore checked by the
 * address Chromium actually connected to: one from a non-public address
 * closes the whole session (cache included) before the model can read or
 * screenshot it, and the next tool call reports the block.
 */
export class BrowserSession {
  private readonly manager: Pick<BrowserManager, 'newContext'>;
  private readonly log: Logger;
  private readonly guard: (url: string) => Promise<void>;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private opening: Promise<Page> | undefined;
  private blocked: Error | undefined;
  private readonly checks = new Set<Promise<void>>();

  constructor(options: SessionOptions) {
    this.manager = options.manager;
    this.log = options.log;
    this.guard = options.guard ?? ((url) => checkNavigable(url));
  }

  /** The live page, opening the shared context on first use (browser_navigate). */
  async ensurePage(): Promise<Page> {
    this.blocked = undefined; // a new navigation supersedes a block nobody asked about
    const live = this.livePage();
    if (live) return live;
    this.opening ??= this.open().finally(() => (this.opening = undefined));
    return this.opening;
  }

  /** The active page for every other tool: a pending block is reported first. */
  requirePage(): Page {
    this.reportBlock();
    const page = this.livePage();
    if (!page) throw new Error('no page open — call browser_navigate first');
    return page;
  }

  /** Await a navigation; a block found while it loaded wins over its own error (closing the session caused that). */
  async load<T>(navigation: Promise<T>): Promise<T> {
    try {
      return await navigation;
    } finally {
      await Promise.all(this.checks);
      this.reportBlock();
    }
  }

  /** Drop the context and its pages (the warm browser stays up); the next navigate starts clean. Idempotent. */
  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await safeClose(context, 'browser session context', this.log);
  }

  private reportBlock(): void {
    const blocked = this.blocked;
    this.blocked = undefined;
    if (blocked) throw blocked;
  }

  private async open(): Promise<Page> {
    await this.close(); // a context whose pages all closed is dropped, not leaked
    const context = await this.manager.newContext({ width: 1280, height: 800 });
    context.on('page', (page) => this.watch(page)); // fires before newPage() resolves, popups included
    this.context = context;
    return context.newPage();
  }

  private watch(page: Page): void {
    this.page = page;
    page.on('response', (response) => {
      const check = this.check(page, response);
      this.checks.add(check);
      void check.finally(() => this.checks.delete(check));
    });
  }

  /** Never rejects: a blocked response closes the session and leaves the error for the next tool call. */
  private async check(page: Page, response: Response): Promise<void> {
    const ip = (await response.serverAddr().catch(() => null))?.ipAddress;
    if (!ip || isGlobal(ip)) return;
    // A non-public peer can still be a legitimate local proxy: judge by the URL's own host.
    const error = await this.guard(response.url()).then(() => undefined, (err: Error) => err);
    if (!error || page.context() !== this.context) return;
    this.log.warn(`browser session closed: ${error.message}`);
    this.blocked = error;
    await this.close();
  }

  private livePage(): Page | undefined {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = this.context?.pages().at(-1); // the newest tab still open
    return this.page;
  }
}

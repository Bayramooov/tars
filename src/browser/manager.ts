import { type Browser, type BrowserContext, chromium } from 'playwright';

import type { Logger } from '../log/logger.ts';
import { safeClose } from './close.ts';

export interface Viewport {
  width: number;
  height: number;
}

/**
 * One warm Chromium shared by the renders and the browser session. It
 * launches on `warm()` or first use, relaunches on the next use after a
 * crash, and hands out isolated contexts (no shared cookies, cache or
 * storage). `close()` is final: nothing launches after it.
 */
export class BrowserManager {
  private readonly headless: boolean;
  private readonly log: Logger;
  private launching: Promise<Browser> | undefined;
  private closed = false;

  constructor(options: { headless: boolean; log: Logger }) {
    this.headless = options.headless;
    this.log = options.log;
  }

  /** Launch ahead of the first render; a failure is only logged (the next use retries and reports it). */
  async warm(): Promise<void> {
    await this.browser().catch((err: Error) => this.log.warn(`browser warm-up failed: ${err.name}: ${err.message}`));
  }

  /** A fresh context on the warm browser; the caller closes it. */
  async newContext(viewport: Viewport): Promise<BrowserContext> {
    return (await this.browser()).newContext({ viewport });
  }

  /** Close Chromium, waiting out a launch in flight. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    const launching = this.launching;
    this.launching = undefined;
    await safeClose(await launching?.catch(() => undefined), 'browser', this.log);
  }

  /** The connected browser; concurrent first callers share one launch. */
  private browser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new Error('browser manager is closed'));
    if (!this.launching) {
      const launching = this.launch();
      const forget = () => {
        if (this.launching === launching) this.launching = undefined;
      };
      // A failed launch is retried, and a crashed browser relaunched, by the next caller.
      void launching.then((browser) => browser.on('disconnected', forget), forget);
      this.launching = launching;
    }
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    // The app owns SIGINT/SIGTERM/SIGHUP: its graceful stop closes Chromium itself.
    const browser = await chromium.launch({ headless: this.headless, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    this.log.info(`warm chromium launched (headless=${this.headless})`);
    return browser;
  }
}

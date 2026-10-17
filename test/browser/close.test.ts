import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeClose } from '../../src/browser/close.ts';
import { memoryLogger } from '../helpers/log.ts';

afterEach(() => vi.useRealTimers());

describe('safeClose', () => {
  it('gives up on a close that hangs after 5 s and logs it', async () => {
    vi.useFakeTimers();
    const log = memoryLogger();
    const closing = safeClose({ close: () => new Promise<void>(() => {}) }, 'render context', log);
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(log.text()).toBe('WARNING render context.close hung/failed: TimeoutError: ');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a failing close instead of throwing, and ignores nothing to close', async () => {
    const log = memoryLogger();
    await safeClose({ close: () => Promise.reject(new Error('connection closed')) }, 'browser', log);
    await safeClose(undefined, 'browser', log);
    expect(log.text()).toBe('WARNING browser.close hung/failed: Error: connection closed');
  });

  it('clears its timer when the close finishes in time', async () => {
    vi.useFakeTimers();
    await safeClose({ close: () => Promise.resolve() }, 'browser', memoryLogger());
    expect(vi.getTimerCount()).toBe(0);
  });
});

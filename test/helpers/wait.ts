import { setTimeout as sleep } from 'node:timers/promises';

/** Poll `probe` until it returns something other than undefined/false, or fail after `timeoutMs` (generous: whole apps run in parallel). */
export async function until<T>(probe: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(10);
  }
}

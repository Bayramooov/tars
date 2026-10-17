import type { Logger } from '../log/logger.ts';

/** How long a browser or context may take to close before we stop waiting. */
const CLOSE_TIMEOUT_MS = 5000;

/**
 * Close a browser or context within 5 s; a hang or failure is logged, never
 * thrown, so cleanup can't mask the error that triggered it.
 */
export async function safeClose(target: { close(): Promise<void> } | undefined, label: string, log: Logger): Promise<void> {
  if (!target) return;
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(''), { name: 'TimeoutError' })), CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([target.close(), hung]);
  } catch (err) {
    log.warn(`${label}.close hung/failed: ${(err as Error).name}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

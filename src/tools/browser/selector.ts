import type { ToolResult } from '../../mcp/tool.ts';

/**
 * Await a Playwright call that waits for a selector. Its timeout (the
 * element never appeared or never became actionable) comes back as
 * `undefined`; any other failure is a real tool error and is thrown.
 */
export async function trySelector<T>(op: Promise<T>): Promise<{ value: T } | undefined> {
  try {
    return { value: await op };
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') return undefined;
    throw err;
  }
}

/**
 * A selector miss is routine browsing, not a malfunction: a plain result the
 * model can adapt to, which also keeps it out of Claude Code's tool-error
 * circuit breaker.
 */
export const miss = (action: string, selector: string): ToolResult => ({
  content: `${action}: no element matching ${JSON.stringify(selector)} appeared in time (it may not be on this page — try a different selector)`,
});

/**
 * Tool-error circuit breaker: trips when `max` tool calls fail inside one
 * window with no successful call in between. The window opens at the first
 * error of a burst; a burst still under the limit when it lapses is forgotten.
 */
export class ToolErrorBreaker {
  private count = 0;
  private firstAt = 0;
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowSeconds: number) {
    this.max = max;
    this.windowMs = windowSeconds * 1000;
  }

  /** Record one failed tool call; true when it trips the breaker. */
  recordError(): boolean {
    const now = performance.now();
    if (this.count === 0 || now - this.firstAt > this.windowMs) {
      this.count = 0;
      this.firstAt = now;
    }
    this.count++;
    return this.count >= this.max;
  }

  /** A successful call (or a new turn) erases the burst. */
  reset(): void {
    this.count = 0;
  }

  describe(): string {
    const elapsed = (performance.now() - this.firstAt) / 1000;
    return `${this.count} errors in ${elapsed.toFixed(1)}s (max=${this.max}, window=${(this.windowMs / 1000).toFixed(0)}s)`;
  }
}

/**
 * Tool-error circuit breaker: trips when `max` tool calls fail inside one
 * window with no successful call in between. The window opens at the first
 * error of a burst; a burst still under the limit when it lapses is forgotten.
 */
export class ToolErrorBreaker {
  private count = 0;
  private firstAt: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowSeconds: number) {
    this.max = max;
    this.windowMs = windowSeconds * 1000;
  }

  /** Record one failed tool call; true when it trips the breaker. */
  recordError(): boolean {
    this.count++;
    if (this.firstAt === undefined) {
      this.firstAt = performance.now();
      this.timer = setTimeout(() => this.reset(), this.windowMs);
    }
    return this.count >= this.max;
  }

  /** A successful call (or a new turn) erases the burst. */
  reset(): void {
    this.cancelWindow();
    this.count = 0;
    this.firstAt = undefined;
  }

  /** A finished turn only stops the window timer. */
  cancelWindow(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  describe(): string {
    const elapsed = this.firstAt === undefined ? 0 : (performance.now() - this.firstAt) / 1000;
    return `${this.count} errors in ${elapsed.toFixed(1)}s (max=${this.max}, window=${(this.windowMs / 1000).toFixed(0)}s)`;
  }
}

/**
 * TokenPacer — normalises token delivery cadence across AI providers.
 *
 * OpenAI emits tiny deltas (1-4 chars) at high frequency, while Gemini
 * sends large irregular chunks.  TokenPacer sits between the provider
 * stream loop and the SSE transport, accumulating text and flushing at
 * a configurable pace that approximates comfortable human reading speed.
 *
 * Default settings target ~250 WPM (~20 chars per 100 ms).
 *
 * Usage:
 * ```ts
 * const pacer = new TokenPacer({
 *   onFlush: async (text) => {
 *     const event = StreamingEventFactory.createTokenEvent(text, position, ids);
 *     await transport.sendEventToSession(sessionId, event);
 *   },
 * });
 * // In streaming loop:
 * pacer.add(delta);
 * // After loop ends:
 * await pacer.flush();
 * pacer.destroy();
 * ```
 */
export interface TokenPacerConfig {
  /** Minimum characters to accumulate before flushing (default: 8). */
  minChunkSize?: number;
  /**
   * Maximum characters per flush.  If the buffer exceeds this after
   * accumulating, it is split on the nearest word boundary (default: 80).
   */
  maxChunkSize?: number;
  /** Target interval in ms between flushes (default: 80). */
  targetIntervalMs?: number;
  /** Hard deadline: flush no later than this many ms after first
   *  un-flushed character arrives (default: 100). */
  flushTimeoutMs?: number;
  /** Callback invoked with the text to emit.  Must be provided. */
  onFlush: (text: string) => Promise<void>;
}

const DEFAULTS = {
  minChunkSize: 8,
  maxChunkSize: 80,
  targetIntervalMs: 80,
  flushTimeoutMs: 100,
} as const;

export class TokenPacer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private destroyed = false;

  private readonly minChunkSize: number;
  private readonly maxChunkSize: number;
  private readonly targetIntervalMs: number;
  private readonly flushTimeoutMs: number;
  private readonly onFlush: (text: string) => Promise<void>;

  constructor(config: TokenPacerConfig) {
    this.minChunkSize = config.minChunkSize ?? DEFAULTS.minChunkSize;
    this.maxChunkSize = config.maxChunkSize ?? DEFAULTS.maxChunkSize;
    this.targetIntervalMs = config.targetIntervalMs ?? DEFAULTS.targetIntervalMs;
    this.flushTimeoutMs = config.flushTimeoutMs ?? DEFAULTS.flushTimeoutMs;
    this.onFlush = config.onFlush;
  }

  /**
   * Add text to the pacing buffer.
   * If the buffer reaches `minChunkSize` AND enough time has elapsed
   * since the last flush, it is flushed immediately.  Otherwise a
   * timeout is scheduled to flush within `flushTimeoutMs`.
   */
  add(text: string): void {
    if (this.destroyed || !text) return;
    this.buffer += text;

    const now = Date.now();
    const elapsed = now - this.lastFlushTime;

    if (
      this.buffer.length >= this.minChunkSize &&
      elapsed >= this.targetIntervalMs
    ) {
      // Enough text AND enough time — flush now
      void this.doFlush();
    } else if (this.timer === null) {
      // Schedule a deferred flush so text never sits longer than flushTimeoutMs
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.doFlush();
      }, this.flushTimeoutMs);
    }
  }

  /**
   * Force-flush any remaining buffered text.  Call this once after the
   * provider stream loop has ended.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.buffer) {
      await this.emit(this.buffer);
      this.buffer = "";
    }
  }

  /**
   * Clean up timers.  Call when discarding the pacer.
   */
  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
    this.buffer = "";
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async doFlush(): Promise<void> {
    this.clearTimer();
    if (!this.buffer) return;

    // If the buffer is larger than maxChunkSize, split on a word boundary
    // to avoid sending huge single events.
    while (this.buffer.length > this.maxChunkSize) {
      const chunk = this.splitAtWordBoundary(
        this.buffer,
        this.maxChunkSize,
      );
      this.buffer = this.buffer.slice(chunk.length);
      await this.emit(chunk);
    }

    // Flush the remainder (may be less than minChunkSize but
    // doFlush is only called when conditions are met or on timeout).
    if (this.buffer) {
      const text = this.buffer;
      this.buffer = "";
      await this.emit(text);
    }
  }

  private async emit(text: string): Promise<void> {
    this.lastFlushTime = Date.now();
    try {
      await this.onFlush(text);
    } catch {
      // Transport errors are handled by the caller; swallow here
      // so the pacer doesn't break the streaming loop.
    }
  }

  /**
   * Split `text` at the last whitespace character at or before `maxLen`.
   * Falls back to `maxLen` if no whitespace is found (hard split).
   */
  private splitAtWordBoundary(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const slice = text.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > 0) {
      return text.slice(0, lastSpace + 1);
    }
    // No word boundary found — hard split at maxLen
    return slice;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

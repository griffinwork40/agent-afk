/**
 * Momentum Ticker — live tokens-per-second counter for the REPL status line.
 *
 * Tracks output token deltas during model streaming and computes a smoothed
 * tok/s estimate using an exponential moving average (EMA). A throttled repaint
 * callback is fired internally so callers only need to call `update(charCount)`;
 * the ticker handles rate computation and status-line repainting automatically.
 *
 * The ticker is started at turn-begin, updated on each text-delta event, and
 * stopped when the turn ends — clearing the display so the status line only
 * shows tok/s while the model is actually streaming.
 *
 * @module cli/commands/interactive/momentum-ticker
 */

/** How many characters we count per estimated output token (rough average). */
const CHARS_PER_TOKEN = 4;

/** EMA smoothing factor α ∈ (0, 1]. Higher = more responsive, lower = smoother. */
const EMA_ALPHA = 0.25;

/**
 * Minimum elapsed milliseconds between two sample points before we compute a
 * rate. Below this threshold the delta is too small for a meaningful rate.
 */
const MIN_SAMPLE_MS = 50;

/**
 * Maximum elapsed milliseconds before we consider a gap a "pause" and
 * discard the stale interval. Long tool-use gaps would otherwise produce an
 * artificially low tok/s value.
 */
const MAX_GAP_MS = 3_000;

/**
 * Minimum interval between status-line repaints from within the ticker.
 * Keeps the repaint cadence at most once per 300ms without flooding the
 * terminal with escape sequences on every streaming chunk.
 */
const REPAINT_INTERVAL_MS = 300;

/**
 * Tracks output tokens per second during a streaming model turn.
 *
 * Accepts an optional `onRepaint` callback — called at most once per
 * `REPAINT_INTERVAL_MS` with the latest smoothed tok/s rate so the caller can
 * push an updated value to the status line without managing throttle state.
 *
 * Usage:
 * ```ts
 * const ticker = new MomentumTicker((rate) => statusLine.repaint({ ...fields, tokPerSec: rate ?? undefined }));
 * ticker.start();
 * ticker.update(charCount);   // call on each streaming text chunk
 * ticker.stop();              // clears rate; triggers a final repaint with null
 * ```
 */
export class MomentumTicker {
  private readonly onRepaint: ((rate: number | null) => void) | undefined;
  private running = false;
  private smoothedRate: number | null = null;
  private lastSampleMs: number | null = null;
  private pendingChars = 0;
  private lastRepaintMs = 0;

  constructor(onRepaint?: (rate: number | null) => void) {
    this.onRepaint = onRepaint;
  }

  /** Start the ticker. Resets all state from any prior turn. */
  start(): void {
    this.running = true;
    this.smoothedRate = null;
    this.lastSampleMs = null;
    this.pendingChars = 0;
    this.lastRepaintMs = 0;
  }

  /**
   * Record a text delta of `charCount` characters. Internally accumulates
   * characters and applies an EMA rate update whenever MIN_SAMPLE_MS has
   * elapsed since the last sample, then fires the throttled repaint callback
   * when REPAINT_INTERVAL_MS has elapsed since the last repaint.
   *
   * Silently ignored when the ticker is not running so callers need not gate
   * on state themselves.
   */
  update(charCount: number): void {
    if (!this.running || charCount <= 0) return;
    this.pendingChars += charCount;

    const now = Date.now();
    if (this.lastSampleMs === null) {
      this.lastSampleMs = now;
      return;
    }

    const elapsedMs = now - this.lastSampleMs;
    if (elapsedMs < MIN_SAMPLE_MS) return;

    if (elapsedMs > MAX_GAP_MS) {
      // Long gap (tool use, pause…) — restart the sample window.
      this.lastSampleMs = now;
      this.pendingChars = 0;
      return;
    }

    // Compute instantaneous rate from accumulated chars, apply EMA.
    const instantRate = (this.pendingChars / CHARS_PER_TOKEN / elapsedMs) * 1_000;
    this.smoothedRate =
      this.smoothedRate === null
        ? instantRate
        : EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * this.smoothedRate;

    this.lastSampleMs = now;
    this.pendingChars = 0;

    // Fire the throttled repaint callback.
    if (this.onRepaint && now - this.lastRepaintMs >= REPAINT_INTERVAL_MS) {
      this.lastRepaintMs = now;
      this.onRepaint(this.smoothedRate);
    }
  }

  /**
   * Returns the current smoothed tok/s estimate, or `null` when no rate has
   * been established yet. Always returns `null` when the ticker is stopped.
   */
  getCurrentRate(): number | null {
    if (!this.running) return null;
    return this.smoothedRate;
  }

  /**
   * Stop the ticker and clear the smoothed rate. Fires the repaint callback
   * with `null` so the status line clears the tok/s segment between turns.
   */
  stop(): void {
    this.running = false;
    this.smoothedRate = null;
    this.lastSampleMs = null;
    this.pendingChars = 0;
    this.lastRepaintMs = 0;
    this.onRepaint?.(null);
  }
}

/**
 * Rolling output tail buffer for live bash command progress display.
 *
 * Maintains the last N sanitized lines from streaming stdout/stderr and
 * delivers throttled change notifications to a TUI callback. The buffer
 * is ephemeral — its contents are NEVER forwarded to the model; only the
 * completed final output from the bash handler's accumulator reaches the
 * model context.
 *
 * Design constraints:
 *   1. Bounded: keeps at most MAX_LINES lines. Old lines are dropped as new
 *      lines arrive — O(1) memory, safe for long-running commands.
 *   2. Throttled: the onChange callback fires at most once per THROTTLE_MS
 *      interval. An immediate first-call fires to give the TUI a fast first
 *      paint, then subsequent calls are gated.
 *   3. CR handling: progress-bar patterns (e.g. `\rFoo 50%`) overwrite the
 *      current line rather than appending a new one — matching real terminal
 *      behavior. The last segment after the final `\r` replaces the current
 *      line rather than creating a sibling.
 *   4. ANSI stripped: uses sanitizeForDisplay from utils/terminal-sanitize.ts
 *      to remove escape sequences and control bytes before storage. Safe for
 *      direct TUI rendering.
 *
 * @module agent/tools/handlers/_rolling-tail
 */

import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';

/** Maximum lines retained in the rolling buffer. */
export const TAIL_MAX_LINES = 5;

/** Minimum milliseconds between onChange notifications. */
export const TAIL_THROTTLE_MS = 300;

/**
 * Callback invoked (throttled) when the rolling buffer changes.
 * Receives the current tail as a newline-joined string, or `undefined`
 * when the buffer is cleared (tool completed / aborted). The TUI layer
 * uses this to repaint the in-flight tool row.
 */
export type TailCallback = (tail: string | undefined) => void;

/**
 * Rolling output tail buffer.
 *
 * Feed raw stdout/stderr chunks via {@link push}. Reads the current
 * snapshot via {@link peek}. Clears and suppresses future notifications
 * via {@link clear}.
 */
export class RollingTailBuffer {
  private lines: string[] = [];
  private lastNotifiedAt = 0;
  private pendingFlush: ReturnType<typeof setTimeout> | undefined;
  private cleared = false;

  constructor(
    private readonly onChange: TailCallback,
    private readonly maxLines = TAIL_MAX_LINES,
    private readonly throttleMs = TAIL_THROTTLE_MS,
  ) {}

  /**
   * Ingest a raw output chunk (Buffer decoded to string or a string directly).
   * Splits on newlines, applies CR overwrite semantics within each segment,
   * strips ANSI, and appends to the rolling buffer. Schedules a throttled
   * notification.
   *
   * No-op after {@link clear} has been called.
   */
  push(raw: string): void {
    if (this.cleared) return;
    if (raw.length === 0) return;

    // Split on newlines first. Each segment may contain \r for progress-bar
    // patterns (e.g. `\rDownloading 50%`). Within a segment, the last CR
    // sub-segment overwrites the current line; only the final LF produces a
    // new line.
    //
    // Algorithm: split the input on \n. For each \n-segment, split on \r and
    // take the last sub-segment as the "current value" (CR-overwrite). If there
    // are preceding segments (there was a \n before this), push the CR-resolved
    // "previous current line" first, then replace. If not (only CR in this
    // segment), the last CR value replaces the current line in-place.
    const nlSegments = raw.split('\n');

    for (let i = 0; i < nlSegments.length; i++) {
      const seg = nlSegments[i]!;
      const crParts = seg.split('\r');
      // CR semantics: last part after any \r "overwrites" what came before.
      const effective = crParts[crParts.length - 1]!;

      if (i === 0) {
        // First \n-segment continues (appends to) the last line in the buffer.
        if (this.lines.length === 0) {
          this.lines.push(effective);
        } else {
          // Append to the current last line (no \n between them).
          const last = this.lines[this.lines.length - 1]!;
          // CR overwrite: if there were \r separators, effective replaces last;
          // otherwise (no \r), it concatenates.
          this.lines[this.lines.length - 1] =
            crParts.length > 1 ? effective : last + effective;
        }
      } else {
        // Subsequent \n-segments are new lines.
        // Trim the previous last line before pushing the new one.
        if (this.lines.length > 0) {
          const trimmed = sanitizeForDisplay(this.lines[this.lines.length - 1]!);
          if (trimmed.length > 0) {
            this.lines[this.lines.length - 1] = trimmed;
          } else {
            // Empty/whitespace-only line — drop it.
            this.lines.pop();
          }
        }
        // Only push non-empty effective values.
        if (effective.length > 0) {
          this.lines.push(effective);
        }
      }
    }

    // Enforce the line cap.
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }

    this.scheduleNotify();
  }

  /**
   * Return the current tail as a newline-joined string, or `undefined` if
   * the buffer is empty or has been cleared.
   */
  peek(): string | undefined {
    if (this.cleared || this.lines.length === 0) return undefined;
    return this.lines
      .map((l) => sanitizeForDisplay(l))
      .filter((l) => l.length > 0)
      .join('\n') || undefined;
  }

  /**
   * Clear the buffer and suppress all future notifications. Called when the
   * command completes or is aborted. Fires one final `undefined` notification
   * so the TUI can erase the tail from the overlay immediately.
   */
  clear(): void {
    if (this.cleared) return;
    this.cleared = true;
    this.lines = [];
    if (this.pendingFlush !== undefined) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = undefined;
    }
    this.onChange(undefined);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private scheduleNotify(): void {
    const now = Date.now();
    const elapsed = now - this.lastNotifiedAt;

    if (elapsed >= this.throttleMs) {
      // Outside the throttle window — fire immediately and reset the clock.
      this.lastNotifiedAt = now;
      if (this.pendingFlush !== undefined) {
        clearTimeout(this.pendingFlush);
        this.pendingFlush = undefined;
      }
      this.fireNotify();
    } else if (this.pendingFlush === undefined) {
      // Within throttle window — schedule a deferred fire at the boundary.
      const remaining = this.throttleMs - elapsed;
      this.pendingFlush = setTimeout(() => {
        this.pendingFlush = undefined;
        if (this.cleared) return;
        this.lastNotifiedAt = Date.now();
        this.fireNotify();
      }, remaining);
      // Unref so this timer doesn't keep Node alive if the process otherwise wants to exit.
      if (typeof this.pendingFlush === 'object' && 'unref' in this.pendingFlush) {
        (this.pendingFlush as NodeJS.Timeout).unref();
      }
    }
    // else: already a pending flush scheduled — it will fire at the boundary.
  }

  private fireNotify(): void {
    const tail = this.peek();
    this.onChange(tail);
  }
}

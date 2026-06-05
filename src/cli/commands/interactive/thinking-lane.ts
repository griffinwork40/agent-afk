import { palette } from '../../palette.js';
import { isDebugEnabled } from '../../../utils/debug.js';

/**
 * Render the canonical `◆ thought for Xs · N tok` summary line. Shared by
 * {@link ThinkingLane.collapse} (turn-total, non-TTY/subagent) and the TTY
 * orchestrator's per-phase inline commit (see `commitThinkingPhase`) so both
 * read identically.
 *
 * Clamps the duration at 0: `Date.now()` is not monotonic — NTP can step the
 * wall clock backward between the start and end samples, and a negative delta
 * would satisfy `< 1000` and render as "thought for -42ms".
 */
export function formatThoughtSummary(durationMs: number, charCount: number): string {
  const duration = Math.max(0, durationMs);
  const durationStr = duration < 1000
    ? `${duration}ms`
    : `${(duration / 1000).toFixed(1)}s`;
  // Rough token estimate: 1 token ~= 4 chars
  const tokenCount = Math.ceil(charCount / 4);
  return `  ${palette.thinking('◆ thought for ' + durationStr + ' · ' + tokenCount + ' tok')}`;
}

/**
 * Tracks thinking state for collapsing streamed thinking to a final summary.
 *
 * Duration semantics (load-bearing):
 *   The "thought for Xs" line reports time spent ON THINKING, not wall-clock
 *   from first-thinking-byte to turn-end. Without {@link markEnded}, the
 *   duration would include text streaming and tool calls that happened after
 *   the thinking phase concluded — producing ~9 tok/s "duration" lines for a
 *   model that thinks at ~50–80 tok/s, which misleads the operator about
 *   where the turn actually spent its budget.
 *
 *   Callers (orchestrator / subagent renderer) call {@link markEnded} on the
 *   first non-thinking event (text content, tool dispatch) to cap the window
 *   at the thinking→acting transition. The cap is idempotent and only takes
 *   the FIRST observation — later thinking chunks within the same turn (e.g.
 *   interleaved thinking between tool calls) are not currently re-opened.
 *   This matches the user-visible model: one "thought for" line per turn.
 */
export class ThinkingLane {
  private buffer: string = '';
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private hasEmitted: boolean = false;
  /**
   * Index into {@link buffer} marking how much has already been committed to
   * scrollback as a per-phase inline summary (TTY orchestrator path only).
   * {@link peekPhase}/{@link drainPhase} read and advance this; the cumulative
   * methods ({@link peek}, {@link consume}, {@link collapse},
   * {@link inlineSummary}) ignore it entirely, so the subagent / lifecycle /
   * non-TTY paths are unaffected.
   */
  private committedUpTo: number = 0;

  push(chunk: string): void {
    if (!this.hasEmitted) {
      this.buffer += chunk;
      if (!this.startedAt) this.startedAt = Date.now();
    }
  }

  /**
   * Cap the thinking-phase duration window at "now". Called by the renderer
   * when the first non-thinking event arrives (text content or tool dispatch).
   *
   * Idempotent: only the FIRST call takes effect. Subsequent calls — and
   * any further thinking chunks within the same turn — are ignored for
   * duration accounting. This matches the user-visible model: one
   * "thought for Xs" line per turn, anchored at the thinking→acting
   * transition.
   *
   * No-op when no thinking has been observed yet (startedAt is null).
   */
  markEnded(): void {
    if (this.endedAt === null && this.startedAt !== null) {
      this.endedAt = Date.now();
    }
  }

  isActive(): boolean {
    return !this.hasEmitted;
  }

  hasBufferedContent(): boolean {
    return this.buffer.trim().length > 0;
  }

  peek(): string {
    return this.buffer;
  }

  consume(): string {
    this.hasEmitted = true;
    return this.buffer;
  }

  /**
   * The current uncommitted thinking phase — everything pushed since the last
   * {@link drainPhase} (or turn start). Powers the live overlay preview so it
   * shows only the CURRENT phase: once a phase is sealed via {@link drainPhase}
   * this returns '' until the next {@link push}, so the overlay clears instead
   * of re-showing reasoning already collapsed into an inline summary above.
   *
   * Reads a slice of the cumulative buffer; does not flip `hasEmitted`, so it
   * is independent of {@link consume}/{@link collapse}.
   */
  peekPhase(): string {
    return this.buffer.slice(this.committedUpTo);
  }

  /**
   * Seal the current phase: return its uncommitted text and advance the commit
   * pointer so {@link peekPhase} reports empty until the next {@link push}. The
   * caller (TTY orchestrator) formats the returned text into an inline summary;
   * the cumulative buffer is left intact for any later {@link collapse} /
   * {@link inlineSummary} (non-TTY / subagent paths).
   */
  drainPhase(): string {
    const phase = this.buffer.slice(this.committedUpTo);
    this.committedUpTo = this.buffer.length;
    return phase;
  }

  collapse(): string | null {
    if (this.hasEmitted || !this.startedAt) {
      // Diagnose the silent-drop case: thinking was configured (caller only
      // reaches collapse() when thinkingMode !== 'off') but no chunks
      // arrived. Distinguishes "render bug" from "model produced no
      // reasoning blocks" without a code change. Opt-in via AFK_DEBUG so it
      // doesn't pollute normal stderr.
      if (!this.startedAt && !this.hasEmitted && isDebugEnabled()) {
        // eslint-disable-next-line no-console
        console.error(
          '[afk:thinking] collapse() short-circuited: no thinking chunks received this turn. ' +
            'Model may not support extended thinking, or API ignored the thinking parameter.',
        );
      }
      return null;
    }
    this.hasEmitted = true;

    // Use the captured thinking→acting boundary when available; fall back to
    // wall-clock when the caller never signaled (e.g. pure-thinking turn with
    // no subsequent content or tool calls). formatThoughtSummary owns the 0-clamp
    // (NTP step-back guard) and the shared "◆ thought for Xs · N tok" format.
    const end = this.endedAt ?? Date.now();
    return formatThoughtSummary(end - this.startedAt, this.buffer.length);
  }

  /**
   * Compact inline form of the buffered thinking — "thought 1.5s · 320 tok"
   * — for embedding into another summary line (e.g. a subagent's Done row).
   * Distinct from {@link collapse}: no leading whitespace, no glyph, no color,
   * and does NOT flip `hasEmitted` so the caller can still call collapse later
   * if needed. Returns null when the buffer is empty.
   *
   * Honors the same {@link markEnded} cap as {@link collapse} so the Done-row
   * stat reads the thinking duration, not turn wall-clock.
   */
  inlineSummary(): string | null {
    if (!this.startedAt || !this.hasBufferedContent()) return null;
    const end = this.endedAt ?? Date.now();
    const duration = Math.max(0, end - this.startedAt);
    const durationStr = duration < 1000
      ? `${duration}ms`
      : `${(duration / 1000).toFixed(1)}s`;
    const tokenCount = Math.ceil(this.buffer.length / 4);
    return `thought ${durationStr} · ${tokenCount} tok`;
  }
}

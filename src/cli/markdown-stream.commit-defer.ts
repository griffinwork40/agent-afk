/**
 * Commit timing for the text reveal: deferred block commits, plus the queue
 * the smoke-accent heading hold parks text in.
 *
 * The renderer commits a block to scrollback the moment its `\n\n` boundary
 * arrives, and committed text is written once, solid. A model streams at
 * roughly the reveal's pace or faster, so at the boundary most of the block
 * was still fading in and snapped solid: a smooth title, then a body that
 * "glitched and skipped".
 *
 * Invariant (defer the commit, never the text): new text keeps flowing into
 * the pending buffer and the reveal front never stops. Only the COMMIT of a
 * completed block waits, until its last letter is far enough through its fade,
 * so the live overlay briefly shows the finished block's tail above the next
 * block's front. The commit then runs through the renderer's ordinary path
 * (`syncPendingOverlay` then `commitAbove`), with the same layout and the
 * same number of commits as without the reveal.
 *
 * History: an earlier version HELD the text after the boundary instead. That
 * starved the front at every paragraph break (the tail decelerates, then the
 * last letter's fade is waited out with nothing new to reveal), so lag piled
 * up until the hold limit forced the snap anyway: 52% of letters animated at
 * 240 chars/s, versus 100% with deferral (see docs/pr-smoke-ink-reveal.md).
 *
 * Contract: deferral is bounded (`COMMIT_DEFER_MAX_MS` per block), never
 * applies to a render the mask skips (code, tables, height-truncated
 * overlays), and every path that must commit synchronously (tool rows,
 * flush, retry discard) forces the deferred blocks out first, in order.
 * @module cli/markdown-stream.commit-defer
 */

/**
 * Longest a completed block's commit may be deferred after it first could commit.
 * Sized above the reveal's worst steady backlog (`MAX_LAG_MS`) so a block
 * still inking in is not snapped solid by this bound.
 */
export const COMMIT_DEFER_MAX_MS = 2500;
/** Longest the end of a cleanly finished stream waits for its tail to settle (same sizing). */
export const REVEAL_SETTLE_MAX_MS = 2500;

/** Deferral state for the oldest completed-but-uncommitted block. */
export class CommitDefer {
  private since: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** While true, every block commits immediately (synchronous drains). */
  forced = false;

  /** `recheck` re-runs block detection once a deferral may have expired. */
  constructor(private readonly recheck: () => void) {}

  /** True while a deferred block is waiting on its timer. */
  get pending(): boolean { return this.timer !== null; }

  /**
   * Whether to keep the oldest completed block pending. `remaining` is the
   * reveal dwell left for its last letter (0 = settled or not animated).
   */
  shouldDefer(remaining: number, now = Date.now()): boolean {
    if (this.forced || remaining <= 0) return false;
    this.since ??= now;
    const left = this.since + COMMIT_DEFER_MAX_MS - now;
    if (left <= 0) return false;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recheck();
    }, Math.min(remaining, left));
    return true;
  }

  /** The oldest block committed: the next one starts its own deferral clock. */
  committed(): void {
    this.since = null;
  }

  /** Stop the recheck timer and forget the deferral clock. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reset(): void {
    this.cancel();
    this.since = null;
  }
}

/** A held run of raw markdown and the time it arrived. */
export interface HeldPiece {
  text: string;
  at: number;
}

/** Ordered held text (smoke-accent heading hold) plus the one timer that releases it. */
export class HoldQueue {
  private pieces: HeldPiece[] = [];
  private timer: NodeJS.Timeout | null = null;

  /** True while any text is held. */
  get active(): boolean { return this.pieces.length > 0; }
  /** All held text, in order (for inspection; nothing is released). */
  get text(): string { return this.pieces.map((p) => p.text).join(''); }

  /** Start holding `piece`; `onRelease` fires once after `waitMs`. */
  hold(piece: HeldPiece, waitMs: number, onRelease: () => void): void {
    this.cancelTimer();
    this.pieces = [piece];
    this.timer = setTimeout(() => {
      this.timer = null;
      onRelease();
    }, waitMs);
  }

  /** Queue text that arrived while holding, keeping its own arrival time. */
  append(text: string, at: number): void {
    this.pieces.push({ text, at });
  }

  /** Stop the timer and hand back every held piece, oldest first. */
  take(): HeldPiece[] {
    this.cancelTimer();
    const out = this.pieces;
    this.pieces = [];
    return out;
  }

  /** Drop held text from `offset` (into `text`) onward. False when out of range. */
  stripFrom(offset: number): boolean {
    if (offset < 0 || offset >= this.text.length) return false;
    const kept: HeldPiece[] = [];
    let pos = 0;
    for (const p of this.pieces) {
      if (pos + p.text.length <= offset) kept.push(p);
      else if (pos < offset) kept.push({ text: p.text.slice(0, offset - pos), at: p.at });
      pos += p.text.length;
    }
    this.pieces = kept;
    if (kept.length === 0) this.cancelTimer();
    return true;
  }

  /** Discard everything without releasing it. */
  clear(): void {
    this.cancelTimer();
    this.pieces = [];
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

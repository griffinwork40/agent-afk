/**
 * Held `◆ thought for Xs` summary: the AFK_SMOKE_TEXT fade for a line that is
 * normally committed straight to scrollback.
 *
 * Committed rows are immutable, so a fade cannot run on them. Instead, while
 * smoke is enabled, the summary is shown in its own overlay slot for the
 * length of the fade and committed afterwards: the "pending, then commit"
 * handoff that streamed markdown already uses.
 *
 * Invariant (scrollback order): the held summary must land ABOVE everything
 * committed after it was shown. `hold()` registers a compositor commit
 * barrier (`TerminalCompositor.setCommitBarrier`), so the first of these
 * wins and commits the summary: any other commitAbove, endTurn, disarm, the
 * settle timer, a newer hold(), or dispose(). The summary is committed
 * exactly once, with the exact bytes the no-smoke path would have written.
 *
 * Invariant (commit sequence), same rule as `commitPending` in
 * markdown-stream.ts: (1) drop the held state and withdraw the barrier,
 * (2) recompose the overlay WITHOUT the summary, (3) commitAbove it.
 * Committing while the overlay still shows the line would paint it twice
 * for a frame, and can drop the block when the overlay is tall.
 *
 * @module cli/_lib/thought-summary-hold
 */

import { contentMargin } from '../render/measure.js';
import { FADE_FRAME_MS, FADE_MS, type ElementFade } from '../smoke-fade.js';

/** Overlay slot key. Must appear in StreamRenderer's composer order. */
export const THOUGHT_SUMMARY_SLOT = 'thought-summary';

/** The compositor surface the hold needs: commits plus the one-shot barrier. */
export interface HoldCompositor {
  commitAbove(text: string): void;
  setCommitBarrier(fn: (() => void) | null): void;
}

/** The overlay composer surface the hold needs. */
export interface HoldComposer {
  markDirty(key: string): void;
  flush(): void;
}

export class ThoughtSummaryHold {
  private held: { line: string; key: string } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(
    private readonly compositor: HoldCompositor,
    private readonly composer: HoldComposer,
    private readonly fade: ElementFade,
  ) {}

  /**
   * Show `line` (one styled summary row, exactly as it would be committed)
   * in the overlay while it fades in, and commit it once the fade settles or
   * as soon as anything else is committed. An earlier held line is committed
   * first, so consecutive summaries keep their order.
   */
  hold(line: string): void {
    this.commitHeld();
    this.seq += 1;
    this.held = { line, key: `thought-summary:${this.seq}` };
    this.compositor.setCommitBarrier(() => this.commitHeld());
    // One frame past the fade, so the final (settled) overlay frame is the
    // last thing painted before the line moves into scrollback.
    this.settleTimer = setTimeout(() => this.commitHeld(), FADE_MS + FADE_FRAME_MS);
    this.settleTimer.unref?.();
    this.composer.markDirty(THOUGHT_SUMMARY_SLOT);
    this.composer.flush();
  }

  /** Overlay slot content: the fading summary, or '' when nothing is held. */
  render(): string {
    if (!this.held) return '';
    const lines = [this.held.line];
    this.fade.fadeLines(this.held.key, lines, 0);
    // Content centering: overlay rows do not pass through commitAbove (which
    // centers at paint time), so the slot adds the margin itself, as the
    // thinking-live slot does.
    const pad = contentMargin();
    return pad + (lines[0] ?? '');
  }

  /** Commit the held summary now, if any. Safe to call repeatedly. */
  commitHeld(): void {
    const held = this.held;
    if (!held) return;
    // Sequence (see module header): state + barrier, then overlay, then commit.
    this.held = null;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.compositor.setCommitBarrier(null);
    this.composer.markDirty(THOUGHT_SUMMARY_SLOT);
    this.composer.flush();
    this.compositor.commitAbove(held.line);
  }

  /** Turn end: commit anything still held. Idempotent. */
  dispose(): void {
    this.commitHeld();
  }
}

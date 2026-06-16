import { ResizeBus } from './terminal-size.js';
import type { TerminalCompositor } from './terminal-compositor.js';
import type { OverlayComposer } from './_lib/overlay-composer.js';
import { findBlockBoundary, calculateContentWidth, formatPendingBuffer, formatBlockForCommit, applyIndent, initLogUpdateModule, routeOverlayOutput, accumulateCommitted, scheduleWithThrottle } from './markdown-stream-format.js';

/**
 * Block boundary detection patterns.
 * A block is complete when we detect:
 * 1. Double newline (paragraph/section break)
 * 2. Closing fenced code fence (``` on its own line)
 * 3. End-of-content on flush
 */

interface StreamingMarkdownRendererOptions {
  out?: NodeJS.WriteStream;
  throttleMs?: number;
  indent?: string;
  /**
   * When provided: overlay routes through `compositor.setOverlay()`, scrollback
   * via `compositor.commitAbove()`. The compositor owns frame rendering via
   * `CupFrameRenderer` so a persistent input line can coexist below.
   *
   * When absent: falls back to direct `log-update` on `out`. Reserved for
   * non-TTY surfaces (Telegram/daemon/tests — `initLogUpdate` short-circuits
   * on `!isTTY`) and TTY callers that haven't armed a compositor.
   *
   * Invariant: never construct this renderer without a compositor on a TTY
   * surface that has an independently-armed `TerminalCompositor` painting
   * the same stdout. `CupFrameRenderer` + `log-update` both write CUP/erase
   * escapes — concurrent ownership of one TTY interleaves frames (the
   * "stacked prompt" rendering bug). The sole production caller
   * (`stream-renderer-orchestrator.ts:176`) honors this by passing
   * `ctx.compositor` whenever non-null.
   */
  compositor?: TerminalCompositor;
  /**
   * Optional reference to the OverlayComposer. When provided, the renderer
   * marks the 'markdown-pending' slot dirty instead of calling setOverlay
   * directly. Enables composition of markdown + tool-lane + other overlays
   * through a single repaint cycle instead of racing one slot.
   */
  overlayComposer?: OverlayComposer | null;
}

interface LogUpdateFunction {
  (str: string): void;
  clear: () => void;
}

/**
 * StreamingMarkdownRenderer
 *
 * Maintains two output regions:
 * - committed: finalized blocks, printed once, never rewritten
 * - pending: partial in-progress block, rewritten via log-update on each new chunk
 *
 * Block boundaries are detected by:
 * 1. Double newlines (\n\n)
 * 2. Closing fenced code fence (``` on its own line)
 * 3. Markdown list/heading boundaries
 *
 * When a complete block is detected, it's rendered via renderMarkdownToTerminal
 * and moved to committed. Remaining content stays in pending for incremental rewrite.
 */
export class StreamingMarkdownRenderer {
  private out: NodeJS.WriteStream;
  private throttleMs: number;
  private indent: string;
  private buffer: string = '';
  private committed: string = '';
  private throttleTimer: NodeJS.Timeout | null = null;
  private logUpdate: LogUpdateFunction | null = null;
  private isTTY: boolean;
  private flushing = false;
  private compositor: TerminalCompositor | null;
  private overlayComposer: OverlayComposer | null;
  /**
   * ResizeBus unsubscriber. Set in the constructor when running in TTY mode,
   * cleared in `dispose()`. On resize the bus fires `scheduleRepaint()` so the
   * pending buffer re-renders at the current `getTerminalWidth()` — without
   * this, the overlay stays wrapped at the width-at-last-push until the next
   * content chunk arrives, which makes the in-progress assistant message look
   * "wonky" after the user drags the window.
   *
   * The bus debounce (150ms) + our own throttle (33ms) coalesce rapid drags
   * into one repaint at rest.
   */
  private resizeUnsub: (() => void) | null = null;

  constructor(opts?: StreamingMarkdownRendererOptions) {
    this.out = opts?.out ?? process.stdout;
    this.throttleMs = opts?.throttleMs ?? 33;
    this.indent = opts?.indent ?? '  ';
    this.isTTY = this.out.isTTY ?? false;
    this.compositor = opts?.compositor ?? null;
    this.overlayComposer = opts?.overlayComposer ?? null;

    // Lazy-load log-update only if TTY
    this.logUpdate = null;

    // Subscribe to terminal-resize events so the pending buffer re-wraps at
    // the new column count. Non-TTY surfaces never paint an overlay, so the
    // subscription is a no-op there — skip it to avoid the listener overhead.
    if (this.isTTY) {
      this.resizeUnsub = ResizeBus.subscribe(() => this.scheduleRepaint());
    }
  }

  /**
   * Initialize log-update if TTY (lazy-load to avoid unnecessary dependency)
   */
  private async initLogUpdate(): Promise<void> {
    if (!this.isTTY || this.logUpdate !== null) {
      return;
    }
    this.logUpdate = (await initLogUpdateModule()) as LogUpdateFunction | null;
  }



  /**
   * Render and commit a completed block
   */
  private commitBlock(blockText: string): void {
    if (!blockText.trim()) {
      return;
    }

    const contentWidth = calculateContentWidth(this.indent.length);
    const trimmed = formatBlockForCommit(blockText, this.indent, contentWidth);

    // Invariant (TUI rhythm contract): every committed block owns ONE
    // trailing blank line so it has breathing room from whatever follows.
    // `commitAbove` strips a single trailing '\n' before computing line
    // count, so `trimmed + '\n\n'` lands as `<block>\n<blank>` in
    // scrollback — one paragraph + one separator row. See
    // docs/tui-rhythm.md for the full contract.
    if (this.compositor) {
      this.compositor.commitAbove(trimmed + '\n\n');
    }

    this.committed = accumulateCommitted(this.committed, trimmed);
  }

  /**
   * Schedule a repaint of the pending region via log-update (throttled)
   */
  private scheduleRepaint(): void {
    if (!this.isTTY || this.flushing) {
      return; // Skip repaints for non-TTY streams or during flush
    }

    this.throttleTimer = scheduleWithThrottle(
      () => {
        this.throttleTimer = null;
        void this.repaint();
      },
      this.throttleMs,
      this.throttleTimer,
    );
  }

  /**
   * Get the pending markdown render as a string. Returns '' when there is no
   * pending content, not in TTY mode, or flushing. Used by the OverlayComposer
   * 'markdown-pending' slot to render the current pending buffer.
   *
   * This is the actual formatted string that would be displayed — extract
   * the logic so both the direct setOverlay path (non-composer) and the
   * composer path (via slot) can generate identical output.
   */
  renderPending(): string {
    const contentWidth = calculateContentWidth(this.indent.length);
    const formatted = formatPendingBuffer(this.buffer, contentWidth, this.isTTY && !this.flushing);
    return applyIndent(formatted, this.indent);
  }

  /**
   * Invariant (commit-time overlay sync): re-compose the live overlay from the
   * CURRENT buffer BEFORE a `commitAbove()` runs, so the overlay no longer shows
   * the block being committed. Callers MUST remove the committed block from
   * `this.buffer` first (push() slices it out; commitPending() empties it).
   *
   * Without this, the overlay still renders the just-committed block while
   * `commitAbove` repaints the frame. A multi-line block (e.g. a rendered
   * table) leaves the overlay tall enough to pin the live frame to row 1
   * (`prevTopRow == 1`), which routes the committed block down the legacy
   * overflow path — where the band-hold gate is suppressed and the block can be
   * dropped from screen AND scrollback. flush() already does this refresh before
   * its tail commit (via the `flushing` flag, which makes renderPending() empty);
   * push()/commitPending() need the explicit call because they commit while
   * `flushing` is false. See terminal-compositor.ts commitAbove (band-hold path).
   */
  private syncPendingOverlay(): void {
    if (this.overlayComposer) {
      this.overlayComposer.markDirty('markdown-pending');
      this.overlayComposer.flush();
    } else if (this.compositor) {
      this.compositor.setOverlay(this.renderPending());
    }
  }

  /**
   * Execute a single repaint of pending content
   */
  private async repaint(): Promise<void> {
    if (this.flushing) {
      return; // A flush is in progress; don't paint stale pending content
    }

    const indented = this.renderPending();
    if (!indented) {
      return;
    }

    if (routeOverlayOutput({
      indented,
      overlayComposer: this.overlayComposer,
      compositor: this.compositor,
      logUpdate: this.logUpdate,
    })) {
      return;
    }

    // Log-update path: need to ensure logUpdate is initialized
    if (!this.logUpdate) {
      await this.initLogUpdate();
    }
    if (!this.logUpdate) return;
    if (this.flushing) return;

    this.logUpdate(indented);
  }

  /**
   * Push a chunk of markdown text and schedule incremental rendering
   */
  push(chunk: string): void {
    if (this.flushing) return; // Terminal after flush — don't accumulate orphan committed content
    this.buffer += chunk;

    // Try to extract completed blocks
    let boundary = findBlockBoundary(this.buffer);

    while (boundary !== -1) {
      const blockText = this.buffer.slice(0, boundary);
      // Slice buffer BEFORE commitBlock so any synchronous repaint
      // triggered by compositor.commitAbove() sees only the remaining
      // content, not the block that was just committed.
      this.buffer = this.buffer.slice(boundary);
      // Re-compose the overlay from the now-sliced buffer BEFORE committing, so
      // commitAbove() does not fire while the overlay still shows this block
      // (which would pin the frame to row 1 and risk dropping a multi-line
      // block via the overflow path). See syncPendingOverlay().
      this.syncPendingOverlay();
      this.commitBlock(blockText);

      boundary = findBlockBoundary(this.buffer);
    }

    // Schedule repaint of remaining pending content
    this.scheduleRepaint();
  }

  /**
   * Finalize the stream: render and commit any remaining content,
   * and clear the log-update overlay
   */
  async flush(): Promise<void> {
    // Cancel throttle timer
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    // Mark flushing so any in-flight repaint() bails out before painting,
    // and no further repaints are scheduled.
    this.flushing = true;

    // Composer mode: clear the markdown slot and flush so the overlay
    // re-renders without the pending block. This happens BEFORE committing
    // the tail buffer so the final commitBlock → commitAbove → repaint cycle
    // doesn't re-render stale pending text between the just-committed scrollback
    // line and the input row.
    if (this.overlayComposer) {
      this.overlayComposer.markDirty('markdown-pending');
      this.overlayComposer.flush();
    } else if (this.compositor) {
      this.compositor.setOverlay('');
    }

    // Commit any remaining buffer
    if (this.buffer.trim()) {
      this.commitBlock(this.buffer);
      this.buffer = '';
    }

    if (this.compositor || this.overlayComposer) {
      return;
    }

    // Clear log-update overlay (for TTY)
    if (this.isTTY && this.logUpdate) {
      // Clear the overlay first so log-update's tracked region is released,
      // then write committed content onto fresh ground.
      this.logUpdate.clear();
      this.out.write(this.committed + '\n');
    } else if (this.committed) {
      // Non-TTY: just append committed content
      this.out.write(this.committed + '\n');
    }
  }

  /**
   * Get all committed output (for testing)
   */
  getCommittedOutput(): string {
    return this.committed;
  }

  /**
   * Returns true once at least one non-empty content chunk has been pushed
   * through this renderer. Safe to call from a synchronous event handler —
   * O(1), no side effects.
   */
  hasEmitted(): boolean {
    return this.buffer.length > 0 || this.committed.length > 0;
  }

  /**
   * Get the raw pending buffer (for testing)
   */
  getPendingBuffer(): string {
    return this.buffer;
  }

  /**
   * Commit any pending buffer to scrollback as a block and clear the overlay.
   * Called by the turn handler at content-block boundaries (e.g., when a
   * tool_use chunk arrives, signalling the preceding text content is closed)
   * so the orchestrator's text doesn't sit in the overlay for the rest of
   * the turn — where it leaks into scrollback every time `commitAbove` repaints.
   */
  commitPending(): void {
    if (!this.buffer.trim()) return;
    const pending = this.buffer;
    // Empty the buffer and re-compose the overlay (now empty) BEFORE committing,
    // so commitAbove() does not fire while the overlay still shows this block.
    // See syncPendingOverlay() / push() for the rationale (prevTopRow==1 drop).
    this.buffer = '';
    this.syncPendingOverlay();
    this.commitBlock(pending);
  }

  /**
   * Discard the pending (uncommitted) buffer WITHOUT committing it to
   * scrollback, and clear the live overlay. Counterpart to {@link
   * commitPending} (which COMMITS the buffer) and distinct from {@link
   * dispose} (which tears down timers + subscriptions at end-of-life).
   *
   * Called on a mid-stream retry (anthropic-direct overload re-drive): the
   * partial text streamed before the retry will be re-streamed from scratch,
   * so committing it here would duplicate it. Blocks already committed to
   * scrollback (past a `\n\n` boundary) are append-only and cannot be recalled
   * — only the in-progress pending block is recoverable.
   */
  discardPending(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.buffer = '';
    // Clear the live overlay in whichever mode is active — mirror the slot
    // clears in commitPending()/flush() so the discarded text vanishes from
    // the screen, not just from the buffer.
    if (this.overlayComposer) {
      this.overlayComposer.markDirty('markdown-pending');
      this.overlayComposer.flush();
    } else if (this.compositor) {
      this.compositor.setOverlay('');
    } else if (this.isTTY && this.logUpdate) {
      this.logUpdate.clear();
    }
  }

  /**
   * Clean up resources: clear timers and release log-update state
   */
  dispose(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }

    if (this.logUpdate) {
      this.logUpdate.clear();
      this.logUpdate = null;
    }

    this.buffer = '';
    this.committed = '';
  }
}

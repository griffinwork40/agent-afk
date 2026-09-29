import { ResizeBus } from './terminal-size.js';
import type { TerminalCompositor } from './terminal-compositor.js';
import { CommitWriteTx, type TxStream } from './terminal-compositor.commit-write-tx.js';
import type { OverlayComposer } from './_lib/overlay-composer.js';
import { calculateContentWidth, calculateProseContentWidth, formatBlockForCommit, applyIndent, initLogUpdateModule, accumulateCommitted, scheduleWithThrottle } from './markdown-stream-format.js';
import { PendingFormatCache } from './markdown-stream.pending-cache.js';
import { contentMargin } from './render/measure.js';
import { HOLD_RECHECK_MS, SmokeReveal, defaultRevealStyle, isInkTextEnabled, isSmokeTextEnabled } from './smoke-reveal.js';
import { splitAtHeadingBoundary } from './markdown-stream.heading-hold.js';
import { CommitDefer, HoldQueue, REVEAL_SETTLE_MAX_MS } from './markdown-stream.commit-defer.js';
import { countVisible } from './smoke-reveal.ansi.js';
import { detectReducedMotion } from './_lib/capture-mode.js';
import {
  type InputBufferState,
  type LogUpdateFunction,
  createInputBufferState,
  pushChunk,
  drainInputBuffer,
  discardInputBuffer,
  runParsePipeline,
  clearOverlay,
  syncPendingOverlay,
  executeRepaint,
} from './markdown-stream-buffer.js';

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
  /**
   * Input buffer window in milliseconds. When positive, incoming `push()`
   * chunks are accumulated and flushed to the parse pipeline on a
   * leading+trailing timer -- reducing per-token `Lexer.lex()` overhead and
   * producing visually smoother bursts. First chunk after idle passes
   * through immediately (leading-edge). 0 = disabled (default).
   */
  bufferMs?: number;
  indent?: string;
  /**
   * Suppress the text reveal (AFK_INK_TEXT prose fade, AFK_SMOKE_TEXT heading
   * accent). Defaults to
   * `detectReducedMotion()` (AFK_REDUCED_MOTION=1), the same source the
   * stream renderer uses to gate its tool-row and thought-summary fades.
   */
  reducedMotion?: boolean;
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
  /** Epoch ms of the last leading-edge repaint -- enables the leading+trailing
   *  throttle in `scheduleRepaint`. Starts at 0 so the very first push fires
   *  immediately (0 - 0 >= 33). */
  private lastPaintTime = 0;
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

  // -- Input micro-buffer (AFK_STREAM_BUFFER_MS) --------------------------
  // Delegates to markdown-stream-buffer.ts helpers. The state record is held
  // here so the class owns the lifetime; the buffer helpers are stateless.
  private bufferMs: number;
  private inputState: InputBufferState;

  /** Text reveal mask (ink prose, optional smoke headings). Null when the reveal is off. */
  private smoke: SmokeReveal | null = null;
  /** Memoized pending render: an unchanged buffer is not reformatted on a reveal frame. */
  private readonly pendingCache = new PendingFormatCache();
  /**
   * Smoke accent heading hold (markdown-stream.heading-hold.ts): text from the
   * character that would commit a still-condensing heading onward. Released
   * on a timer, or synchronously by every path that commits or inspects the
   * buffer.
   */
  private readonly holds = new HoldQueue();
  /** Deferred block commits while a block is still fading in (markdown-stream.commit-defer.ts). */
  private readonly defer = new CommitDefer(() => this.runPipeline(''));
  /** Set by noteStreamDone(): the stream finished cleanly, so its tail may settle. */
  private streamDone = false;
  private accent = false;

  constructor(opts?: StreamingMarkdownRendererOptions) {
    this.out = opts?.out ?? process.stdout;
    this.throttleMs = opts?.throttleMs ?? 33;
    this.bufferMs = opts?.bufferMs ?? 0;
    this.indent = opts?.indent ?? '   ';
    this.isTTY = this.out.isTTY ?? false;
    this.compositor = opts?.compositor ?? null;
    this.overlayComposer = opts?.overlayComposer ?? null;
    this.inputState = createInputBufferState();

    // Subscribe to terminal-resize events so the pending buffer re-wraps at
    // the new column count. Non-TTY surfaces never paint an overlay, so the
    // subscription is a no-op there — skip it to avoid the listener overhead.
    if (this.isTTY) {
      this.resizeUnsub = ResizeBus.subscribe(() => this.scheduleRepaint());
      // Read once per renderer, like the other display settings: toggling
      // AFK_INK_TEXT / AFK_SMOKE_TEXT mid-session applies to the next renderer.
      // Reduced motion wins: the reveal is pure motion, so a user who asked
      // for less of it gets plain text, same as the machine-status fades.
      const reducedMotion = opts?.reducedMotion ?? detectReducedMotion();
      const accent = isSmokeTextEnabled();
      if ((isInkTextEnabled() || accent) && !reducedMotion) {
        this.accent = accent;
        const style = defaultRevealStyle();
        this.smoke = new SmokeReveal(() => this.paintFrame(), Date.now, {
          prose: style,
          headings: accent ? 'smoke' : style,
        });
      }
    }
  }

  /** Lazy-load log-update; stores result on `this.logUpdate` and returns it. */
  private async initLogUpdate(): Promise<LogUpdateFunction | null> {
    if (!this.isTTY || this.logUpdate !== null) return this.logUpdate;
    this.logUpdate = (await initLogUpdateModule()) as LogUpdateFunction | null;
    return this.logUpdate;
  }

  /**
   * Render and commit a completed block
   */
  private commitBlock(blockText: string): void {
    if (!blockText.trim()) {
      return;
    }

    // Code fences use the full measure (default 100); prose uses the tighter
    // prose measure (default 80) for comfortable reading line length.
    const isCode = /^ {0,3}(`{3,}|~{3,})/.test(blockText.trimStart());
    const contentWidth = isCode
      ? calculateContentWidth(this.indent.length)
      : calculateProseContentWidth(this.indent.length);
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
    // While the reveal animates, its 60 fps frame clock owns the paint
    // cadence: a request only marks the next frame dirty, so pushes can never
    // delay a frame or paint twice in one period. See markdown-stream.frame-clock.ts.
    if (this.smoke?.animating) {
      this.smoke.markDirty();
      return;
    }

    const result = scheduleWithThrottle(
      () => {
        this.throttleTimer = null;
        // A trailing paint armed just before the animation started defers to the clock.
        if (this.smoke?.animating) return this.smoke.markDirty();
        this.lastPaintTime = Date.now();
        void this.repaint();
      },
      this.throttleMs,
      this.throttleTimer,
      this.lastPaintTime,
    );
    this.throttleTimer = result.timer;
    this.lastPaintTime = result.paintTime;
  }

  /** One frame-clock paint: unthrottled, and it supersedes any trailing throttle paint. */
  private paintFrame(): void {
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    this.lastPaintTime = Date.now();
    void this.repaint();
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
    const { pending, contentWidth, reveal } = this.pendingRender();
    let formatted = pending.formatted;
    if (this.smoke && reveal) formatted = this.smoke.apply(formatted, { maxWidth: contentWidth });
    // Content centering (AFK_CENTER_CONTENT): live pending prose is part of
    // the overlay frame, so it receives the centering margin here (the overlay
    // is never routed through commitAbove, which handles scrollback centering).
    const pad = contentMargin();
    const indented = applyIndent(formatted, this.indent);
    if (!pad) return indented;
    return indented.split('\n').map(l => l === '' ? l : pad + l).join('\n');
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
    syncPendingOverlay(this.overlayComposer, this.compositor, () => this.renderPending());
  }

  /**
   * Execute a single repaint of pending content
   */
  private async repaint(): Promise<void> {
    await executeRepaint({
      flushing: this.flushing,
      overlayComposer: this.overlayComposer,
      compositor: this.compositor,
      logUpdate: this.logUpdate,
      renderPending: () => this.renderPending(),
      initLogUpdate: () => this.initLogUpdate(),
      onLogUpdateReady: (fn) => { this.logUpdate = fn; },
    });
  }

  /**
   * Push a chunk of markdown text. When `bufferMs > 0`, chunks are
   * micro-batched via a leading+trailing timer before reaching the parse
   * pipeline. When `bufferMs === 0` (default), this is a direct passthrough.
   */
  push(chunk: string): void {
    if (this.flushing) return;
    pushChunk(this.inputState, chunk, this.bufferMs, {
      onBatch: (batched) => this.pushDirect(batched),
    });
  }

  /**
   * Push a chunk directly into the parse pipeline (block detection + repaint).
   */
  private pushDirect(chunk: string, noHold = false, at = Date.now()): void {
    if (this.flushing) return;
    if (this.holds.active) {
      this.holds.append(chunk, at);
      return;
    }
    const split = this.accent && !noHold ? splitAtHeadingBoundary(this.buffer, chunk, this.committed === '') : null;
    if (split) {
      this.feed(split.now, at);
      const wait = this.smoke?.smokeHoldRemaining() ?? 0;
      if (wait > 0) {
        this.holds.hold({ text: split.held, at }, wait, () => this.releaseHeld(false));
        return;
      }
      chunk = split.held;
    }
    this.feed(chunk, at);
  }

  /**
   * Reveal dwell left for the last letter of the completed block ending at
   * `boundary` in `buffer` (0 = commit it now). Its distance from the end is
   * the visible text after the boundary; raw markdown syntax there can only
   * make the estimate slightly early, never late.
   */
  private blockRevealRemaining(buffer: string, boundary: number): number {
    if (!this.smoke || this.flushing || !this.pendingRender(buffer).reveal) return 0;
    // Code and table blocks are never masked, so there is no fade to wait for.
    if (/^ {0,3}(`{3,}|~{3,}|\|)/.test(buffer.slice(0, boundary).trimStart())) return 0;
    return this.smoke.revealHoldRemaining(countVisible(buffer.slice(boundary)));
  }

  /**
   * The pending render and whether the reveal mask applies to it: prose only.
   * Code fences and table previews keep their dimmed live view (a table's
   * box-drawing would otherwise read as the "youngest" characters). A
   * height-truncated render is skipped too: it keeps only the first rows, so
   * its end is NOT the newest text, and the distance-from-end mask would
   * re-smoke settled on-screen text. Memoized by the pending cache, so the
   * hold check and the next paint share one format.
   */
  private pendingRender(buffer = this.buffer): { pending: ReturnType<PendingFormatCache['render']>; contentWidth: number; reveal: boolean } {
    const { inCode } = this.pendingCache.blockState(buffer);
    const contentWidth = inCode
      ? calculateContentWidth(this.indent.length)
      : calculateProseContentWidth(this.indent.length);
    const pending = this.pendingCache.render(buffer, contentWidth, this.isTTY && !this.flushing);
    const reveal = pending.formatted !== '' && !inCode && !pending.inTable && pending.rows < pending.rowCap;
    return { pending, contentWidth, reveal };
  }

  /** Wait, bounded, for held text and deferred commits to drain and the tail to finish revealing. */
  private async settleReveal(): Promise<void> {
    const deadline = Date.now() + REVEAL_SETTLE_MAX_MS;
    while (this.smoke && !this.flushing) {
      const busy = this.holds.active || this.defer.pending;
      if (!busy && !this.pendingRender().reveal) return;
      const r = busy ? HOLD_RECHECK_MS : this.smoke.revealHoldRemaining();
      const left = deadline - Date.now();
      if (r <= 0 || left <= 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(r, left, HOLD_RECHECK_MS)));
    }
  }

  /** Discard held text without committing it (discardPending / dispose). */
  private dropHeld(): void {
    this.holds.clear();
  }

  /** Release held text in order. `force` also bypasses any further hold (sync drains). */
  private releaseHeld(force: boolean): void {
    // A non-forced release may re-hold at the next boundary; later pieces then
    // queue behind it (pushDirect appends while a hold is active).
    for (const p of this.holds.take()) this.pushDirect(p.text, force, p.at);
  }

  /** Record `chunk` for the reveal and run it through block detection + repaint. */
  private feed(chunk: string, at = Date.now()): void {
    if (!chunk) return;
    // Time spent in a hold becomes extra reveal budget, so released text animates.
    const heldMs = Date.now() - at;
    this.smoke?.record(chunk, heldMs > 0 ? { extraBudgetMs: heldMs } : {});
    this.runPipeline(chunk);
  }

  /** Commit every completed block now, in order, ignoring deferral (synchronous drains). */
  private commitDeferred(): void {
    this.defer.cancel();
    this.defer.forced = true;
    try { this.runPipeline(''); } finally { this.defer.forced = false; }
  }

  /** Append `chunk` (may be '') and commit every completed block the defer gate allows. */
  private runPipeline(chunk: string): void {
    if (this.flushing) return;
    this.atomically(() => this.runPipelineNow(chunk));
  }

  /**
   * Invariant (one pipeline pass, one visible state): a pass that completes a
   * block repaints the overlay WITHOUT that block (onPreCommit) and then
   * commits it above. Written separately, the terminal shows the block vanish
   * for a frame and reappear several rows higher: the "paragraph jump".
   * Running the whole pass inside one write transaction delivers only the
   * final state, in one DEC 2026 synchronized write. Every pass (new chunk,
   * forced drain, deferred-commit recheck timer) goes through runPipeline, and
   * everything in here is synchronous, so the transaction cannot capture
   * writes from unrelated work.
   */
  private atomically(fn: () => void): void {
    const stream = this.compositor?.stdout as TxStream | undefined;
    if (!stream) return fn();
    const tx = CommitWriteTx.begin(stream);
    try { fn(); } finally { tx.end(); }
  }

  private runPipelineNow(chunk: string): void {
    this.buffer = runParsePipeline(this.buffer, chunk, {
      deferCommit: (buffer, boundary) => this.defer.shouldDefer(this.blockRevealRemaining(buffer, boundary)),
      onPreCommit: (newBuffer) => {
        this.defer.committed();
        this.buffer = newBuffer;
        // Text is leaving the overlay's front: drop the smoke growth baseline
        // BEFORE the sync repaints, or the shrink reads as consumed syntax.
        this.smoke?.noteCommit();
        this.syncPendingOverlay();
      },
      onCommitBlock: (blockText) => this.commitBlock(blockText),
      onScheduleRepaint: () => this.scheduleRepaint(),
    });
  }

  /**
   * Mark the stream as cleanly finished (the orchestrator's `done`). From here
   * `getPendingBuffer()` / `stripPendingFrom()` inspect held text without
   * releasing it, and `flush()` first lets the tail finish revealing (bounded
   * by `REVEAL_SETTLE_MAX_MS`). Interrupted and errored turns never call this,
   * so they flush at once.
   */
  noteStreamDone(): void {
    this.streamDone = true;
  }

  /**
   * Finalize the stream: render and commit any remaining content,
   * and clear the log-update overlay
   */
  async flush(): Promise<void> {
    // Drain any micro-buffered input before finalizing.
    drainInputBuffer(this.inputState, { onBatch: (b) => this.pushDirect(b) });
    if (this.streamDone) await this.settleReveal();
    this.releaseHeld(true);
    this.commitDeferred();

    // Cancel throttle timer
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    // Mark flushing so any in-flight repaint() bails out before painting,
    // and no further repaints are scheduled.
    this.flushing = true;
    this.smoke?.dispose();

    // Composer mode: clear the markdown slot and flush so the overlay
    // re-renders without the pending block. This happens BEFORE committing
    // the tail buffer so the final commitBlock → commitAbove → repaint cycle
    // doesn't re-render stale pending text between the just-committed scrollback
    // line and the input row.
    clearOverlay(this.overlayComposer, this.compositor, null);

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
    return this.inputState.inputBuffer.length > 0 || this.holds.active || this.buffer.length > 0 || this.committed.length > 0;
  }

  /**
   * Get the raw pending buffer (for testing)
   */
  getPendingBuffer(): string {
    // Drain the micro-buffer first so the returned string reflects all
    // pushed content — mirrors the pattern in commitPending() and flush().
    drainInputBuffer(this.inputState, { onBatch: (b) => this.pushDirect(b) });
    // After a clean end, peek: releasing would commit a still-revealing paragraph.
    if (this.streamDone) return this.buffer + this.holds.text;
    this.releaseHeld(true);
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
    this.atomically(() => this.commitPendingNow());
  }

  private commitPendingNow(): void {
    drainInputBuffer(this.inputState, { onBatch: (b) => this.pushDirect(b) });
    this.releaseHeld(true);
    this.commitDeferred();
    if (!this.buffer.trim()) return;
    const pending = this.buffer;
    // Empty the buffer and re-compose the overlay (now empty) BEFORE committing,
    // so commitAbove() does not fire while the overlay still shows this block.
    // See syncPendingOverlay() / push() for the rationale (prevTopRow==1 drop).
    this.buffer = '';
    this.smoke?.noteCommit();
    this.syncPendingOverlay();
    this.commitBlock(pending);
  }

  /**
   * Strip a suffix from the pending buffer, starting at `offset`.
   * Content from `buffer[offset]` onward is dropped without committing.
   * Leading/trailing whitespace around the truncation point is trimmed
   * so no orphan blank lines remain.
   *
   * Returns `true` if anything was stripped, `false` otherwise.
   *
   * Used to remove the terminal-state prose block (Done/Blocked/…) from
   * the pending buffer before flush commits it to scrollback — so the
   * verdict card is the sole visible rendering.
   *
   * Contract: this ONLY operates on the pending buffer. Content already
   * committed to scrollback (past a `\n\n` boundary during streaming) is
   * unreachable — the terminal-state block is expected to be the last
   * block in the response, with no trailing `\n\n`, so it stays pending.
   */
  stripPendingFrom(offset: number): boolean {
    // Drain the micro-buffer first so the strip sees the full pending
    // content — mirrors the pattern in commitPending() and flush().
    drainInputBuffer(this.inputState, { onBatch: (b) => this.pushDirect(b) });
    if (this.streamDone) {
      // Offsets index `buffer + held` (see getPendingBuffer). Held text was never
      // recorded, so stripping it needs no reveal reset.
      if (offset >= this.buffer.length) return this.holds.stripFrom(offset - this.buffer.length);
      this.holds.clear(); // held text lies after the stripped heading
    } else this.releaseHeld(true);
    if (offset < 0 || offset >= this.buffer.length) return false;
    const stripped = this.buffer.slice(offset);
    this.buffer = this.buffer.slice(0, offset).trimEnd();
    // Forget only the stripped tail: the kept text (possibly a deferred block
    // still fading in) keeps its reveal, and nothing remaps onto it.
    this.smoke?.forgetNewest(countVisible(stripped));
    return true;
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
    discardInputBuffer(this.inputState);
    // Completed blocks would already be in scrollback without deferral: keep
    // that (append-only) contract and discard only the in-progress tail. Runs
    // BEFORE the throttle reset below, since the drain schedules a repaint.
    this.dropHeld();
    this.commitDeferred();
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.lastPaintTime = 0;
    this.buffer = '';
    this.smoke?.reset();
    // Clear the live overlay in whichever mode is active — mirror the slot
    // clears in commitPending()/flush() so the discarded text vanishes from
    // the screen, not just from the buffer.
    clearOverlay(this.overlayComposer, this.compositor, this.isTTY ? this.logUpdate : null);
  }

  /**
   * Clean up resources: clear timers and release log-update state
   */
  dispose(): void {
    discardInputBuffer(this.inputState);
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.lastPaintTime = 0;
    this.dropHeld();
    this.defer.reset();
    this.smoke?.dispose();

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

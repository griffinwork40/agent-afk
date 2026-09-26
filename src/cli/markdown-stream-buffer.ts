/**
 * Stream coordination helpers for StreamingMarkdownRenderer.
 *
 * Extracted to keep `markdown-stream.ts` under the 350-line code ceiling.
 *
 * This module owns two concerns:
 *
 * 1. **Input micro-buffer** — chunks arriving in `push()` are accumulated and
 *    flushed in a leading+trailing timer pattern (when `bufferMs > 0`) to
 *    reduce per-token `Lexer.lex()` / `findBlockBoundary()` overhead.
 *
 * 2. **Block-parse pipeline** — the `runParsePipeline()` function appends a
 *    chunk to the active buffer, repeatedly extracts completed blocks via
 *    `findBlockBoundary`, holds tables pending until their continuation is
 *    known, and invokes caller-supplied callbacks for each committed block and
 *    for the trailing repaint schedule.
 *
 * Neither function closes over class state: all mutable values are passed as
 * plain arguments or via a lightweight `InputBufferState` record so these
 * helpers remain pure and testable in isolation.
 */

import { Lexer } from 'marked';
import { findBlockBoundary } from './markdown-stream-format.js';

// ---------------------------------------------------------------------------
// 1. Input micro-buffer
// ---------------------------------------------------------------------------

/** Mutable state record for the leading+trailing input micro-buffer. */
export interface InputBufferState {
  inputBuffer: string;
  inputBufferTimer: NodeJS.Timeout | null;
  lastInputFlushTime: number;
}

/** Return a freshly initialised {@link InputBufferState}. */
export function createInputBufferState(): InputBufferState {
  return { inputBuffer: '', inputBufferTimer: null, lastInputFlushTime: 0 };
}

/**
 * Callbacks supplied by the owner to `pushChunk` and `drainInputBuffer`.
 * Kept as a plain interface so the helpers do not import the renderer class.
 */
export interface PipelineCallbacks {
  /** Deliver a batched string to the block-parse pipeline. */
  onBatch(batched: string): void;
}

/**
 * Accept a new chunk from `StreamingMarkdownRenderer.push()`.
 *
 * When `bufferMs <= 0` the chunk is forwarded to `callbacks.onBatch`
 * immediately (direct passthrough). Otherwise the leading+trailing pattern
 * applies: the first chunk after an idle interval fires at once; subsequent
 * chunks within the same window are coalesced and delivered on a trailing
 * timer.
 *
 * Mutates `state` in-place (timer handles, accumulated string).
 */
export function pushChunk(
  state: InputBufferState,
  chunk: string,
  bufferMs: number,
  callbacks: PipelineCallbacks,
): void {
  if (bufferMs <= 0) {
    callbacks.onBatch(chunk);
    return;
  }
  state.inputBuffer += chunk;
  const now = Date.now();
  // Leading edge: enough time since last flush — fire immediately.
  if (now - state.lastInputFlushTime >= bufferMs) {
    drainInputBuffer(state, callbacks);
    return;
  }
  // Trailing edge: inside the window — schedule one deferred flush.
  if (state.inputBufferTimer) clearTimeout(state.inputBufferTimer);
  const remaining = bufferMs - (now - state.lastInputFlushTime);
  state.inputBufferTimer = setTimeout(() => drainInputBuffer(state, callbacks), remaining);
  state.inputBufferTimer.unref();
}

/**
 * Flush accumulated input to the parse pipeline and reset the timer.
 * No-op when the buffer is empty.
 */
export function drainInputBuffer(
  state: InputBufferState,
  callbacks: PipelineCallbacks,
): void {
  if (state.inputBufferTimer) {
    clearTimeout(state.inputBufferTimer);
    state.inputBufferTimer = null;
  }
  if (!state.inputBuffer) return;
  const batched = state.inputBuffer;
  state.inputBuffer = '';
  state.lastInputFlushTime = Date.now();
  callbacks.onBatch(batched);
}

/**
 * Drop accumulated input without forwarding it to the parse pipeline.
 * Used on mid-stream retry (the partial text will be re-streamed).
 */
export function discardInputBuffer(state: InputBufferState): void {
  if (state.inputBufferTimer) {
    clearTimeout(state.inputBufferTimer);
    state.inputBufferTimer = null;
  }
  state.inputBuffer = '';
}

// ---------------------------------------------------------------------------
// 2. Block-parse pipeline
// ---------------------------------------------------------------------------

/** Callbacks supplied by the owner to `runParsePipeline`. */
export interface ParsePipelineCallbacks {
  /**
   * Invoked for each completed block BEFORE `commitBlock` runs, so the
   * caller can slice the block off the buffer and re-compose the overlay
   * with the now-shorter content — see `syncPendingOverlay` rationale.
   */
  onPreCommit(newBuffer: string): void;
  /** Commit a completed block to scrollback. */
  onCommitBlock(blockText: string): void;
  /** Schedule a repaint of remaining pending content. */
  onScheduleRepaint(): void;
}

/**
 * Append `chunk` to `buffer`, extract all completed blocks, and return the
 * remaining (pending) buffer.
 *
 * Block-boundary detection rules:
 * - Double newline (`\n\n`) outside an open code fence.
 * - Closing code fence (bare ` ``` ` or `~~~` on its own line).
 * - Tables are held pending until their continuation is known so the full
 *   column-width pass can happen at commit time.
 *
 * Completed blocks are delivered via `callbacks.onPreCommit` +
 * `callbacks.onCommitBlock` in order. A trailing repaint is scheduled via
 * `callbacks.onScheduleRepaint`.
 *
 * Returns the updated buffer string (uncommitted remainder).
 */
export function runParsePipeline(
  buffer: string,
  chunk: string,
  callbacks: ParsePipelineCallbacks,
): string {
  buffer += chunk;

  let boundary = findBlockBoundary(buffer);

  while (boundary !== -1) {
    // A completed table may be followed by a repeated-header continuation.
    // Keep it pending until the next complete block reveals whether it is a
    // continuation; formatter.ts can then merge all compatible table tokens
    // before computing widths.
    while (boundary !== -1) {
      const complete = Lexer.lex(buffer.slice(0, boundary)).filter(
        (token) => token.type !== 'space',
      );
      if (complete.at(-1)?.type !== 'table') break;
      const nextBoundary = findBlockBoundary(buffer.slice(boundary));
      if (nextBoundary === -1) {
        boundary = -1;
        break;
      }
      boundary += nextBoundary;
    }
    if (boundary === -1) break;

    const blockText = buffer.slice(0, boundary);
    // Slice buffer BEFORE commitBlock so any synchronous repaint triggered
    // by compositor.commitAbove() sees only the remaining content.
    buffer = buffer.slice(boundary);
    // Re-compose the overlay from the now-sliced buffer BEFORE committing.
    callbacks.onPreCommit(buffer);
    callbacks.onCommitBlock(blockText);

    boundary = findBlockBoundary(buffer);
  }

  callbacks.onScheduleRepaint();
  return buffer;
}

// ---------------------------------------------------------------------------
// 3. Repaint execution helper
// ---------------------------------------------------------------------------

/**
 * Shape of the `log-update` function (or a compatible wrapper).
 * Exported so `markdown-stream.ts` can reference it without re-declaring it.
 */
export interface LogUpdateFunction {
  (str: string): void;
  clear: () => void;
}

/** Parameters for {@link executeRepaint}. */
export interface RepaintParams {
  flushing: boolean;
  overlayComposer: OverlayComposerLike | null | undefined;
  compositor: CompositorLike | null;
  logUpdate: LogUpdateFunction | null;
  /** Returns the formatted pending overlay string. */
  renderPending(): string;
  /** Lazily initialise log-update; resolves to the function or null. */
  initLogUpdate(): Promise<LogUpdateFunction | null>;
  /** Called after `initLogUpdate` resolves to store the result on the owner. */
  onLogUpdateReady(fn: LogUpdateFunction | null): void;
}

/**
 * Execute a single repaint of the pending markdown content.
 *
 * Routing priority (matches original `repaint()` behaviour):
 *  1. `overlayComposer` → mark dirty + flush (slot renderer calls renderPending).
 *  2. `compositor` → `setOverlay(renderPending())`.
 *  3. `logUpdate` (TTY fallback) → `logUpdate(indented)`, lazy-init on first call.
 *
 * A no-op when `flushing` is true or when `renderPending()` returns an empty string.
 */
export async function executeRepaint(p: RepaintParams): Promise<void> {
  if (p.flushing) return;
  const indented = p.renderPending();
  if (!indented) return;

  if (p.overlayComposer) {
    p.overlayComposer.markDirty('markdown-pending');
    p.overlayComposer.flush();
    return;
  }
  if (p.compositor) {
    p.compositor.setOverlay(indented);
    return;
  }

  // log-update path: lazy init
  let lu = p.logUpdate;
  if (!lu) {
    lu = await p.initLogUpdate();
    p.onLogUpdateReady(lu);
  }
  if (!lu || p.flushing) return;
  lu(indented);
}

// ---------------------------------------------------------------------------
// 4. Overlay management helpers
// ---------------------------------------------------------------------------

/**
 * Minimal interface for types that support `setOverlay`. Used by overlay
 * helpers so this module does not import TerminalCompositor directly.
 */
export interface CompositorLike {
  setOverlay(str: string): void;
}

/**
 * Minimal interface for types that support marking a slot dirty. Used by
 * overlay helpers so this module does not import OverlayComposer directly.
 */
export interface OverlayComposerLike {
  markDirty(slot: string): void;
  flush(): void;
}

/**
 * Clear the live overlay in whichever sink is active (overlayComposer,
 * compositor, or logUpdate). Used by `flush()`, `discardPending()`, and any
 * other path that wants to erase the pending markdown region from the screen.
 *
 * - `overlayComposer`: marks the 'markdown-pending' slot dirty and flushes.
 * - `compositor`: calls `setOverlay('')`.
 * - `logUpdate`: calls `.clear()`.
 * - None active: no-op.
 */
export function clearOverlay(
  overlayComposer: OverlayComposerLike | null | undefined,
  compositor: CompositorLike | null,
  logUpdate: { clear(): void } | null,
): void {
  if (overlayComposer) {
    overlayComposer.markDirty('markdown-pending');
    overlayComposer.flush();
  } else if (compositor) {
    compositor.setOverlay('');
  } else if (logUpdate) {
    logUpdate.clear();
  }
}

/**
 * Re-compose the live overlay with current pending content BEFORE a block
 * commits. Callers must update `this.buffer` (remove the committed block)
 * before calling so the overlay no longer shows that block.
 *
 * - `overlayComposer`: marks the slot dirty and flushes (slot renderer pulls
 *   the up-to-date pending string via `renderPending`).
 * - `compositor`: calls `setOverlay(renderPending())` directly.
 * - Neither: no-op (log-update path repaints lazily via scheduleRepaint).
 */
export function syncPendingOverlay(
  overlayComposer: OverlayComposerLike | null | undefined,
  compositor: CompositorLike | null,
  renderPending: () => string,
): void {
  if (overlayComposer) {
    overlayComposer.markDirty('markdown-pending');
    overlayComposer.flush();
  } else if (compositor) {
    compositor.setOverlay(renderPending());
  }
}

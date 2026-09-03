/**
 * StreamRenderer dispose() implementation — teardown and resource cleanup.
 *
 * Extracted from stream-renderer.ts to decompose the class into focused modules.
 * The free function `disposeRenderer` receives all mutable state through a
 * context bag (DisposeCtx) so no field of StreamRenderer is accessed directly.
 *
 * Contract: ALL six sequential phases and their ordering comments are preserved
 * verbatim. The ordering invariants are governed by append-only scrollback and
 * the CommitCoordinator drain-order contract.
 *
 * @module cli/_lib/stream-renderer-dispose
 */

import { debugLog } from '../../utils/debug.js';
import type { Writer } from '../slash/types.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { OverlayComposer } from './overlay-composer.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { CommitCoordinator } from './commit-coordinator.js';
import type { StreamingMarkdownRenderer } from '../markdown-stream.js';
import type { DedupingLineWriter } from './dedup-line-writer.js';
import { commitBlockAbove } from './commit-block.js';

/**
 * Context bag passed to disposeRenderer — contains all mutable state needed
 * by the dispose() method body. Aggregated by the StreamRenderer stub.
 *
 * Contract: all fields are live references to the renderer's actual state —
 * no copies. Mutations made inside disposeRenderer are visible to the renderer.
 * The renderer stub must set `disposed = true` BEFORE calling disposeRenderer.
 */
export interface DisposeCtx {
  /** Raw line writer (may be a deduping wrapper in capture-mode). */
  out: Writer;
  /** True on TTY surfaces; governs overlay vs. line-writer paths. */
  isTTY: boolean;
  /** True when this renderer constructed its own compositor; false when borrowed. */
  ownsCompositor: boolean;
  /**
   * Mutable ref: the live TerminalCompositor. disposeRenderer nulls this out
   * after teardown; the StreamRenderer stub reads the post-dispose null value.
   */
  compositorRef: { current: TerminalCompositor | null };
  /**
   * Mutable ref: the live OverlayComposer. disposeRenderer does NOT null this
   * (OverlayComposer has no dispose); just reads it for final flush.
   */
  overlayComposerRef: { current: OverlayComposer | null };
  /** Shared ToolLane — may have pending entries that need safety-net flushing. */
  toolLane: ToolLane;
  /**
   * Mutable ref holding the orchestrator StreamingMarkdownRenderer.
   * disposeRenderer nulls this out after flushing.
   */
  streamingMarkdownRef: { current: StreamingMarkdownRenderer | null };
  /** Per-subagent streaming markdown renderers — flushed and disposed here. */
  subagentMarkdown: Map<string, StreamingMarkdownRenderer>;
  /** Last progress event per task — cleared at dispose start. */
  lastProgressByTask: Map<string, ProgressEvent>;
  /** Single ordering authority for all scrollback writes during this turn. */
  coordinator: CommitCoordinator;
  /** Mutable ref: the resize unsubscriber. Set null after unsubscribing. */
  resizeUnsubRef: { current: (() => void) | null };
  /** Mutable ref: the pause tick interval handle. Set null after clearing. */
  pauseTickIntervalRef: { current: ReturnType<typeof setInterval> | null };
  /**
   * Mutable ref: the soft-stop flag. Cleared early in dispose so the final
   * overlay flush renders an empty progress-banner slot.
   */
  softStoppingRef: { current: boolean };
  /**
   * Mutable ref: the prior-onCancel captured at arm() time. Restored on
   * borrow-dispose; cleared after restore to prevent stale-handler re-use.
   */
  priorOnCancelRef: { current: (() => void) | undefined };
  /**
   * Mutable ref: the borrowed compositor reference (null when ownsCompositor).
   * Cleared in disposeRenderer after the borrow ends.
   */
  borrowedCompositorRef: { current: TerminalCompositor | null };
}

// Import ProgressEvent type for the lastProgressByTask map value.
import type { ProgressEvent } from '../../agent/types.js';

/**
 * Flush any pending state and tear down the renderer. Called by the
 * StreamRenderer.dispose() stub after setting `this.disposed = true`.
 *
 * Contract: ALL six sequential teardown phases are executed in order.
 * The ordered-operation invariants are documented inline per phase.
 *
 * Invariant/Phase-order (external constraint: CommitCoordinator drain contract):
 *   1. Drop resize subscription (prevent in-flight debounced fires on half-torn ctx).
 *   2. Clear progress map + soft-stop flag (ensure final overlay flush paints empty).
 *   3. CommitCoordinator.flushAll() — the single async drain at turn end.
 *   4. Orchestrator markdown dispose (after coordinator flushed it).
 *   5. Subagent markdown flush + dispose (not coordinator-managed, best-effort).
 *   6. ToolLane safety-net flush (catches entries registered after flushAll).
 *   7. Clear pause tick interval.
 *   8. Compositor teardown (owned: disarm; borrowed: reset spinner/overlay/mode).
 *   9. Capture-mode tail: flush deduping writer.
 */
export async function disposeRenderer(ctx: DisposeCtx): Promise<void> {
  // Phase 1: Drop the resize subscription FIRST so any in-flight debounced fire
  // doesn't land on a half-torn-down ctx — `setComposedOverlay` reads the
  // tool lane and compositor, both of which are about to be released.
  if (ctx.resizeUnsubRef.current) {
    ctx.resizeUnsubRef.current();
    ctx.resizeUnsubRef.current = null;
  }

  // Phase 2a: Defensive eviction of any live progress entry. finalizeOrchestrator
  // already clears this on the 'done' path; this covers turns that reach
  // dispose without a 'done' event (error aborts, interrupts) so the
  // overlay flushes below never repaint a stale progress banner.
  ctx.lastProgressByTask.clear();

  // Phase 2b: Reset the soft-stop flag too — without this, an ESC that landed just
  // before dispose() leaves `softStopping=true` past teardown. The
  // borrowed-compositor path below invalidates + flushes the overlay
  // composer to clear the live frame; with lastProgressByTask now empty but
  // getSoftStopping() still true, the 'progress-banner' slot's synthetic
  // fallback (stream-renderer-lifecycle.ts) recreates a `Turn / stopping…`
  // banner instead of contributing '' — painting a stale banner into the
  // idle prompt until the next unrelated repaint overwrites it. Clearing
  // here BEFORE that flush guarantees the slot renders empty.
  ctx.softStoppingRef.current = false;

  // Phase 3: CommitCoordinator.flushAll() is the single async owner at turn end.
  // It drains all scheduled commit batches in fixed anchor order:
  //   1. before-content (orchestrator tool-lane entries that precede prose)
  //   2. await streamingMarkdown.flush() — injected here as the markdown flush
  //   3. after-subagent:* (subagent result blocks, in registration order)
  //   4. after-content (thinking summaries, skill badges, panels)
  //
  // External constraint: this call MUST come before any cleanup that would
  // null streamingMarkdownRef.current or dispose the compositor — the
  // coordinator's step 2 and steps 3–4 need both alive.
  //
  // The markdown renderer is passed as a bound flush callback rather than
  // a stored reference so CommitCoordinator doesn't hold a direct dependency
  // on StreamingMarkdownRenderer.
  const markdownFlush = ctx.streamingMarkdownRef.current
    ? () => ctx.streamingMarkdownRef.current!.flush()
    : undefined;
  await ctx.coordinator.flushAll(markdownFlush);

  // Phase 4: Orchestrator markdown — dispose after coordinator has flushed it.
  if (ctx.streamingMarkdownRef.current) {
    ctx.streamingMarkdownRef.current.dispose();
    ctx.streamingMarkdownRef.current = null;
  }

  // Phase 5: Subagent markdown renderers — flush and dispose any still active.
  // These are NOT coordinator-managed (each subagent markdown stream has
  // its own lifecycle); best-effort flush for any stragglers.
  for (const renderer of ctx.subagentMarkdown.values()) {
    try { await renderer.flush(); } catch { /* best effort */ }
    renderer.dispose();
  }
  ctx.subagentMarkdown.clear();

  // Phase 6: ToolLane — flush any pending entries that weren't captured by the
  // coordinator (e.g. entries registered after flushAll ran, or in
  // non-coordinator paths). This is the safety net; in normal operation
  // the coordinator drains all tool-lane commits before this point.
  //
  // Invariant (TUI rhythm contract): the safety-net flush is an emitter
  // like any other, so it MUST own ONE trailing blank after its lines.
  // The post-dispose successor (verdict card, soft-stop notice, footer)
  // never emits a leading blank, so without this trailing the footer
  // would butt directly against the last tool result. Mirrors the
  // coordinator done-path at stream-renderer-orchestrator.ts:363-382.
  // See docs/tui-rhythm.md. History: use flushCompletedRoots() not the
  // nuclear flush() — mirrors PR #95 fix at orchestrator-emit.ts:264;
  // nuclear flush on dispose deletes in-flight subagent entries, causing
  // stale-capture + causal-order violations (blank-row gaps, missing Done).
  if (ctx.toolLane.hasPending()) {
    const lines = ctx.toolLane.flushCompletedRoots();
    if (ctx.isTTY && ctx.compositorRef.current) {
      if (lines.length > 0) {
        // Atomic block commit — the safety-net flush is ONE coherent block;
        // per-line commits desync band-hold under a tall overlay. See
        // commit-block.ts. Guard matches flushToolLaneToScrollback: only
        // commit + trailing blank when there are actual lines to emit —
        // prevents a phantom blank when hasPending() is true due to an
        // in-flight ancestor entry but flushCompletedRoots() returns [].
        commitBlockAbove(ctx.compositorRef.current, lines);
        ctx.compositorRef.current.commitAbove('');
      }
      if (ctx.overlayComposerRef.current) {
        // Repaint the overlay even when there were no completed roots: an
        // in-flight ancestor remains live and its overlay must survive dispose.
        // Unlike the guarded block above, this does not emit scrollback rows.
        ctx.overlayComposerRef.current.markDirty('tool-lane');
        ctx.overlayComposerRef.current.flush();
      } else {
        ctx.compositorRef.current.setOverlay(ctx.toolLane.getOverlay());
      }
    } else {
      if (lines.length > 0) {
        for (const line of lines) ctx.out.line(line);
        ctx.out.line('');
      }
    }
  }

  // Phase 7: Clear the pause tick interval.
  if (ctx.pauseTickIntervalRef.current) {
    clearInterval(ctx.pauseTickIntervalRef.current);
    ctx.pauseTickIntervalRef.current = null;
  }

  // Phase 8: Compositor teardown.
  if (ctx.compositorRef.current) {
    if (ctx.ownsCompositor) {
      // Stage 3 (#540 — single end-of-turn flush): commit the full retained band
      // to scrollback as one contiguous write BEFORE disarm() erases the live
      // frame via logUpdate.clear(). At this point geometry is stable (overlay
      // cleared in Phase 2b / Phase 6, all commits landed by Phase 3–6), so the
      // flush produces the cleanest possible scrollback snapshot. disarm()'s own
      // flushPendingCommittedBand becomes a no-op after this (band is empty).
      // Best-effort: a closed TTY makes endTurn() throw; disarm() handles cleanup.
      try { ctx.compositorRef.current.endTurn(); } catch { /* best effort */ }
      // Renderer-owned compositor — full teardown.
      try { ctx.compositorRef.current.disarm(); } catch { /* best effort */ }
    } else {
      // Borrowed compositor — leave it armed for the surface to keep
      // serving the idle input row. Reset the streaming-only state
      // (spinner + overlay) so the bottom region looks clean; flip
      // input mode back to 'idle' so the next Enter resolves the
      // surface's pending readLine.
      //
      // Ordered-operation invariant (sequence): clear overlay BEFORE
      // flipping mode. setInputMode('idle') can synchronously fire
      // onSubmit (when a buffer was queued mid-stream) which may
      // trigger the surface to commitAbove the user's submission
      // echo. That echo must commit above a CLEAN bottom region, not
      // above a stale spinner frame from the just-ended turn.
      //
      // Failure-isolation invariant (per-step try/catch): each call
      // gets its own try/catch. A single bundled try/catch lets a
      // throw in setSpinner silently skip setOverlay('') and
      // setInputMode('idle') — leaving the stale frame painted
      // (compositor stuck "on top") and the surface stuck in
      // 'streaming' mode. The throw is reachable in production:
      // logUpdate() can propagate EPIPE/EBADF when the TTY closes
      // mid-session (see terminal-compositor.ts:676). Per-step
      // isolation keeps the sequence above intact under partial
      // failure: setOverlay still runs even if setSpinner threw.
      try {
        ctx.compositorRef.current.setSpinner({ enabled: false });
      } catch (e) {
        debugLog('[stream-renderer] borrow-dispose setSpinner: ' + String(e));
      }
      try {
        if (ctx.overlayComposerRef.current) {
          ctx.overlayComposerRef.current.invalidate();
          ctx.overlayComposerRef.current.flush();
        } else {
          ctx.compositorRef.current.setOverlay('');
        }
      } catch (e) {
        debugLog('[stream-renderer] borrow-dispose setOverlay: ' + String(e));
      }
      // Stage 3 (#540 — single end-of-turn flush): flush the full retained band
      // to scrollback now that geometry is stable (spinner off, overlay cleared).
      // Mirrors the ownsCompositor path above. Must run BEFORE setInputMode so
      // the archive write precedes any synchronous onSubmit that commitAbove may
      // fire when the input mode flips to 'idle'.
      try { ctx.compositorRef.current.endTurn(); } catch (e) {
        debugLog('[stream-renderer] borrow-dispose endTurn: ' + String(e));
      }
      try {
        ctx.compositorRef.current.setInputMode('idle');
      } catch (e) {
        debugLog('[stream-renderer] borrow-dispose setInputMode: ' + String(e));
      }
      // Restore the compositor's cancel handler to whatever the owner had
      // installed before arm() swapped in this.onCancel. The owner
      // (InputSurface.armCompositor) installs its sigintHandler via the
      // TerminalCompositor constructor — there is no other path to recover
      // it. Setting null here would leave onCancel === undefined, and
      // idle-mode Ctrl+C silently no-ops in that state
      // (terminal-compositor.ts:1106-1108).
      //
      // Passing `this.priorOnCancel ?? null` is type-safe: setOnCancel(null)
      // maps to `this.onCancel = undefined` internally, which is the
      // correct between-turns state ONLY when the owner never installed a
      // handler in the first place (priorOnCancel was undefined at capture).
      try {
        ctx.compositorRef.current.setOnCancel(ctx.priorOnCancelRef.current ?? null);
      } catch (e) {
        debugLog('[stream-renderer] borrow-dispose setOnCancel: ' + String(e));
      }
      // Clear our captured reference so a re-dispose (defensive idempotent
      // call) doesn't try to restore a stale handler.
      ctx.priorOnCancelRef.current = undefined;
    }
    ctx.compositorRef.current = null;
    ctx.borrowedCompositorRef.current = null;
  }

  // Phase 9: Capture-mode tail: if `this.out` is a deduping wrapper, finalize any
  // suppressed trailing run so the artifact ends with an honest summary.
  // Idempotent + safe when `this.out` is the bare opts.out (i.e. when
  // capture-mode was off and no wrapping happened).
  //
  // External constraint (pattern card: ordered-sequences): this MUST run
  // AFTER all upstream writes are drained (the compositor.disarm above is
  // the last writer in the teardown chain). Otherwise a late line written
  // post-flush would have no summary line preceding it.
  const maybeDedup = ctx.out as Partial<DedupingLineWriter>;
  if (typeof maybeDedup.flush === 'function') {
    try { maybeDedup.flush(); } catch { /* best effort */ }
  }
}

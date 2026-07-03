/**
 * Emit and finalization helpers for orchestrator event handling.
 * Exports panel emission, finalization, markdown rendering, and tool-lane flushing.
 *
 * @module cli/_lib/stream-renderer-orchestrator-emit
 */

import type { SourceState } from './stream-renderer-source.js';
import type { Writer } from '../slash/types.js';
import type { CardSpec } from '../render.js';
import { card, errorBox } from '../render.js';
import { renderMarkdownToTerminal } from '../formatter.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { formatThoughtSummary } from '../commands/interactive/thinking-lane.js';
import { commitBlockAbove } from './commit-block.js';

import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';

/**
 * Render a skill-emitted panel (`emitCard()` payload) above any pending
 * markdown / tool-lane state. Commits in-flight content first so the card
 * appears in causal order rather than sliding in after later content.
 *
 * - TTY: `streamingMarkdown.commitPending()` flushes the live overlay buffer.
 * - Non-TTY: any accumulated `source.contentBuffer` is emitted directly,
 *   then cleared so subsequent content events accumulate fresh.
 */
export function emitPanel(
  spec: CardSpec,
  source: SourceState,
  ctx: OrchestratorCtx,
): void {
  if (ctx.streamingMarkdown.current) {
    ctx.streamingMarkdown.current.commitPending();
  } else if (source.contentBuffer.trim()) {
    emitMarkdown(source.contentBuffer, ctx.out);
    source.contentBuffer = '';
  }
  flushToolLaneToScrollback(ctx);

  const rendered = card(spec);
  const lines = rendered.split('\n');
  if (ctx.isTTY && ctx.compositor) {
    // Atomic block commit — a card is ONE coherent artifact; per-line commits
    // desync band-hold under a tall overlay. See commit-block.ts.
    commitBlockAbove(ctx.compositor, lines);
  } else {
    for (const line of lines) ctx.out.line(line);
  }
}

/**
 * Seal the current thinking phase and return its formatted `◆ thought for Xs ·
 * N tok` summary line, or `null` when no phase is pending or it produced only
 * whitespace.
 *
 * Single source of truth for the drain + timer-clear + duration + format step
 * shared by the two TTY callers — {@link commitThinkingPhase} (immediate commit
 * at a think→act boundary) and {@link finalizeOrchestrator}'s trailing-phase
 * block (deferred schedule). Both MUST agree on the whitespace guard, timer
 * lifecycle, and duration math, so it lives here exactly once; the callers only
 * decide WHEN the returned line is committed.
 *
 * Side effects (always, before returning): captures the phase duration NOW
 * (`Date.now() - start`), clears the per-phase timer, and advances the lane
 * commit pointer (which empties the live overlay preview). Capturing the
 * duration here — not at commit time — lets the finalize path schedule a
 * deferred commit without the elapsed time drifting to flush time.
 */
function sealThinkingPhase(source: SourceState, ctx: OrchestratorCtx): string | null {
  const start = source.thinkingPhaseStartedAt;
  if (start == null) return null;
  source.thinkingPhaseStartedAt = undefined;
  const phase = ctx.thinkingLane.drainPhase();
  if (!phase.trim()) return null;
  return formatThoughtSummary(Date.now() - start, phase.length);
}

/**
 * Commit the just-ended thinking phase as an inline `◆ thought for Xs · N tok`
 * line in scrollback — the TTY interleaved-thinking render. Called at each
 * thinking→acting boundary (tool dispatch, prose start) and at finalize for a
 * trailing phase.
 *
 * Ordered-operation invariant: callers invoke this AFTER
 * {@link flushToolLaneToScrollback} so the summary lands directly above the
 * tool/prose it preceded and below the prior tool. Single line, no surrounding
 * blanks — it hugs the tool it produced; the predecessor block owns the
 * separating blank (TUI rhythm contract, see docs/tui-rhythm.md).
 *
 * Idempotent / safe: no-op when no phase is in progress (so repeated calls
 * across a prose stream do nothing after the first) or when the phase produced
 * only whitespace. The drain + timer-clear + format is delegated to
 * {@link sealThinkingPhase} (shared with the finalize trailing-phase path).
 */
export function commitThinkingPhase(source: SourceState, ctx: OrchestratorCtx): void {
  const line = sealThinkingPhase(source, ctx);
  if (line == null) return;
  if (ctx.isTTY && ctx.compositor) {
    ctx.compositor.commitAbove(line);
  } else {
    ctx.out.line(line);
  }
}

/**
 * Finalize the orchestrator turn: schedule tool-lane commits and thinking
 * summary via the CommitCoordinator (when present), or emit directly as a
 * backward-compatible fallback. Subagent Agent entries (and their children)
 * are NOT flushed here — the lane flush uses {@link ToolLane.flushCompletedRoots}
 * (selective), so in-flight roots live in the ToolLane until their own
 * subagents emit `done`, or until the renderer disposes.
 *
 * **Synchronous** — no I/O, no awaits. When `ctx.coordinator` is present
 * (production path), all I/O is deferred to `CommitCoordinator.flushAll()`
 * called at turn end from `StreamRenderer.dispose()`. The markdown flush is
 * injected as a parameter to `flushAll()` rather than called here, so the
 * drain order is:
 *   before-content (tool-lane) → streamingMarkdown.flush → after-subagent →
 *   after-content (thinking summary)
 *
 * External constraint: drain order is governed by `CommitCoordinator.flushAll()`.
 * Do not reorder without updating commit-coordinator.test.ts.
 *
 * When `ctx.coordinator` is absent (tests, legacy callers), falls back to
 * legacy direct-emit behavior for backward compatibility.
 */
export function finalizeOrchestrator(
  source: SourceState,
  ctx: OrchestratorCtx,
): void {
  // Evict the live progress entry: the tool-use loop is over, so its banner
  // must stop rendering. Without this the entry persists (the only other
  // mutation site is the 'progress' case's clear()+set()) and — because the
  // OverlayComposer redraws EVERY slot on ANY markDirty — the stale banner
  // provably repaints on every post-loop prose chunk, presenting a frozen
  // "current activity" as live. Cleared BEFORE the overlay-refreshing
  // commits scheduled below so their flush() paints a banner-free frame.
  ctx.lastProgressByTask.clear();

  if (!ctx.streamingMarkdown.current && source.contentBuffer.trim()) {
    // Non-TTY path: no streaming renderer active. Emit accumulated content
    // directly. This path is unchanged — no coordinator needed here.
    emitMarkdown(source.contentBuffer, ctx.out);
  }
  source.contentBuffer = '';

  if (ctx.coordinator) {
    // ── Coordinator path (production): schedule deferred commits ──────────
    //
    // External constraint (vertical-order invariant for the turn block):
    //
    //   TTY (interleaved per-phase, committed live during the turn):
    //     ◆ thought for Xs    ← phase-1 reasoning, hugging the tool it produced
    //     <tool 1>
    //     ◆ thought for Ys    ← phase-2 reasoning
    //     <tool 2>
    //     <assistant markdown>
    //   non-TTY (merged, scheduled here):
    //     ◆ thought for Xs · N tok       ← cumulative thinking summary
    //     <tool-lane entries>
    //     <assistant markdown>
    //
    // TTY phases are committed inline during the turn by commitThinkingPhase;
    // here TTY only seals a TRAILING phase (thinking that ended the turn with
    // no subsequent prose), scheduled AFTER the tool-lane below so it lands
    // beneath the final tool. non-TTY keeps the single cumulative summary,
    // scheduled FIRST so it sits above the tool-lane (drain order == schedule
    // order within the `before-content` anchor). See the `vertical order`
    // block in stream-renderer.test.ts.

    if (!ctx.isTTY && ctx.thinkingMode !== 'off') {
      const thinkingSummary = ctx.thinkingLane.collapse();
      if (thinkingSummary) {
        const summary = thinkingSummary;
        const out = ctx.out;
        ctx.coordinator.schedule({
          anchor: 'before-content',
          commits: [() => { out.line(summary); }],
        });
      }
    }

    // Tool-lane flush → before-content anchor.
    // Snapshot the pending lines NOW (synchronously) so they're captured
    // at the right event-order position. The actual `commitAbove` calls
    // are deferred to flushAll() step 1.
    //
    // Invariant (TUI rhythm contract): emit tool lines + ONE trailing
    // blank. No leading blank — the predecessor block (markdown
    // paragraph, prior tool flush, pre-arm separator) already owns its
    // own trailing blank, so a leading here would double-up. See
    // docs/tui-rhythm.md for the full contract.
    //
    // History: this used the NUCLEAR ToolLane.flush(), which deleted
    // in-flight subagent roots at every orchestrator message_stop. A
    // subagent still running at that boundary was captured with a STALE
    // tool count, removed from the lane, and orphaned — its done-path
    // hasEntry() check (stream-renderer.ts:604) then failed, so the
    // final block (correct counts + Done line) was never scheduled and
    // the stale capture committed at dispose-time flushAll, out of
    // causal order, with a multi-row blank gap in scrollback. Fixed by
    // flushCompletedRoots(), honoring this function's contract that
    // subagent entries are NOT flushed here. Pinned by
    // subagent-block-gap.repro.test.ts.
    if (ctx.toolLane.hasPending()) {
      const lines = ctx.toolLane.flushCompletedRoots();
      if (lines.length > 0) {
        // Capture ctx references used in the closure — avoids closing over the
        // mutable ctx object (defense against future mutations before flushAll).
        const compositor = ctx.compositor;
        const overlayComposer = ctx.overlayComposer;
        const toolLane = ctx.toolLane;
        const isTTY = ctx.isTTY;
        const out = ctx.out;
        ctx.coordinator.schedule({
          anchor: 'before-content',
          commits: [() => {
            if (isTTY && compositor) {
              // Atomic block commit — the flushed root is ONE coherent block;
              // per-line commits desync band-hold under a tall overlay (a live
              // subagent's rows). See commit-block.ts.
              commitBlockAbove(compositor, lines);
              compositor.commitAbove('');
              // Refresh the overlay from CURRENT lane state — in-flight
              // subagent rows that survived the selective flush must keep
              // rendering. Clearing to '' here (the pre-fix behavior) would
              // erase a still-running subagent's live rows.
              if (overlayComposer) {
                overlayComposer.markDirty('tool-lane');
                overlayComposer.flush();
              } else {
                compositor.setOverlay(toolLane.getOverlay());
              }
            } else {
              for (const line of lines) out.line(line);
              out.line('');
            }
          }],
        });
      }
    }

    // TTY trailing thinking phase (thinking that ended the turn with no
    // subsequent prose). Sealed synchronously NOW via the shared
    // {@link sealThinkingPhase} (drainPhase + duration) so it freezes at the
    // right event-order position; the returned line is scheduled to
    // `before-content` AFTER the tool-lane above so it commits beneath the final
    // tool. sealThinkingPhase returns null (→ no schedule) when no phase is
    // pending or it produced only whitespace.
    if (ctx.isTTY && ctx.thinkingMode !== 'off') {
      const line = sealThinkingPhase(source, ctx);
      if (line != null) {
        // Capture ctx refs used in the closure — avoids closing over the
        // mutable ctx object (mirrors the tool-lane closure above).
        const compositor = ctx.compositor;
        const out = ctx.out;
        const isTTY = ctx.isTTY;
        ctx.coordinator.schedule({
          anchor: 'before-content',
          commits: [() => {
            if (isTTY && compositor) compositor.commitAbove(line);
            else out.line(line);
          }],
        });
      }
    }
  } else {
    // ── Fallback path (tests / legacy callers without coordinator) ─────────
    //
    // Direct flush — same behavior as the previous async implementation,
    // minus the `await streamingMarkdown.flush()` (which is not possible
    // synchronously). Markdown flush is handled by StreamRenderer.dispose()
    // or by the test's own await of the markdown renderer.
    //
    // Order mirrors the coordinator path. non-TTY: cumulative collapse summary
    // FIRST (above the tool-lane). TTY: phases are committed inline during the
    // turn by commitThinkingPhase; seal a trailing phase AFTER the tool-lane
    // flush so it lands beneath the final tool.
    if (!ctx.isTTY && ctx.thinkingMode !== 'off') {
      const thinkingSummary = ctx.thinkingLane.collapse();
      if (thinkingSummary) ctx.out.line(thinkingSummary);
    }

    flushToolLaneToScrollback(ctx);

    if (ctx.isTTY && ctx.thinkingMode !== 'off') {
      commitThinkingPhase(source, ctx);
    }
  }
}

/**
 * Render markdown and emit through the line-based writer. Used by non-TTY
 * paths and as the fallback when a `message` event arrives without prior
 * content streaming.
 */
export function emitMarkdown(text: string, out: Writer): void {
  // History: this fallback rendered with renderMarkdownToTerminal(text) and NO
  // maxWidth, so the table formatter used +Infinity — rows emitted at their
  // natural width overflowed past the right edge on any terminal narrower than
  // the table, and never reflowed on resize (the lines are already committed to
  // scrollback). The streaming commit path was always width-capped; this aligns
  // the fallback with it. On a TTY, cap to the visible content width (matching
  // calculateContentWidth = terminal − 2) so tables are squeezed/truncated and
  // prose is wrapped, breaking over-long tokens (URLs, long identifiers) that a
  // raw-line sink would otherwise let run off the edge. Off a TTY (piped /
  // redirected) keep the width unbounded so consumers receive full-width
  // markdown — the prior behavior.
  const contentWidth = process.stdout.isTTY
    ? Math.max(1, getTerminalWidth() - 2)
    : Number.POSITIVE_INFINITY;
  const rendered = renderMarkdownToTerminal(text, { maxWidth: contentWidth });
  const wrapped = wrapToWidth(rendered, contentWidth, { breakLongWords: true });
  for (const line of wrapped.split('\n')) {
    out.line(line);
  }
}

/**
 * Emit an error box. Splits the rendered box by newlines and emits each line.
 */
export function emitErrorBox(err: Error, out: Writer): void {
  const box = errorBox(err.message, err.stack);
  for (const line of box.split('\n')) {
    out.line(line);
  }
}

/**
 * Flush ToolLane to scrollback (or writer for non-TTY). Used between
 * orchestrator content blocks so root tool entries don't pile up in the
 * overlay across an entire turn.
 *
 * Uses {@link ToolLane.flushCompletedRoots} (NOT nuclear flush()) so that
 * in-flight subagent roots — and their live tool children — survive the
 * call. Without this distinction, a subagent dispatch interleaved with
 * orchestrator prose would have its overlay rows wiped mid-execution,
 * causing live spinner rows to disappear and (when no later event
 * re-rendered the overlay) the compositor to look stuck.
 *
 * Ordered-operation invariant: refresh the overlay LAST via
 * setOverlay(getOverlay()), AFTER scrollback commits. The overlay must
 * reflect the lane's post-flush state — surviving in-flight rows if any,
 * empty otherwise. Unconditionally clearing to '' (the previous behavior)
 * silently erased surviving live rows even when the lane wasn't empty.
 */
export function flushToolLaneToScrollback(ctx: OrchestratorCtx): void {
  if (!ctx.toolLane.hasPending()) return;
  const lines = ctx.toolLane.flushCompletedRoots();
  // Invariant (TUI rhythm contract): emit tool lines + ONE trailing
  // blank. No leading blank — the predecessor block already owns its
  // own trailing. See docs/tui-rhythm.md.
  if (ctx.isTTY && ctx.compositor) {
    if (lines.length > 0) {
      // Atomic block commit — the flushed root(s) form ONE coherent block;
      // committing line-by-line desyncs the band-hold model under a tall
      // overlay and scrolls blank rows into scrollback (the "weird gaps"
      // bug). See commit-block.ts.
      commitBlockAbove(ctx.compositor, lines);
      ctx.compositor.commitAbove('');
    }
    // Refresh from current lane state. Empty when all roots were
    // completed and flushed; non-empty when in-flight subagent rows
    // remain (their spinners/children must continue rendering).
    if (ctx.overlayComposer) {
      ctx.overlayComposer.markDirty('tool-lane');
      ctx.overlayComposer.flush();
    } else {
      ctx.compositor.setOverlay(ctx.toolLane.getOverlay());
    }
  } else {
    if (lines.length > 0) {
      for (const line of lines) ctx.out.line(line);
      ctx.out.line('');
    }
  }
}

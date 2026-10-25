/**
 * Subagent event handling (sourceId !== '__main__') for StreamRenderer.
 * Exports the event handler and synthesis logic as free functions that operate
 * on a passed SubagentCtx object. Helper functions (emitSubagentPanel, finalizeSubagent,
 * extractLatestThinkingClause) are in stream-renderer-subagent-helpers.ts.
 *
 * @module cli/_lib/stream-renderer-subagent
 */

import type { OutputEvent } from '../../agent/types.js';
import type { SourceState } from './stream-renderer-source.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { Writer } from '../slash/types.js';
import type { CompletionWriter } from '../commands/interactive/shared.js';
import type { CardSpec } from '../render.js';
import { card } from '../render.js';
import { commitBlockAbove } from './commit-block.js';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import { syntheticResult, formatDoneSummary } from './stream-renderer-source.js';
import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';
import { setComposedOverlay } from './stream-renderer-orchestrator.js';
import {
  extractLatestThinkingClause,
  emitSubagentTextLines,
  synthesizeAgentEntry,
  handleSubagentChunk,
  _thinkingTailLastUpdate,
  _overlayLastUpdate,
} from './stream-renderer-subagent-helpers.js';

/**
 * Context object passed to subagent event handlers. Minimal set of collaborators
 * needed for subagent rendering: compositor for overlay updates, toolLane for
 * nesting under the synthetic agent, and output writer for scrollback lines.
 *
 * Design note (issue #389 — overlay routing): every overlay repaint in
 * subagent handlers routes through `setComposedOverlay(ctx.orchestratorCtx)`
 * instead of calling `compositor.setOverlay(toolLane.getOverlay())` directly.
 * This preserves the orchestrator's live-thinking paragraph, stage rail, and
 * progress banner in every frame — a direct tool-lane-only write would wipe
 * those layers for the duration of the repaint, causing visible flicker when
 * parallel subagents fire repaints at independent cadences.
 */
export interface SubagentCtx {
  isTTY: boolean;
  compositor: TerminalCompositor | null;
  toolLane: ToolLane;
  /** Where line-based output goes (non-TTY fallback + scrollback emits). */
  out: Writer;
  /**
   * Optional reference to the shared completion writer. When present,
   * `finalizeSubagent` records the subagent's source id in
   * `completionWriter.renderedSubagentIds` so the SubagentStop-hook
   * Channel B line is suppressed even after `suppressSubagentCompletion`
   * resets at turn teardown.
   */
  completionWriter?: CompletionWriter;
  /** Per-source streaming markdown renderers, keyed by subagent source ID. */
  streamingMarkdown: Map<string, StreamingMarkdownRenderer>;
  /**
   * Cascaded from the orchestrator's StreamRenderer setting:
   * - `'off'`     — drop thinking chunks entirely (legacy behavior)
   * - `'summary'` — buffer per-source; append a `· thought Xs · Ntok` stat
   *                 to the synthetic Agent's Done row on finalize
   * - `'live'`    — same as `'summary'`, plus trigger an overlay repaint on
   *                 every thinking chunk so the spinner / synthetic Agent
   *                 row stays visibly alive while the child reasons (mirrors
   *                 the orchestrator's `'live'` repaint cadence — no italic
   *                 streaming of thinking text, just liveness)
   *
   * Defaults to `'summary'` to match the orchestrator's default and avoid
   * silently dropping thinking events when the field is omitted by callers
   * (tests, future surfaces).
   */
  thinkingMode: 'off' | 'summary' | 'live' | 'digest';
  /**
   * Reference to the parent orchestrator's context. Used by subagent
   * handlers to compose the full overlay frame (stage rail + thinking
   * paragraph + tool lane + progress banner) instead of painting a bare
   * tool-lane-only frame. Required for issue #389: every
   * `compositor.setOverlay(toolLane.getOverlay())` in subagent code is
   * replaced with `setComposedOverlay(ctx.orchestratorCtx)` so the live
   * thinking paragraph is never wiped by a subagent state transition.
   *
   * Tests that don't exercise the TTY overlay path may omit this field —
   * the subagent handlers guard all `setComposedOverlay` calls with
   * `ctx.isTTY && ctx.orchestratorCtx` before invoking.
   */
  orchestratorCtx?: OrchestratorCtx;
}


/**
 * Handle one event for a subagent source.
 */
export function handleSubagentEvent(
  event: OutputEvent,
  sourceId: string,
  source: SourceState,
  ctx: SubagentCtx,
): void {
  const parentId = source.syntheticAgentToolUseId;
  if (!parentId) return; // shouldn't happen — synthesizeAgentEntry runs in process()

  switch (event.type) {
    case 'progress':
      if (event.progress.totalTokens) source.stats.tokens = event.progress.totalTokens;
      // Advisory store only — do NOT write source.stats.toolUses here.
      // source.stats.toolUses is increment-only; written only by tool_use_detail
      // handlers (stream-renderer-subagent.ts:~175 and stream-renderer-orchestrator.ts:~100).
      // The SDK's progress.toolUses counts iterations, not distinct tool_use_detail
      // events — different quantities that must not be conflated (Bug #4).
      if (event.progress.toolUses !== undefined) {
        source.stats.progressReportedToolUses = event.progress.toolUses;
      }
      // Retain the provider's per-round headline for the progress banner's
      // detail slot, then repaint ONCE.
      //
      // Invariant: the "at most one setComposedOverlay call per event" rule in
      // stream-renderer-orchestrator.ts is a CAP, not a prohibition, and this arm
      // previously made zero calls. The earlier reasoning — that the discrete
      // tool_use_detail / tool_result transitions "arrive at least as often as
      // progress events" — held for frequency but not for ORDER: both provider
      // loops emit a round's tool_result BEFORE its progress event, so the result
      // repaint renders the PREVIOUS headline and this one stays invisible for the
      // whole of the child's next model request. Unthrottled, matching the discrete
      // arms below rather than the 1500ms-gated streaming paths: progress fires
      // once per round, not at streaming frequency.
      if (event.progress.summary) source.lastProgressSummary = event.progress.summary;
      if (ctx.isTTY && ctx.orchestratorCtx) {
        setComposedOverlay(ctx.orchestratorCtx);
      }
      return;

    case 'chunk':
      handleSubagentChunk(event.chunk, sourceId, source, parentId, ctx);
      return;

    case 'message':
      return;

    case 'error':
      source.errored = true;
      // Clear the live thinking tail so the error result reads as the final
      // state under the Agent row — leaving a stale clause of mid-flight
      // prose alongside an error line is confusing. The structured error
      // message itself flows through `addResult` (separate channel from
      // prose), so we never need to dump the buffered content to surface it.
      ctx.toolLane.setThinkingTail(parentId, undefined);
      // Item #6: clean up the throttle entry here too — the error path
      // never reaches finalizeSubagent (which short-circuits on
      // `source.errored`), so without this delete the per-parentId
      // timestamp would leak for every errored subagent in a long
      // session. Same external constraint as the finalize path: delete
      // AFTER the setThinkingTail clear so cleanup wins last.
      _thinkingTailLastUpdate.delete(parentId);
      // H2 fix: clean up the overlay throttle entry on the error path too.
      _overlayLastUpdate.delete(parentId);
      settleSubagentError(ctx.toolLane, parentId, event.error.message);
      // Record this subagent as rendered on the error path too — mirrors the
      // done path in finalizeSubagent. Without this, emitSubagentCompletion
      // (Channel B) emits a duplicate completion line for every errored
      // subagent after teardownTurn resets suppressSubagentCompletion.
      if (ctx.completionWriter?.renderedSubagentIds && sourceId) {
        ctx.completionWriter.renderedSubagentIds.add(sourceId);
      }
      // Route through the full composed frame so the orchestrator's live-
      // thinking paragraph is preserved. (Issue #389.)
      if (ctx.isTTY && ctx.orchestratorCtx) {
        setComposedOverlay(ctx.orchestratorCtx);
      }
      return;

    case 'done':
      source.done = true;
      if (event.metadata) source.responseMetadata = event.metadata;
      finalizeSubagent(sourceId, source, ctx);
      return;

    case 'suggestion':
      return;

    case 'panel':
      emitSubagentPanel(event.spec as CardSpec, sourceId, source, ctx);
      return;

    case 'notice':
      // Display-only harness notice from inside a subagent (issue #970).
      // Subagent notices (truncation, refusal) are surfaced on non-TTY
      // surfaces via the Writer so logs/CI capture them. On TTY they are
      // a no-op here — the parent's tool lane already surfaces the Done
      // row with a summary, and adding an interleaved info line mid-flight
      // would break the single-lane invariant. A follow-up may wire these
      // into the thinking-tail slot for richer live visibility.
      if (!ctx.isTTY) {
        ctx.out.line(event.text);
      }
      return;

    case 'tool-activity':
      // Live tool-activity marker from inside a subagent (Phase 2, issue
      // #516). Deliberately dropped here. A child's activity feed describes
      // only that child's pool, so applying it to the shared ToolLane would
      // overwrite the parent's snapshot with a partial one — several children
      // running concurrently would each clobber the others and the badge would
      // report one child's width as if it were the whole lane's. Badging
      // subagent-scoped ids needs per-agent activity state; deferred to a
      // future sub-issue. Dropping is the truthful option: no badge beats a
      // wrong one.
      return;
  }
}

/**
 * Stamp a subagent's terminal error onto its Agent entry and bubble the
 * failure to every NESTING ancestor.
 *
 * Invariant: set BOTH `addResult` (the entry's own result) AND
 * `setAgentResultSummary` (the rendered Done/error line under the Agent
 * header). The done-path mirrors this in {@link finalizeSubagent}. Without
 * setAgentResultSummary, the Agent block renders WITHOUT a terminal summary
 * line: the user sees the in-flight tool children but no indication of how
 * the subagent ended. The scrollback commit on the renderer side ('error'
 * branch of StreamRenderer.process) reads agentResultSummary to render the
 * block's bottom row, so omitting it was the visible-error-vanishes
 * regression.
 *
 * Invariant: `propagateChildFailure` runs AFTER `addResult` so the failed
 * entry's result is stamped before the ancestor walk increments each
 * ancestor's `failedChildCount` (rendered as the overlay's `⚠ N` badge).
 */
function settleSubagentError(toolLane: ToolLane, parentId: string, message: string): void {
  const errorSummary = `error — ${message}`;
  toolLane.setAgentResultSummary(parentId, errorSummary);
  toolLane.addResult(parentId, syntheticResult(errorSummary, true));
  toolLane.propagateChildFailure(parentId);
}

/**
 * Render a panel emitted from inside a subagent. Flushes any pending
 * subagent content (markdown buffer) before rendering the card, mirroring
 * the orchestrator's emitPanel pattern so the card never races streamed
 * content on non-TTY surfaces.
 *
 * The synthetic Agent entry stays alive in the parent tool lane (we don't
 * flush it — that would drop attribution mid-flight). The card itself is
 * committed straight to scrollback as a loud visual marker; its color and
 * shape make the source obvious without extra indent chrome.
 */
export function emitSubagentPanel(
  spec: CardSpec,
  _sourceId: string,
  source: SourceState,
  ctx: SubagentCtx,
): void {
  // Drop buffered prose before rendering the card so the panel doesn't
  // visually interleave with streaming content.
  //
  // TTY: subagent prose was already routed to the transient thinking tail
  // (not scrollback) — clear that tail so the panel reads as the new state,
  // and discard the prose buffer silently. The card itself is the deliberate
  // visible artifact and is committed via the loop below.
  // Non-TTY: flush the buffer through the gutter-prefixed scrollback path so
  // logs retain the full prose context that preceded the card.
  if (ctx.isTTY) {
    const parentId = source.syntheticAgentToolUseId;
    if (parentId) ctx.toolLane.setThinkingTail(parentId, undefined);
    source.contentBuffer = '';
  } else if (source.contentBuffer.trim()) {
    emitSubagentTextLines(source.contentBuffer, ctx);
    source.contentBuffer = '';
  }

  const rendered = card(spec);
  const cardLines = rendered.split('\n');
  if (ctx.isTTY && ctx.compositor) {
    // Atomic block commit — the subagent panel card is ONE coherent artifact;
    // per-line commits desync band-hold under a tall overlay. See commit-block.ts.
    commitBlockAbove(ctx.compositor, cardLines);
  } else {
    for (const line of cardLines) ctx.out.line(line);
  }
  // Invariant (TUI rhythm contract): subagent panel card owns ONE
  // trailing blank line so the next block (more prose, the next tool,
  // or another subagent) has breathing room. Mirrors background-task
  // completion cards (repl-loop.ts:314). See docs/tui-rhythm.md.
  if (ctx.isTTY && ctx.compositor) {
    ctx.compositor.commitAbove('');
  } else {
    ctx.out.line('');
  }
}

/**
 * Finalize a subagent source: flush any remaining partial line buffer and emit
 * a summary result under its synthetic agent. No-op if the subagent errored
 * (error summary already set in the error case).
 */
export function finalizeSubagent(_sourceId: string, source: SourceState, ctx: SubagentCtx): void {
  const parentId = source.syntheticAgentToolUseId;
  if (!parentId || source.errored) return;

  // Drain any remaining buffered prose.
  //
  // TTY: subagent prose is suppressed from scrollback by design (the leak
  // fix). The buffer is discarded silently — the user already saw the live
  // tail under the Agent row while the subagent was running, and the Done
  // row below is the only artifact that lands in the parent transcript.
  //
  // Non-TTY: flush the trailing buffer through the gutter-prefixed
  // scrollback path so logs/CI keep the final line of prose even when the
  // subagent's last chunk lacked a trailing newline.
  if (!ctx.isTTY && source.contentBuffer) {
    emitSubagentTextLines(source.contentBuffer, ctx);
  }
  source.contentBuffer = '';

  // Non-TTY: emit a standalone thinking summary line before the Done row,
  // mirroring the orchestrator's pattern (stream-renderer-orchestrator.ts:236-250).
  // On TTY the live thinking tail already provides visibility; this is for
  // logs, CI, and headless surfaces where the tail is never rendered.
  //
  // Invariant (TUI rhythm contract): emit summary + ONE trailing blank.
  // Without the trailing blank, the next block (the Done row, committed
  // via addResult/syntheticResult below) butts directly against the
  // summary. See docs/tui-rhythm.md.
  if (!ctx.isTTY && source.thinkingLane?.hasBufferedContent()) {
    const thinkingSummary = source.thinkingLane.collapse();
    if (thinkingSummary) {
      ctx.out.line(thinkingSummary);
      ctx.out.line('');
    }
  }

  // Clear the live thinking tail before the Done row is committed —
  // `formatDoneSummary` reads `source.thinkingLane` to append the
  // "thought Xs · N tok" post-mortem stat, which makes the live tail
  // redundant and visually noisy alongside the result line.
  ctx.toolLane.setThinkingTail(parentId, undefined);
  // Item #6: Clean up the per-parentId throttle entry so the map doesn't
  // grow unboundedly across many short-lived subagents in a long session.
  // External constraint: delete AFTER setThinkingTail(undefined) so the
  // clear is never throttled by a stale timestamp from the same run.
  _thinkingTailLastUpdate.delete(parentId);
  // H2 fix: clean up the overlay throttle entry too.
  _overlayLastUpdate.delete(parentId);

  const summary = formatDoneSummary(source);
  ctx.toolLane.setAgentResultSummary(parentId, summary);
  ctx.toolLane.addResult(
    parentId,
    syntheticResult(summary, false),
  );
  // Record this subagent as rendered so emitSubagentCompletion (Channel B)
  // skips it even after teardownTurn resets suppressSubagentCompletion.
  if (ctx.completionWriter?.renderedSubagentIds && _sourceId) {
    ctx.completionWriter.renderedSubagentIds.add(_sourceId);
  }
  // Route through the full composed frame so the orchestrator's live-
  // thinking paragraph is preserved. (Issue #389.)
  if (ctx.isTTY && ctx.orchestratorCtx) {
    setComposedOverlay(ctx.orchestratorCtx);
  }
}

export { extractLatestThinkingClause, synthesizeAgentEntry };

/**
 * StreamRenderer process() implementation — per-event routing for OutputEvent
 * streams that may mix an orchestrator source with N concurrent subagent sources.
 *
 * Extracted from stream-renderer.ts to decompose the class into focused modules.
 * The free function `processEvent` receives all mutable state it needs through
 * a context bag (ProcessCtx) so no field of StreamRenderer is accessed directly.
 *
 * @module cli/_lib/stream-renderer-process
 */

import type { OutputEvent, SubagentProgressMeta, ProgressEvent } from '../../agent/types.js';
import type { Writer } from '../slash/types.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { OverlayComposer } from './overlay-composer.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import type { StreamingMarkdownRenderer } from '../markdown-stream.js';
import type { StageTrackerState } from '../commands/interactive/loop-stage.js';
import type { CommitCoordinator } from './commit-coordinator.js';
import type { ChildActivityTracker } from './child-activity-select.js';
import type { InFlightToolTracker } from '../input/work-derived-verb.js';
import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';
import type { LoopStage, StageSignals } from '../commands/interactive/loop-stage.js';
import type { SubagentStatusBarSpec } from '../render.js';
import { ORCHESTRATOR_SOURCE_KEY, type SourceState, freshSourceState } from './stream-renderer-source.js';
import { noteToolEvent } from '../input/work-derived-verb.js';
import { handleOrchestratorEvent, setComposedOverlay } from './stream-renderer-orchestrator.js';
import { handleSubagentEvent, synthesizeAgentEntry } from './stream-renderer-subagent.js';
import { commitBlockAbove } from './commit-block.js';
import { makeSubagentCtx, resolveParentSyntheticId } from './stream-renderer-contexts.js';

/**
 * Context bag passed to processEvent — contains all mutable state needed by
 * the process() method body. Aggregated by the StreamRenderer stub.
 *
 * Contract: every field is a live reference to the renderer's actual state —
 * no copies. Mutations made inside processEvent are visible to the renderer.
 */
export interface ProcessCtx {
  /** Raw line writer (may be a deduping wrapper in capture-mode). */
  out: Writer;
  /** True on TTY surfaces; governs overlay vs. line-writer paths. */
  isTTY: boolean;
  /** Live TerminalCompositor, null before arm() or after dispose(). */
  compositor: TerminalCompositor | null;
  /** Live OverlayComposer, null before arm() or after dispose(). */
  overlayComposer: OverlayComposer | null;
  /** Shared ToolLane for both orchestrator and subagent entries. */
  toolLane: ToolLane;
  /** Orchestrator-side ThinkingLane. */
  thinkingLane: ThinkingLane;
  /**
   * Mutable ref holding the orchestrator StreamingMarkdownRenderer.
   * Wrapped in a ref object so process() and dispose() can null it out.
   */
  streamingMarkdownRef: { current: StreamingMarkdownRenderer | null };
  /** Loop stage tracker for the current turn. */
  stageTracker: StageTrackerState;
  /** Single ordering authority for all scrollback writes during this turn. */
  coordinator: CommitCoordinator;
  /** Sticky child-activity selector for the progress banner detail slot. */
  childActivity: ChildActivityTracker;
  /** In-flight tool set backing the spinner's work-derived verb. */
  inFlightTools: InFlightToolTracker;
  /** Per-source rendering state map, keyed by sourceId. */
  sources: Map<string, SourceState>;
  /** Per-subagent streaming markdown renderers. */
  subagentMarkdown: Map<string, StreamingMarkdownRenderer>;
  /** Last progress event per task — emitted on stream end as a one-line summary. */
  lastProgressByTask: Map<string, ProgressEvent>;
  /** Resolved thinking mode (already downgraded if captureMode is active). */
  thinkingMode: 'off' | 'summary' | 'live' | 'digest';
  /** Active skill name for badge rendering. */
  activeSkillName: string | undefined;
  /**
   * Optional callback fired whenever the loop stage transitions.
   * Best-effort: errors are swallowed so a bar paint failure never breaks
   * the streaming event loop.
   */
  onStageChange: ((stage: LoopStage, signals?: StageSignals) => void) | undefined;
  /**
   * Factory: build a fresh OrchestratorCtx snapshot from the renderer's
   * live collaborators. Provided by StreamRenderer as a bound method so
   * processEvent never references the class directly.
   */
  buildOrchestratorCtx: () => OrchestratorCtx;
  /**
   * Live status bar specs for active subagent dispatches, keyed by subagentId.
   * Mutated here: entries are added on first subagent event, removed on terminal
   * (done/error) events. The 250ms ticker in arm() reads this to update elapsedMs.
   */
  activeSubagents: Map<string, SubagentStatusBarSpec>;
  /** Dispatch timestamps (Date.now()) for each active subagent, keyed by subagentId. */
  subagentStartedAt: Map<string, number>;
  /** Live OverlayComposer for triggering subagent-status slot dirty marks. */
  overlayComposerForStatus: OverlayComposer | null;
}

/**
 * Process one OutputEvent. `meta.subagentId` identifies the source; absent
 * meta is treated as the orchestrator source (`__main__`).
 *
 * Extracted from `StreamRenderer.process()`. The StreamRenderer stub reads
 * `this.disposed` and returns early before delegating to this function.
 */
export function processEvent(ctx: ProcessCtx, event: OutputEvent, meta?: SubagentProgressMeta): void {
  // Feed the spinner's work-derived verb. Done here — before delegation —
  // because `process` is the one choke point that sees tool events from BOTH
  // the orchestrator and every subagent, so neither handler needs its own
  // call site. Pure bookkeeping plus one setter; fires no repaint of its own.
  noteToolEvent(event, ctx.inFlightTools, ctx.compositor);
  const sourceId = meta?.subagentId ?? ORCHESTRATOR_SOURCE_KEY;
  const isOrchestrator = sourceId === ORCHESTRATOR_SOURCE_KEY;
  let source = ctx.sources.get(sourceId);

  if (!source) {
    source = freshSourceState(meta?.agentType);
    ctx.sources.set(sourceId, source);
    if (!isOrchestrator) {
      // Synthesize the `Agent(<label>)` parent on the very first event.
      // Resolve nesting in priority order when `meta.parentId` is present.
      // No deferred synthesis, no retroactive re-tagging.
      const parentSyntheticId = resolveParentSyntheticId({
        parentId: meta?.parentId,
        sources: ctx.sources,
        toolLane: ctx.toolLane,
        sourceId,
      });
      synthesizeAgentEntry(sourceId, source, makeSubagentCtx({
        isTTY: ctx.isTTY,
        compositor: ctx.compositor,
        toolLane: ctx.toolLane,
        out: ctx.out,
        streamingMarkdown: ctx.subagentMarkdown,
        thinkingMode: ctx.thinkingMode,
        orchestratorCtx: ctx.buildOrchestratorCtx(),
      }), parentSyntheticId);
      // Register a status bar entry for the new subagent source.
      const label = meta?.agentType ?? sourceId;
      const now = Date.now();
      ctx.subagentStartedAt.set(sourceId, now);
      ctx.activeSubagents.set(sourceId, { label, elapsedMs: 0 });
      if (ctx.overlayComposerForStatus) {
        ctx.overlayComposerForStatus.markDirty('subagent-status');
        ctx.overlayComposerForStatus.flush();
      }
    }
  }

  if (isOrchestrator) {
    // Snapshot the stage before the event so we can fire onStageChange
    // exactly when the stage transitions (not on every event).
    const stageBefore = ctx.stageTracker.stage;
    handleOrchestratorEvent(event, source, ctx.buildOrchestratorCtx());
    // Fire onStageChange when the loop stage transitions so the LoopStageBar
    // footer row repaints immediately — without polling or threading the bar
    // through the overlay compositor. Swallows errors defensively.
    //
    // Also fire on an ERRORED tool result even when the stage did not change:
    // a failed tool inside a parallel wave leaves other tools pending, so the
    // stage stays 'acting' and the mascot band would never learn about the
    // error. Consumers are idempotent repaints (LoopStageBar.repaint is a
    // no-op re-render of the same stage), so the extra fire is free.
    const toolErrored =
      event.type === 'chunk' &&
      event.chunk.type === 'tool_result' &&
      event.chunk.isError === true;
    if (ctx.onStageChange && (ctx.stageTracker.stage !== stageBefore || toolErrored)) {
      try {
        // Invariant: the no-signal case calls with ONE argument, never
        // `(stage, undefined)`. Vitest's toHaveBeenCalledWith compares the
        // whole argument array, so passing an explicit undefined would break
        // every existing single-argument assertion on this callback — and any
        // future one — for no benefit.
        if (toolErrored) ctx.onStageChange(ctx.stageTracker.stage, { toolErrored: true });
        else ctx.onStageChange(ctx.stageTracker.stage);
      } catch { /* best-effort */ }
    }
  } else {
    handleSubagentEvent(event, sourceId, source, makeSubagentCtx({
      isTTY: ctx.isTTY,
      compositor: ctx.compositor,
      toolLane: ctx.toolLane,
      out: ctx.out,
      streamingMarkdown: ctx.subagentMarkdown,
      thinkingMode: ctx.thinkingMode,
      orchestratorCtx: ctx.buildOrchestratorCtx(),
    }));
    // Refresh staleness timestamp and clear any pause annotation on new activity.
    source.lastEventAt = Date.now();
    // Invariant: the quiet-banner latch is re-armed HERE, at the single site
    // that records child activity — not by checkProgressBannerStaleness
    // observing an intermediate fresh state on a later tick. The tick-side
    // clear alone is not sufficient: it only fires if some tick lands inside
    // the CHILD_QUIET_MS window after a resume, so a suspended process, a
    // closed laptop lid, or an event loop blocked past 8s skips every such
    // tick and strands the latch at true. The next genuine quiet transition
    // would then be swallowed by the `already announced` guard and the dead
    // zone would silently reopen for that child, permanently.
    source.quietBannerAnnounced = false;
    if (source.pauseAnnotation !== undefined && source.syntheticAgentToolUseId) {
      source.pauseAnnotation = undefined;
      // Reset stall counter — a heartbeat proves the source is alive again.
      // Without this reset, K stalled ticks → heartbeat → K more ticks would
      // fire the hard cutoff at 2K cumulative (30s after resume) instead of
      // requiring 2K continuous ticks (60s) of new silence.
      source.stalledTicks = 0;
      const label = source.agentType ?? sourceId;
      ctx.toolLane.addStartWithAgentContext(
        source.syntheticAgentToolUseId, 'Agent', `(${label})`, undefined,
      );
    }
    // Terminal event for a subagent stream: 'done' (normal completion) OR
    // 'error' (aborted, timed-out, or provider-side failure). Both must
    // trigger the same flush-to-scrollback path so the user sees the
    // partial work in scrollback rather than losing it when the live
    // overlay is torn down at turn end.
    //
    // History: pre-this-fix, only 'done' triggered the flush. Ctrl+C
    // cascades aborts via AbortGraph; each subagent's iterator throws
    // AbortError; each subagent emits `event.type === 'error'` (NOT done).
    // The 'error' branch in handleSubagentEvent
    // (stream-renderer-subagent.ts:408-432) sets source.errored = true,
    // calls addResult with the error message, and refreshes the live
    // overlay — but never schedules a coordinator batch or drains the
    // subagent block to scrollback. The lane entry then either gets
    // wiped by the dispose() safety net (with its own scrollback-push
    // limitations) or by overlay.setOverlay('') at borrow-dispose,
    // dropping the user's view of what the subagent was working on.
    //
    // The merged Agent root entry has agent.result set by addResult
    // (either an error-result for 'error' or a synthetic done-result
    // for 'done'), so flushSource() renders the block correctly in both
    // cases. The user sees the in-flight tool calls + the error/done
    // summary line for any subagent that produced events before
    // terminating.
    const isTerminal = event.type === 'done' || event.type === 'error';
    // Remove the subagent status bar on terminal events regardless of TTY mode.
    if (isTerminal && ctx.activeSubagents.has(sourceId)) {
      ctx.activeSubagents.delete(sourceId);
      ctx.subagentStartedAt.delete(sourceId);
      if (ctx.overlayComposerForStatus) {
        ctx.overlayComposerForStatus.markDirty('subagent-status');
        ctx.overlayComposerForStatus.flush();
      }
    }
    if (isTerminal && ctx.isTTY) {
      // Flush only this subagent's entries (parent + children) — other
      // sources' entries remain in the overlay for still-running sub-agents.
      const syntheticId = source.syntheticAgentToolUseId;
      if (syntheticId && ctx.toolLane.hasEntry(syntheticId)) {
        const lines = ctx.toolLane.flushSource(syntheticId);
        const compositor = ctx.compositor;
        const overlayComposer = ctx.overlayComposer;
        const toolLane = ctx.toolLane;
        const out = ctx.out;
        ctx.coordinator.schedule({
          anchor: `after-subagent:${sourceId}`,
          commits: [() => {
            if (compositor) {
              // Atomic block commit — a subagent block is ONE coherent
              // artifact; per-line commits desync band-hold under a tall
              // overlay. See commit-block.ts.
              commitBlockAbove(compositor, lines);
              // One blank line after the subagent block so the next
              // orchestrator message (or a subsequent subagent block) has
              // breathing room in scrollback.
              compositor.commitAbove('');
              // Route the overlay update through the composer if available.
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
        // Eager drain: commit subagent done-blocks to scrollback at the
        // event-timeline position where the subagent FINISHED, not at the
        // end of the turn. This is the fix for the "subagent rows pile up
        // at the bottom" regression — without it, every Agent(...) block
        // is deferred to flushAll() step 3 and lands below all prose.
        //
        // Bug #1 invariant preservation: before draining the subagent block,
        // synchronously flush any pending markdown buffer via commitPending().
        // The real StreamingMarkdownRenderer.commitPending() writes the
        // ENTIRE buffer to scrollback via compositor.commitAbove (see
        // markdown-stream.ts:191 — commitBlock commits whatever is in the
        // buffer, partial-block included). This means all prose generated
        // BEFORE the subagent's done-event lands above the subagent block,
        // satisfying the "completed prose before subagent block" ordering
        // invariant. Any subsequent orchestrator prose pushes into a fresh
        // empty buffer and naturally lands below the subagent block —
        // which is the desired chronological interleave.
        //
        // External constraint (pattern card: ordered-sequences governed by
        // append-only scrollback): commitPending MUST run before
        // drainSubagent. Append-only scrollback cannot retroactively insert
        // prose above a previously-committed line.
        try {
          if (ctx.streamingMarkdownRef.current) {
            ctx.streamingMarkdownRef.current.commitPending();
          }
        } finally {
          // Invariant: drain MUST run even if commitPending throws — otherwise the
          //   after-subagent batch in CommitCoordinator is permanently stranded.
          //   Idempotency: drainSubagent deletes the batch on first execution, so a
          //   later flushAll call is a no-op.
          // History: an earlier `hasEmitted()` markdown-renderer guard could skip
          //   drain on zero-emission subagents. Safety after removal: (1) the
          //   coordinator.schedule(...) call above always registers a batch before
          //   this drain runs, and (2) drainSubagent no-ops when no batch exists
          //   (commit-coordinator.ts `if (batches)` guard).
          ctx.coordinator.drainSubagent(sourceId);
        }
      }
      setComposedOverlay(ctx.buildOrchestratorCtx());
    }
  }
}

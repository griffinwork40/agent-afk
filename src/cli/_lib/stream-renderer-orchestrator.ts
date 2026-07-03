/**
 * Orchestrator event handling (sourceId === '__main__') for StreamRenderer.
 * Exports the event handler, finalization, and output helpers as free functions
 * that operate on a passed OrchestratorCtx object.
 *
 * @module cli/_lib/stream-renderer-orchestrator
 */

import type { OutputEvent, ProgressEvent } from '../../agent/types.js';
// Design note (issue #389): `lastProgressByTask` is now a field of
// OrchestratorCtx rather than a separate parameter to setComposedOverlay.
// This lets any callsite (including subagent handlers via
// SubagentCtx.orchestratorCtx) compose the full overlay without needing
// an independent copy of the progress map. See the SubagentCtx comment in
// stream-renderer-subagent.ts for the companion rationale.
import type { SourceState } from './stream-renderer-source.js';
import type { Writer } from '../slash/types.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import type { CommitCoordinator } from './commit-coordinator.js';
import type { OverlayComposer } from './overlay-composer.js';
import type { CardSpec } from '../render.js';

import {
  advanceStage,
  type StageTrackerState,
} from '../commands/interactive/loop-stage.js';
import { stripCommandTags, extractSkillTag } from '../slash/_lib/command-tags.js';
import { styleForCategory, SUBAGENT_TOOLS, DAG_TOOLS } from '../tool-category.js';
import { formatThinkingParagraph } from '../commands/interactive/thinking-paragraph.js';
import { deriveProgressActivity, formatProgressBanner } from '../commands/interactive/progress-banner.js';
import { getTerminalWidth } from '../terminal-size.js';
import {
  emitPanel,
  finalizeOrchestrator,
  emitErrorBox,
  flushToolLaneToScrollback,
  commitThinkingPhase,
} from './stream-renderer-orchestrator-emit.js';

// Re-export from emit module
export {
  emitPanel,
  finalizeOrchestrator,
  emitMarkdown,
  emitErrorBox,
  flushToolLaneToScrollback,
} from './stream-renderer-orchestrator-emit.js';

/**
 * Context object passed to orchestrator event handlers. Wraps mutable fields
 * (streamingMarkdown) in a reference object so the renderer can swap them
 * in/out without callback friction.
 */
export interface OrchestratorCtx {
  out: Writer;
  isTTY: boolean;
  compositor: TerminalCompositor | null;
  // Optional: production StreamRenderer always provides it; tests and non-TTY
  // surfaces omit it and the overlay routing falls back to a direct setOverlay
  // (the `if (ctx.overlayComposer) … else if (ctx.compositor)` branches).
  overlayComposer?: OverlayComposer | null;
  toolLane: ToolLane;
  thinkingLane: ThinkingLane;
  /**
   * `'off'` suppresses thinking entirely (no buffer, no overlay, no summary).
   * `'summary'` buffers and emits a collapsed summary on finalize.
   * `'live'` shows a streaming preview overlay and the finalize summary.
   */
  // Optional: omitted callers (tests, non-TTY surfaces) behave as 'summary' —
  // the consuming checks are `=== 'off'` / `!== 'off'` / `=== 'live'`, all of
  // which treat undefined as the documented summary default.
  thinkingMode?: 'off' | 'summary' | 'live';
  /** Lazy holder so callers can swap StreamingMarkdownRenderer in/out. */
  streamingMarkdown: { current: StreamingMarkdownRenderer | null };
  /**
   * Optional loop-stage tracker. When present, the orchestrator feeds it
   * each event and includes a one-line stage rail at the top of the
   * composed live overlay so the user can see where in the
   * Observe → Model → Choose → Act → Update cycle the agent currently sits.
   *
   * Optional because non-interactive surfaces (Telegram, daemon, tests)
   * have no use for a TTY rail and can omit it cheaply.
   */
  stageTracker?: StageTrackerState;
  /**
   * Active skill name (e.g. `'ship'`). When present, the model's
   * `<skillname>` content tags are converted to a styled visual badge
   * instead of leaking as raw XML.
   */
  activeSkillName?: string;
  /** Guards against emitting the skill badge more than once per turn. */
  skillBadgeEmitted?: boolean;
  /**
   * Optional commit coordinator. When present, `finalizeOrchestrator`
   * schedules tool-lane and thinking-summary commits via the coordinator
   * (deferred; flushed at turn end via `StreamRenderer.dispose()`).
   *
   * When absent (tests, non-TTY fallback paths), `finalizeOrchestrator`
   * falls back to direct-emit behavior for backward compatibility.
   */
  coordinator?: CommitCoordinator;
  /**
   * Live progress map — mutated by `progress` events and read by
   * `setComposedOverlay` to render the progress banner layer of the
   * composed overlay. Hoisted from the old second parameter so every
   * callsite (including subagent handlers via SubagentCtx.orchestratorCtx)
   * can compose the full frame without carrying a separate copy.
   */
  lastProgressByTask: Map<string, ProgressEvent>;
}

/**
 * Handle one event for the orchestrator source.
 */
export function handleOrchestratorEvent(
  event: OutputEvent,
  source: SourceState,
  ctx: OrchestratorCtx,
): void {
  // Invariant: at most one setComposedOverlay call per event. The pre-switch
  // block updates tracker state only; per-case arms below fire the single
  // repaint AFTER mutating toolLane / thinkingLane so the composed overlay
  // reflects the post-mutation state in one frame. Every per-case arm that
  // CAN cause a visible change (lane mutation, stage advance, banner update)
  // is responsible for its own setComposedOverlay call.
  //
  // See the `stage rail single-paint invariant` block in the test file.
  if (ctx.stageTracker) advanceStage(ctx.stageTracker, event);

  switch (event.type) {
    case 'progress':
      // Invariant: lastProgressByTask holds at most one entry. The orchestrator
      // runs exactly one tool-use loop at a time, and subagent progress is
      // firewalled to handleSubagentEvent (it carries a non-null subagentId and
      // never reaches this map — see stream-renderer.ts isOrchestrator branch),
      // so only the single live loop ever writes here. clear() before set()
      // evicts a stale entry left by a SECOND runTurn invocation that shares
      // this live renderer: loop.ts mints a fresh taskId per runTurn, and a
      // retry that replays the turn without rebuilding the renderer (the 401
      // auth-retry path; ANY retry on the skill-dispatch renderer, which —
      // unlike turn-handler.ts — never rebuilds on 'resumed') would otherwise
      // leave two distinct taskIds accumulated here, rendering two stacked
      // "Tool-use loop" banners. The live loop's next progress event wipes it.
      ctx.lastProgressByTask.clear();
      ctx.lastProgressByTask.set(event.progress.taskId, event.progress);
      if (ctx.isTTY) setComposedOverlay(ctx);
      return;

    case 'chunk': {
      const chunk = event.chunk;
      if (chunk.type === 'tool_use_detail') {
        // Thinking→acting boundary: the model has finished reasoning for the
        // moment and is dispatching a tool. Cap the thinking-duration window
        // here so the "thought for Xs" line reports thinking time, not the
        // tool-execution wall-clock that follows. Idempotent — see
        // ThinkingLane.markEnded.
        ctx.thinkingLane.markEnded();
        ctx.streamingMarkdown.current?.commitPending();
        // Eager scrollback commit for completed FLAT root tools BEFORE adding
        // the new tool entry.
        //
        // External constraint (tool-use-loop visibility): when the model runs
        // a long tool-use loop with no interleaved `content` chunks (typical
        // for Opus 1M and other deeply-thinking models that emit ◆ thinking
        // + tool calls without visible prose), the only pre-existing flush
        // trigger (`chunk.type === 'content'`) never fires. The toolLane
        // accumulates unbounded; entries get truncated off the top by
        // `overlayBudget` in TerminalCompositor.repaint() and disappear
        // without ever entering scrollback. The user perceives "nothing in
        // scrollback" — prior iterations of the loop are silently lost.
        //
        // Trigger placement (tool_use_detail of the NEXT tool, NOT tool_result
        // of the prior one): the SDK emits `tool_diff` as a sidecar after
        // `tool_result`. Flushing on tool_result would commit the entry and
        // remove it before the diff sidecar lands — silently dropping
        // edit_file/write_file diff visibility. By the time the next
        // tool_use_detail arrives, the model has typically interleaved at
        // least one thinking chunk, so the diff has had time to attach to
        // the prior entry.
        //
        // `flushToolLaneToScrollback` uses `flushCompletedRoots` (surgical),
        // so it only commits roots with results and no agentContext — i.e.
        // completed flat tool calls. NESTING_TOOLS (`agent`, `Task`, `skill`,
        // `compose`) commit through their own subagent-done path
        // (`stream-renderer.ts:537-600` → `coordinator.drainSubagent`) and
        // their entries are already gone from the toolLane by the time the
        // next orchestrator tool_use_detail fires. In-flight roots stay in
        // the lane (`flushCompletedRoots` filters them out).
        if (ctx.isTTY) {
          // Invariant (cross-flush run accumulation + append-only ordering):
          // when the incoming tool would EXTEND a run of the same flat tool
          // already completed in the lane, skip the eager flush so the run
          // accumulates and commits as one grouped `toolName ×N` block when it
          // breaks — UNLESS a thinking phase is pending. A pending thought MUST
          // break the run: commitThinkingPhase below commits `◆ thought for Xs`
          // inline, and a held run would otherwise commit AFTER that thought,
          // reordering it above its own tool group (scrollback is append-only,
          // so it cannot be fixed post-commit). `thinkingPhaseStartedAt == null`
          // is exactly "no thought pending" (set only in non-off thinking modes
          // by the 'thinking' handler below). peekTrailingCompletedRootToolName
          // returns undefined for NESTING/in-flight trailing roots, so dispatch
          // tools and parallel blocks are unaffected.
          const trailingRun = ctx.toolLane.peekTrailingCompletedRootToolName();
          const holdRun =
            trailingRun !== undefined &&
            trailingRun === chunk.toolName &&
            source.thinkingPhaseStartedAt == null;
          if (!holdRun) {
            // Order: prior completed tool first, THEN the thinking phase that
            // produced THIS tool — so the inline "◆ thought for Xs" line hugs the
            // tool it preceded (and sits below the prior tool). commitThinkingPhase
            // is a no-op when no phase is pending.
            flushToolLaneToScrollback(ctx);
          }
          commitThinkingPhase(source, ctx);
        }
        // Invariant: skill-nesting gate — when this is a skill-dispatch turn
        // (ctx.activeSkillName set) AND the incoming tool is a NESTING_CLASS
        // tool (SUBAGENT_TOOLS ∪ DAG_TOOLS: 'agent','Agent','Task','compose'),
        // nest it under the skill spine by passing the skill entry's id as
        // agentContext. This collapses the overlay from two separate roots
        // (◉ skill + ◉ Agent) into a single nested tree (◉ skill │ ╰─ Agent).
        //
        // Scope constraints — ONLY nest NESTING-class tools, never flat leaves:
        // - Flat tools (bash, read_file, etc.) must stay at root (agentContext
        //   undefined) so flushCompletedRoots can eagerly commit them. That
        //   path filters out any entry with agentContext, so nesting flat tools
        //   would break the tool-use-loop visibility invariant documented at
        //   ~line 150-178. NESTING tools have their own commit path via
        //   stream-renderer.ts:537-600 (coordinator.drainSubagent) and are
        //   already gone from the lane by the time the next eager flush fires.
        //
        // - Only when ctx.activeSkillName is set (slash-skill dispatch turns).
        //   Normal turns where the model calls `skill` mid-turn are unaffected.
        //
        // - The skill anchor is the most-recent live 'skill' entry in the lane
        //   (findLastSkillEntryId). If none, agentContext falls back to
        //   undefined (current behavior), so the gate is always safe.
        //
        // - mergeAgentLabel preserves existing agentContext (does not mutate
        //   it), so nesting set here survives the synthesizeAgentEntry merge.
        //   flushSource walks the agentContext chain upward via eager ancestor-
        //   header emission (tool-lane.ts:586-617), so the skill header lands
        //   in scrollback before its Agent child's done-block.
        const isNestingTool = SUBAGENT_TOOLS.has(chunk.toolName) || DAG_TOOLS.has(chunk.toolName);
        const agentCtx: string | undefined =
          ctx.activeSkillName && isNestingTool
            ? ctx.toolLane.findLastSkillEntryId()
            : undefined;
        ctx.toolLane.addStartWithAgentContext(
          chunk.toolUseId,
          chunk.toolName,
          chunk.toolInput,
          agentCtx,
        );
        source.stats.toolUses += 1;
        // Tool gap: the model is waiting on tool execution rather than
        // generating visible text. Re-enable the spinner so the user sees
        // an honest "waiting" signal during the gap. (No-op if already on.)
        if (ctx.isTTY && ctx.compositor) {
          ctx.compositor.setSpinner({ enabled: true, rotateVerbEveryMs: 3500 });
        }
        if (ctx.isTTY) setComposedOverlay(ctx);
      } else if (chunk.type === 'tool_result') {
        ctx.streamingMarkdown.current?.commitPending();
        ctx.toolLane.addResult(chunk.toolUseId, chunk);
        if (ctx.isTTY) setComposedOverlay(ctx);
      } else if (chunk.type === 'tool_diff') {
        // Sidecar render-only diff. Late-attached to the matching tool
        // entry by `toolUseId`; if the entry no longer exists (lane
        // already flushed), `addDiff` is a no-op by design.
        ctx.toolLane.addDiff(chunk.toolUseId, chunk.diff);
        if (ctx.isTTY) setComposedOverlay(ctx);
      } else if (chunk.type === 'content') {
        // Thinking→acting boundary: text is starting to stream. Cap the
        // thinking-duration window so a 30s think followed by 150s of text
        // streaming doesn't report "thought for 180s." Idempotent — only
        // the first non-thinking event takes effect.
        ctx.thinkingLane.markEnded();
        let cleaned = stripCommandTags(chunk.content);
        if (ctx.activeSkillName && !ctx.skillBadgeEmitted) {
          const result = extractSkillTag(cleaned, ctx.activeSkillName);
          cleaned = result.text;
          if (result.found) {
            ctx.skillBadgeEmitted = true;
            const { color, glyph } = styleForCategory('skill');
            const badge = '  ' + color(glyph + ' ') + color.bold(ctx.activeSkillName);
            if (ctx.isTTY && ctx.compositor) {
              ctx.compositor.commitAbove(badge);
            } else {
              ctx.out.line(badge);
            }
          }
        } else if (ctx.activeSkillName) {
          const result = extractSkillTag(cleaned, ctx.activeSkillName);
          cleaned = result.text;
        }
        if (!cleaned) return;
        source.contentBuffer += cleaned;
        if (ctx.isTTY) {
          // Real streamed text is about to render. Pause the spinner so the
          // user doesn't see a "thinking…" indicator next to text that is
          // visibly arriving — the spinner is a waiting signal, not a
          // decoration. It re-enables on the next tool_use_detail (the
          // genuine waiting window).
          if (ctx.compositor) {
            ctx.compositor.setSpinner({ enabled: false });
          }
          flushToolLaneToScrollback(ctx);
          // Seal the thinking phase that preceded this prose so the inline
          // "◆ thought for Xs" line lands above the response (and below the
          // last tool). No-op on later content chunks of the same prose block.
          commitThinkingPhase(source, ctx);
          if (!ctx.streamingMarkdown.current) {
            ctx.streamingMarkdown.current = new StreamingMarkdownRenderer({
              ...(ctx.compositor ? { compositor: ctx.compositor } : {}),
              ...(ctx.overlayComposer ? { overlayComposer: ctx.overlayComposer } : {}),
            });
          }
          ctx.streamingMarkdown.current.push(cleaned);
        }
      } else if (chunk.type === 'thinking') {
        if (ctx.thinkingMode === 'off') return;
        // Start the per-phase timer on the first chunk of a new phase (reset to
        // undefined when the phase is sealed at the next tool/prose boundary).
        // Orchestrator-owned timing; the lane just buffers text. Harmless on
        // non-TTY (set but never drained — collapse() uses the cumulative span).
        if (source.thinkingPhaseStartedAt == null) {
          source.thinkingPhaseStartedAt = Date.now();
        }
        ctx.thinkingLane.push(chunk.content);
        // Only repaint the overlay in 'live' mode — summary mode buffers
        // silently and has nothing overlay-visible to push (the stage rail
        // moved to a footer bar and is repainted via onStageChange in
        // stream-renderer.ts, not through setComposedOverlay).
        if (ctx.isTTY && ctx.thinkingMode === 'live') setComposedOverlay(ctx);
      }
      return;
    }

    case 'message':
      if (!source.contentBuffer) {
        source.contentBuffer = stripCommandTags(event.message.content);
      }
      return;

    case 'error':
      source.errored = true;
      emitErrorBox(event.error, ctx.out);
      return;

    case 'done':
      source.done = true;
      if (event.metadata) source.responseMetadata = event.metadata;
      finalizeOrchestrator(source, ctx);
      return;

    case 'suggestion':
      return;

    case 'stream_retry':
      // Mid-stream overload re-drive: the loop is about to re-stream this
      // round's text from scratch. Discard the round's uncommitted text so it
      // does not visibly duplicate — both the non-TTY `contentBuffer`
      // accumulator and the pending markdown overlay (TTY). Scrollback blocks
      // already committed past a block boundary are append-only and remain.
      source.contentBuffer = '';
      ctx.streamingMarkdown.current?.discardPending();
      return;

    case 'panel':
      emitPanel(event.spec as CardSpec, source, ctx);
      return;
  }
}

/**
 * Compose stage-rail + thinking paragraph + tool-lane overlay + progress
 * banner into a single overlay string and push it to the compositor
 * atomically. All layers are optional — whichever is active gets included.
 *
 * This is the ONLY function that should call `compositor.setOverlay` with
 * live content. All orchestrator and subagent code paths that mutate
 * toolLane, thinkingLane, or the progress map must route their overlay
 * repaints through here so every frame includes the full composed picture.
 *
 * The second `lastProgressByTask` parameter was removed in issue #389 — it
 * is now read from `ctx.lastProgressByTask` so subagent handlers can call
 * this function via `ctx.orchestratorCtx` without needing a separate
 * reference to the progress map.
 */
export function setComposedOverlay(ctx: OrchestratorCtx): void {
  if (!ctx.compositor) return;

  // When the overlay composer is available, use it to compose all slots.
  // Otherwise (tests, backward compatibility), fall back to direct composition.
  if (ctx.overlayComposer) {
    ctx.overlayComposer.invalidate();
    ctx.overlayComposer.flush();
    return;
  }

  // Live thinking preview — rendered above the tool lane so the user sees
  // the model's current reasoning while it streams. Only in 'live' mode;
  // 'summary' mode buffers silently and emits a single line at turn-end.
  //
  // Rendered as a wrapped, soft-capped paragraph (`◆ thinking` header +
  // indented body, ~5 visible lines, `⋯ +N chars earlier` footer when the
  // buffer outruns the cap). See `formatThinkingParagraph` for the format
  // and the design rationale — including why we cap (otherwise a 30-second
  // chain of thought would push the tool lane and progress banner offscreen).
  //
  // Subagent thinking is deliberately NOT wired through this path — each
  // subagent renders into its parent's ToolLane row via
  // `setThinkingTail()` in stream-renderer-subagent.ts. See the comment
  // block in that file for why parallel subagents stay on the single-line
  // tail treatment instead of the paragraph format.
  const parts: string[] = [];
  if (ctx.thinkingMode === 'live' && ctx.thinkingLane.hasBufferedContent()) {
    const paragraph = formatThinkingParagraph(ctx.thinkingLane.peek(), {
      cols: getTerminalWidth(),
    });
    if (paragraph) parts.push(paragraph);
  }
  if (ctx.toolLane.hasPending()) parts.push(ctx.toolLane.getOverlay());
  const bannerLines: string[] = [];
  // Grounded activity: the model's in-flight thinking clause (current
  // uncommitted phase only — peekPhase clears at each seal boundary, so a
  // stale clause never outlives the phase that produced it). Falls back to
  // the event's own tool-derived summary inside formatProgressBanner.
  const activity = deriveProgressActivity(ctx.thinkingLane.peekPhase());
  for (const progress of ctx.lastProgressByTask.values()) {
    bannerLines.push(...formatProgressBanner(progress, undefined, activity));
  }
  if (bannerLines.length > 0) parts.push(bannerLines.join('\n'));
  ctx.compositor.setOverlay(parts.join('\n'));
}

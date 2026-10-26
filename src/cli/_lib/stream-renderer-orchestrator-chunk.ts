/**
 * Orchestrator chunk-event handler, extracted from handleOrchestratorEvent.
 * Handles all sub-types of the 'chunk' OutputEvent for the __main__ source.
 *
 * Extracted to keep handleOrchestratorEvent under the 200-line function
 * ceiling (issue #3478). All invariant and ordering comments are preserved
 * verbatim next to the code they govern.
 *
 * @module cli/_lib/stream-renderer-orchestrator-chunk
 */

import type { MessageChunk } from '../../agent/types.js';
import type { SourceState } from './stream-renderer-source.js';
import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';
import { setComposedOverlay } from './stream-renderer-orchestrator.js';
import {
  flushToolLaneToScrollback,
  commitThinkingPhase,
} from './stream-renderer-orchestrator-emit.js';
import { stripCommandTags, extractSkillTag } from '../slash/_lib/command-tags.js';
import { styleForCategory, SUBAGENT_TOOLS, DAG_TOOLS } from '../tool-category.js';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import { env } from '../../config/env.js';

/** Sentinel key for the synthetic rate-limit backoff banner (see orchestrator.ts). */
const RATE_LIMIT_TASK_ID = '__rate_limit__';

/**
 * Handle the 'chunk' case of handleOrchestratorEvent.
 *
 * Called with the raw ChunkEvent payload already extracted from the OutputEvent.
 * All parameters are explicit — no closures over enclosing locals.
 *
 * Invariant: at most one setComposedOverlay call per chunk sub-type, fired
 * AFTER all lane mutations so the overlay reflects the post-mutation state
 * in one frame. See the orchestrator-level invariant comment for the full
 * rationale.
 */
export function handleOrchestratorChunk(
  chunk: MessageChunk,
  source: SourceState,
  ctx: OrchestratorCtx,
): void {
  // Streaming resumed: the SDK's throttle backoff (see the 'rate_limit'
  // case) is over the instant the first stream chunk lands. On a text-only
  // turn NO `progress` event follows to evict the synthetic backoff banner,
  // so it would otherwise linger under the streamed answer until turn-end
  // finalization — the status line reading `rate-limited · retrying…` while
  // the retried response is already streaming. Drop it here on the first
  // chunk (any type) so the banner covers only the real wait window. The
  // `delete()` returns true only while the entry exists, so the repaint
  // fires at most once per backoff, not on every chunk.
  if (ctx.lastProgressByTask.delete(RATE_LIMIT_TASK_ID) && ctx.isTTY) {
    setComposedOverlay(ctx);
  }

  if (chunk.type === 'tool_use_detail') {
    handleToolUseDetail(chunk, source, ctx);
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
    handleContentChunk(chunk, source, ctx);
  } else if (chunk.type === 'thinking') {
    handleThinkingChunk(chunk, source, ctx);
  }
}

/**
 * Handle a tool_use_detail chunk for the orchestrator source.
 *
 * Invariant (cross-flush run accumulation + append-only ordering):
 * when the incoming tool would EXTEND a run of the same flat tool
 * already completed in the lane, skip the eager flush so the run
 * accumulates and commits as one grouped `toolName ×N` block when it
 * breaks — UNLESS a thinking phase is pending. A pending thought MUST
 * break the run: commitThinkingPhase below commits `◆ thought for Xs`
 * inline, and a held run would otherwise commit AFTER that thought,
 * reordering it above its own tool group (scrollback is append-only,
 * so it cannot be fixed post-commit). `thinkingPhaseStartedAt == null`
 * is exactly "no thought pending" (set only in non-off thinking modes
 * by the 'thinking' handler below). peekTrailingCompletedRootToolName
 * returns undefined for NESTING/in-flight trailing roots, so dispatch
 * tools and parallel blocks are unaffected.
 *
 * Invariant: skill-nesting gate — when this is a skill-dispatch turn
 * (ctx.activeSkillName set) AND the incoming tool is a NESTING_CLASS
 * tool (SUBAGENT_TOOLS ∪ DAG_TOOLS: 'agent','Agent','Task','compose'),
 * nest it under the skill spine by passing the skill entry's id as
 * agentContext. This collapses the overlay from two separate roots
 * (◉ skill + ◉ Agent) into a single nested tree (◉ skill │ ╰─ Agent).
 */
function handleToolUseDetail(
  chunk: Extract<MessageChunk, { type: 'tool_use_detail' }>,
  source: SourceState,
  ctx: OrchestratorCtx,
): void {
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

  // Scope constraints — ONLY nest NESTING-class tools, never flat leaves:
  // - Flat tools (bash, read_file, etc.) must stay at root (agentContext
  //   undefined) so flushCompletedRoots can eagerly commit them. That
  //   path filters out any entry with agentContext, so nesting flat tools
  //   would break the tool-use-loop visibility invariant documented above.
  //   NESTING tools have their own commit path via stream-renderer.ts:537-600
  //   (coordinator.drainSubagent) and are already gone from the lane by the
  //   time the next eager flush fires.
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
  if (!source.stats.seenToolUseIds.has(chunk.toolUseId)) {
    source.stats.seenToolUseIds.add(chunk.toolUseId);
    source.stats.toolUses += 1;
  }
  // Tool gap: the model is waiting on tool execution rather than
  // generating visible text. Re-enable the spinner so the user sees
  // an honest "waiting" signal during the gap. (No-op if already on.)
  if (ctx.isTTY && ctx.compositor) {
    ctx.compositor.setSpinner({ enabled: true, rotateVerbEveryMs: 3500 });
  }
  if (ctx.isTTY) setComposedOverlay(ctx);
}

/**
 * Handle a content chunk for the orchestrator source.
 *
 * Manages skill-badge emission, contentBuffer accumulation, spinner pause,
 * tool-lane flush, thinking-phase seal, and StreamingMarkdownRenderer push.
 */
function handleContentChunk(
  chunk: Extract<MessageChunk, { type: 'content' }>,
  source: SourceState,
  ctx: OrchestratorCtx,
): void {
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
        bufferMs: Number(env.AFK_STREAM_BUFFER_MS) || 0,
      });
    }
    ctx.streamingMarkdown.current.push(cleaned);
  }
}

/**
 * Handle a thinking chunk for the orchestrator source.
 *
 * Buffers thinking text into the ThinkingLane and repaints the overlay in
 * 'live' and 'digest' modes.
 */
function handleThinkingChunk(
  chunk: Extract<MessageChunk, { type: 'thinking' }>,
  source: SourceState,
  ctx: OrchestratorCtx,
): void {
  if (ctx.thinkingMode === 'off') return;
  // Start the per-phase timer on the first chunk of a new phase (reset to
  // undefined when the phase is sealed at the next tool/prose boundary).
  // Orchestrator-owned timing; the lane just buffers text. Harmless on
  // non-TTY (set but never drained — collapse() uses the cumulative span).
  if (source.thinkingPhaseStartedAt == null) {
    source.thinkingPhaseStartedAt = Date.now();
  }
  ctx.thinkingLane.push(chunk.content);
  // Repaint the overlay in 'live' and 'digest' modes — both stream the
  // live preview. ('summary' buffers silently, with nothing overlay-visible
  // to push; the stage rail moved to a footer bar and is repainted via
  // onStageChange in stream-renderer.ts, not through setComposedOverlay.)
  if (ctx.isTTY && (ctx.thinkingMode === 'live' || ctx.thinkingMode === 'digest')) setComposedOverlay(ctx);
}

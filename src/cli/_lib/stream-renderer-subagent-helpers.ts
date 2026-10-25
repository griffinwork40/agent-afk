/**
 * Helper functions for subagent event handling in StreamRenderer.
 * Extracted from stream-renderer-subagent.ts to keep module files under 350 lines.
 *
 * @module cli/_lib/stream-renderer-subagent-helpers
 */

import type { MessageChunk } from '../../agent/types.js';
import type { SourceState } from './stream-renderer-source.js';
import type { SubagentCtx } from './stream-renderer-subagent.js';
import { setComposedOverlay } from './stream-renderer-orchestrator.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';
import { capToMeasure } from '../render/measure.js';

/**
 * Pull the latest "clause" out of a thinking buffer for the live tail.
 *
 * Searches the trailing window of the buffer for the most recent sentence
 * boundary (`.`, `!`, `?` followed by whitespace, or `\n`), and returns the
 * text after it — that's the in-flight thought, which is the most useful
 * signal to surface. Whitespace is collapsed; the result is truncated from
 * the end with an ellipsis if it overruns `maxChars`. Returns `''` for
 * whitespace-only input.
 *
 * Exported for unit testing; not part of the module's public API.
 */
export function extractLatestThinkingClause(buffer: string, maxChars: number): string {
  const trimmed = buffer.trimEnd();
  if (!trimmed.trim()) return '';

  // Scan only the trailing window — clauses don't span the whole buffer, and
  // we don't want to pay O(n) per chunk on a multi-kilobyte thinking blob.
  const windowSize = Math.max(maxChars * 4, 400);
  const tail = trimmed.length > windowSize ? trimmed.slice(-windowSize) : trimmed;

  // Find the latest sentence boundary. `[.!?]\s+` for English prose, `\n+` for
  // bullet/list-style thinking. We want the position AFTER the boundary so
  // the returned clause is what the model is currently writing.
  const boundary = /[.!?](?=\s)|\n+/g;
  let lastBoundary = -1;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(tail)) !== null) {
    lastBoundary = m.index + m[0].length;
  }

  let candidate = lastBoundary >= 0 ? tail.slice(lastBoundary) : tail;
  candidate = candidate.replace(/\s+/g, ' ').trim();
  if (!candidate) return '';
  if (candidate.length > maxChars) {
    candidate = candidate.slice(0, Math.max(1, maxChars - 1)) + '…';
  }
  return candidate;
}

/**
 * Emit complete lines from subagent text to scrollback (NON-TTY ONLY).
 *
 * Each line is wrapped to terminal width, prefixed with `│ ` (dim), and indented
 * one level under the synthetic Agent entry.
 *
 * **TTY callers must not use this for subagent prose.** TTY treats subagent prose
 * as internal reasoning and routes it to `setThinkingTail` as a transient
 * one-liner under the Agent row (see the `content` chunk branch in
 * `handleSubagentEvent`). Calling this on TTY for prose is the historical leak
 * this module was redesigned to fix. The `│ `-gutter behavior is preserved for
 * non-TTY (logs, CI, headless runs) where full prose persists for debugging.
 *
 * On TTY this function early-returns — defensive no-op so any future caller
 * that drifts into the wrong mode silently does nothing rather than leaking.
 */
export function emitSubagentTextLines(text: string, ctx: SubagentCtx): void {
  if (!text || !text.trim()) return;
  if (ctx.isTTY) return; // Subagent prose never reaches parent scrollback on TTY.

  for (const fullLine of formatSubagentTextLines(text)) {
    ctx.out.line(fullLine);
  }
}

/**
 * Format `text` as one or more wrapped lines using the same `│ `-prefixed
 * indent shape as scrollback emission, but return them as a string array
 * instead of committing. Used to compose the in-progress overlay tail
 * alongside the tool-lane overlay so the user sees the partial trailing
 * line as it streams in.
 */
export function formatSubagentTextLines(text: string): string[] {
  if (!text) return [];
  const prefix = palette.dim('│ ');
  const indent = '    '; // one level indent
  // Clamped to the shared reading measure so subagent text keeps the same
  // right edge as adjacent prose (see `render/measure.ts`).
  const maxWidth = Math.max(1, capToMeasure(getTerminalWidth() - indent.length - 2 - 2));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const wrapped = wrapToWidth(para, maxWidth);
    for (const line of wrapped.split('\n')) {
      out.push(indent + prefix + line);
    }
  }
  return out;
}

/**
 * Create the synthetic `Agent(<agentType>)` entry for a subagent source on
 * its first event. Idempotent — no-op if a synthetic entry already exists.
 */
export function synthesizeAgentEntry(
  sourceId: string,
  source: SourceState,
  ctx: SubagentCtx,
  agentContext?: string,
): void {
  if (source.syntheticAgentToolUseId) return;

  // Belt-and-suspenders fallback: use agentType if set, else 'agent'.
  // Post-2d, source.agentType is always set at the fork site (subagent-executor.ts
  // passes agentType; compose-executor and skill-executor already passed it).
  // This runtime guard is defense-in-depth for any future code path that bypasses
  // the type-level expectation (e.g. dynamic dispatch, test stubs, vendored agents).
  // We deliberately do NOT fall back to sourceId — sourceId encodes an internal
  // id_prefix like 'agent-tool-TIMESTAMP-N' which is an implementation detail,
  // never a user-visible label.
  const label = source.agentType?.trim() || 'agent';

  // Resolve the same maxWidth budget used by the child-tool path at line ~217.
  // Without this, the Agent prefix is stored unbounded and re-renders on every
  // overlay refresh — long labels (e.g. 80-char prompt prefixes) wrap on narrow
  // terminals. Compute once and apply on whichever Agent-creation path runs.
  const cols = getTerminalWidth();
  const maxWidth = Math.max(20, cols - 14); // 14 = indent + glyph/spinner budget

  // Merge path: when the parent entry is itself an original agent-dispatch
  // tool (toolName ∈ {'agent', 'Task'} — not already-merged 'Agent'),
  // mutate it in place instead of creating a redundant synthetic child.
  // This collapses the double-row visual: "→ agent [subagent]" + "└→ Agent(<label>)"
  // → single "→ Agent(<label>) [subagent]" row.
  if (agentContext !== undefined && ctx.toolLane.mergeAgentLabel(agentContext, label, maxWidth)) {
    source.syntheticAgentToolUseId = agentContext;
    return;
  }

  // Fallback path: compose/skill/Compose/Skill parents (not in SUBAGENT_TOOLS),
  // already-merged 'Agent' parents (grandchild case), or unresolved agentContext
  // (undefined) — create the synthetic child entry as before.
  const syntheticId = `__synth_agent_${sourceId}`;
  ctx.toolLane.addStartWithAgentContext(syntheticId, 'Agent', `(${label})`, agentContext, maxWidth);
  source.syntheticAgentToolUseId = syntheticId;
}

/**
 * Per-parentId debounce maps for setThinkingTail and setComposedOverlay calls.
 * Module-scoped so they persist across calls to handleSubagentChunk within a session.
 * Cleaned up in finalizeSubagent / error path via delete(parentId).
 */
export const _thinkingTailLastUpdate = new Map<string, number>();
export const _overlayLastUpdate = new Map<string, number>();

/**
 * Handle the 'chunk' case of handleSubagentEvent.
 *
 * Called with the raw MessageChunk payload already extracted from the OutputEvent.
 * All parameters are explicit — no closures over enclosing locals.
 *
 * Invariant: discrete state transitions (tool_use_detail, tool_result, tool_diff,
 * error, done) always call setComposedOverlay immediately. High-frequency streaming
 * paths (content, thinking) are gated behind a 1500ms throttle per parentId to
 * prevent driving a full CupFrameRenderer.render() on every token.
 */
export function handleSubagentChunk(
  chunk: MessageChunk,
  sourceId: string,
  source: SourceState,
  parentId: string,
  ctx: SubagentCtx,
): void {
  if (chunk.type === 'tool_use_detail') {
    // Thinking→acting boundary for this subagent: cap the per-source
    // thinking-duration window so the Done row's `· thought Xs · N tok`
    // stat reports thinking time, not tool-execution wall-clock that
    // follows. Idempotent — see ThinkingLane.markEnded.
    source.thinkingLane?.markEnded();
    source.currentTextEntryId = undefined;
    const renderer = ctx.streamingMarkdown.get(sourceId);
    if (renderer) renderer.commitPending();

    // Clear the live thinking tail — the child has transitioned from
    // reasoning to acting, and the now-visible tool_use is a stronger
    // progress signal than a stale clause of thought.
    ctx.toolLane.setThinkingTail(parentId, undefined);

    const cols = getTerminalWidth();
    const maxWidth = capToMeasure(Math.max(20, cols - 14));  // 14 = indent + glyph/spinner budget
    ctx.toolLane.addStartWithAgentContext(
      chunk.toolUseId,
      chunk.toolName,
      chunk.toolInput,
      parentId,
      maxWidth,
    );
    if (!source.stats.seenToolUseIds.has(chunk.toolUseId)) {
      source.stats.seenToolUseIds.add(chunk.toolUseId);
      source.stats.toolUses += 1;
    }
    // Route through the full composed frame so the orchestrator's live-
    // thinking paragraph is preserved. (Issue #389.)
    if (ctx.isTTY && ctx.orchestratorCtx) {
      setComposedOverlay(ctx.orchestratorCtx);
    }
  } else if (chunk.type === 'tool_result') {
    const renderer = ctx.streamingMarkdown.get(sourceId);
    if (renderer) renderer.commitPending();
    ctx.toolLane.addResult(chunk.toolUseId, chunk);
    // Invariant: a dispatch refused BEFORE its child forks (depth
    // ceiling, unknown agent_type, validation, fork throw) never emits a
    // subagent 'error' event; this isError tool_result is its only
    // failure signal, so it must bubble here too. propagateChildFailure
    // ignores non-dispatch entries and is idempotent per entry, so the
    // mid-run path (which already bubbled via settleSubagentError) is
    // not double-counted. Runs AFTER addResult, same as the error path.
    if (chunk.isError) ctx.toolLane.propagateChildFailure(chunk.toolUseId);
    // Route through the full composed frame so the orchestrator's live-
    // thinking paragraph is preserved. (Issue #389.)
    if (ctx.isTTY && ctx.orchestratorCtx) {
      setComposedOverlay(ctx.orchestratorCtx);
    }
  } else if (chunk.type === 'tool_diff') {
    // Sidecar render-only diff for a subagent's tool call. Late-attach
    // by toolUseId; no-op if the entry already flushed.
    ctx.toolLane.addDiff(chunk.toolUseId, chunk.diff);
    // Route through the full composed frame so the orchestrator's live-
    // thinking paragraph is preserved. (Issue #389.)
    if (ctx.isTTY && ctx.orchestratorCtx) {
      setComposedOverlay(ctx.orchestratorCtx);
    }
  } else if (chunk.type === 'content') {
    handleSubagentContentChunk(chunk, sourceId, source, parentId, ctx);
  } else if (chunk.type === 'thinking') {
    handleSubagentThinkingChunk(chunk, source, parentId, ctx);
  }
}

/**
 * Handle a content chunk for a subagent source.
 *
 * On TTY: routes prose to the transient thinking tail (never scrollback).
 * On non-TTY: flushes complete lines to scrollback with gutter prefix.
 */
function handleSubagentContentChunk(
  chunk: Extract<MessageChunk, { type: 'content' }>,
  sourceId: string,
  source: SourceState,
  parentId: string,
  ctx: SubagentCtx,
): void {
  // Thinking→acting boundary for this subagent. Same idempotent cap
  // as the tool_use_detail branch above — the first non-thinking
  // event freezes the thinking-duration window for inlineSummary().
  source.thinkingLane?.markEnded();
  if (!source.currentTextEntryId) {
    source.currentTextEntryId = '__in_text_block__';
  }
  source.contentBuffer += chunk.content;

  if (ctx.isTTY && ctx.compositor) {
    // TTY: subagent prose is internal reasoning — never commit it to
    // parent scrollback. Surface the in-flight text as a transient
    // one-liner under the synthetic Agent row via setThinkingTail
    // (same visible slot as the thinking-tail path; content overrides
    // any stale thinking clause). The tail clears on tool_use_detail,
    // error, panel emission, or finalize. The Done summary row is the
    // only artifact that lands in the parent transcript.
    //
    // Guard: skip the setThinkingTail call for whitespace-only chunks.
    // A whitespace chunk produces an empty tail from extractLatestThinkingClause,
    // which would resolve to `undefined` and clear a freshly-installed
    // thinking-tail before any substantive text has rendered.
    if (chunk.content.trim()) {
      const cols = getTerminalWidth();
      const maxTail = capToMeasure(Math.max(20, cols - 14)); // 14 = indent + glyph budget
      const tail = extractLatestThinkingClause(source.contentBuffer, maxTail);
      // Item #6: Throttle setThinkingTail to ≥1500ms per parentId OR a
      // sentence-boundary arrival. External constraint: the gate is on
      // parentId (the overlay slot) — that's the unit that flickers.
      // Sentence boundaries bypass the timer because they signal a
      // stronger progress transition the operator should see promptly.
      const now = Date.now();
      const lastUpdate = _thinkingTailLastUpdate.get(parentId) ?? 0;
      const isSentenceBoundary = tail ? /[.!?…]$/.test(tail) : false;
      if (tail && (now - lastUpdate >= 1500 || isSentenceBoundary)) {
        _thinkingTailLastUpdate.set(parentId, now);
        ctx.toolLane.setThinkingTail(parentId, tail);
      }
    }
    // H2 fix: gate setComposedOverlay behind the same 1500ms throttle to
    // prevent driving a full CupFrameRenderer.render() on every content
    // token. Discrete state transitions (tool_use_detail, tool_result,
    // tool_diff, error, done) are NOT gated — only the high-frequency
    // streaming path. Routes through the full composed frame so the
    // orchestrator's live-thinking paragraph is preserved. (Issue #389.)
    if (ctx.orchestratorCtx) {
      const now = Date.now();
      const lastOverlay = _overlayLastUpdate.get(parentId) ?? 0;
      if (now - lastOverlay >= 1500) {
        _overlayLastUpdate.set(parentId, now);
        setComposedOverlay(ctx.orchestratorCtx);
      }
    }
  } else {
    // Non-TTY: keep the existing gutter-prefixed scrollback emission so
    // logs / CI / headless runs retain the full prose for debugging.
    // Each completed line (delimited by `\n`) flushes through
    // emitSubagentTextLines with the `│ ` gutter prefix and one level
    // of indent under the synthetic Agent entry.
    const newlineIdx = source.contentBuffer.lastIndexOf('\n');
    if (newlineIdx !== -1) {
      const ready = source.contentBuffer.slice(0, newlineIdx);
      source.contentBuffer = source.contentBuffer.slice(newlineIdx + 1);
      emitSubagentTextLines(ready, ctx);
    }
  }
  void sourceId; // explicit: sourceId unused in content path; kept for signature symmetry
}

/**
 * Handle a thinking chunk for a subagent source.
 *
 * Buffers thinking text per-source and, in 'live' mode, renders the latest
 * clause as a thinking tail under the synthetic Agent row.
 */
function handleSubagentThinkingChunk(
  chunk: Extract<MessageChunk, { type: 'thinking' }>,
  source: SourceState,
  parentId: string,
  ctx: SubagentCtx,
): void {
  // Thinking is cascaded from the orchestrator's mode. We do NOT
  // stream the raw thinking text into scrollback — that's deliberately
  // noisier than what the orchestrator itself does (which also only
  // emits a summary). Instead we:
  //   1. Buffer the thinking per-source so we can emit a single
  //      `· thought Xs · Ntok` annotation on the Done row.
  //   2. In `'live'` mode, render the latest clause as a single dim
  //      italic line under the synthetic Agent row (the "thinking
  //      tail" — see ToolEntry.thinkingTail) so the user can see the
  //      child IS doing something while the parent's spinner ticks.
  //      The tail updates in place; we never commit thinking text to
  //      scrollback.
  if (ctx.thinkingMode === 'off') return;
  if (!source.thinkingLane) source.thinkingLane = new ThinkingLane();
  source.thinkingLane.push(chunk.content);
  if (ctx.thinkingMode === 'live' && ctx.isTTY && ctx.orchestratorCtx) {
    const cols = getTerminalWidth();
    const maxTail = capToMeasure(Math.max(20, cols - 14));
    const tail = extractLatestThinkingClause(source.thinkingLane.peek(), maxTail);
    if (tail) ctx.toolLane.setThinkingTail(parentId, tail);
    // H2 fix: gate setComposedOverlay behind the same 1500ms throttle to
    // prevent driving a full CupFrameRenderer.render() on every thinking
    // token. Routes through the full composed frame so the orchestrator's
    // live-thinking paragraph is preserved. (Issue #389.)
    {
      const now = Date.now();
      const lastOverlay = _overlayLastUpdate.get(parentId) ?? 0;
      if (now - lastOverlay >= 1500) {
        _overlayLastUpdate.set(parentId, now);
        setComposedOverlay(ctx.orchestratorCtx);
      }
    }
  }
}

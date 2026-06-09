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
import type { CardSpec } from '../render.js';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import type { OverlayComposer } from './overlay-composer.js';
import {
  extractLatestThinkingClause,
  emitSubagentPanel,
  finalizeSubagent,
  emitSubagentTextLines,
  synthesizeAgentEntry,
} from './stream-renderer-subagent-helpers.js';
import { syntheticResult } from './stream-renderer-source.js';

/**
 * Context object passed to subagent event handlers. Minimal set of collaborators
 * needed for subagent rendering: compositor for overlay updates, toolLane for
 * nesting under the synthetic agent, and output writer for scrollback lines.
 */
export interface SubagentCtx {
  isTTY: boolean;
  compositor: TerminalCompositor | null;
  // Optional: production StreamRenderer always provides it; tests / non-TTY
  // omit it and overlay routing falls back to a direct setOverlay.
  overlayComposer?: OverlayComposer | null;
  toolLane: ToolLane;
  /** Where line-based output goes (non-TTY fallback + scrollback emits). */
  out: Writer;
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
  thinkingMode?: 'off' | 'summary' | 'live';
}

/**
 * Item #6 — Per-parentId debounce for setThinkingTail (content chunks).
 *
 * `setThinkingTail` is called on every content chunk, which on a fast-
 * streaming model fires ~10–50 times per second. Each call rebuilds and
 * re-renders the tool-lane overlay, causing visible flicker. This map holds
 * the timestamp of the last accepted setThinkingTail call per parentId.
 *
 * Stored at module scope (not inside the function) because
 * `handleSubagentEvent` is a free function called repeatedly across chunks
 * from the same session, and we need the timestamp to persist between calls.
 *
 * Cleaned up in `finalizeSubagent` via `_thinkingTailLastUpdate.delete(parentId)`
 * to avoid unbounded growth across many short-lived subagents in a long session.
 *
 * External constraint: the map is keyed by parentId (the visual slot in the
 * tool lane), NOT by sourceId — because parentId is the flicker unit. Two
 * sources that share a parent (rare, but possible in grandchild topologies)
 * share the same throttle budget, which is conservative but correct.
 */
const _thinkingTailLastUpdate = new Map<string, number>();

/**
 * H2 fix — Per-parentId throttle for compositor.setOverlay() calls on
 * high-frequency content and thinking chunks.
 *
 * `setOverlay` (and its downstream `repaint()`) was called on every content
 * and thinking chunk at ~50-80 Hz, driving a full CupFrameRenderer.render()
 * frame on every token. Under cursor-state drift this produces N-fold ghost
 * rows instead of in-place rewrites. Gating behind the same 1500ms window
 * already applied to `setThinkingTail` limits overlay rebuilds to ≤1 per
 * 1500ms for the streaming content/thinking paths, matching the cadence
 * the operator can meaningfully read without visible refresh.
 *
 * Discrete state transitions (tool_use_detail, tool_result, tool_diff,
 * error, finalizeSubagent done) are NOT gated — they always call setOverlay
 * immediately because each represents a real state change the user should
 * see promptly.
 *
 * Same cleanup contract as _thinkingTailLastUpdate: deleted in
 * finalizeSubagent and the error path so the map doesn't grow unboundedly.
 */
const _overlayLastUpdate = new Map<string, number>();


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
      return;

    case 'chunk': {
      const chunk = event.chunk;
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

        const cols = process.stdout.columns ?? 100;
        const maxWidth = Math.max(20, cols - 14);  // 14 = indent + glyph/spinner budget
        ctx.toolLane.addStartWithAgentContext(
          chunk.toolUseId,
          chunk.toolName,
          chunk.toolInput,
          parentId,
          maxWidth,
        );
        source.stats.toolUses += 1;
        if (ctx.isTTY) {
          if (ctx.overlayComposer) {
            ctx.overlayComposer.markDirty('tool-lane');
            ctx.overlayComposer.flush();
          } else if (ctx.compositor) {
            ctx.compositor.setOverlay(ctx.toolLane.getOverlay());
          }
        }
      } else if (chunk.type === 'tool_result') {
        const renderer = ctx.streamingMarkdown.get(sourceId);
        if (renderer) renderer.commitPending();
        ctx.toolLane.addResult(chunk.toolUseId, chunk);
        if (ctx.isTTY) {
          if (ctx.overlayComposer) {
            ctx.overlayComposer.markDirty('tool-lane');
            ctx.overlayComposer.flush();
          } else if (ctx.compositor) {
            ctx.compositor.setOverlay(ctx.toolLane.getOverlay());
          }
        }
      } else if (chunk.type === 'tool_diff') {
        // Sidecar render-only diff for a subagent's tool call. Late-attach
        // by toolUseId; no-op if the entry already flushed.
        ctx.toolLane.addDiff(chunk.toolUseId, chunk.diff);
        if (ctx.isTTY) {
          if (ctx.overlayComposer) {
            ctx.overlayComposer.markDirty('tool-lane');
            ctx.overlayComposer.flush();
          } else if (ctx.compositor) {
            ctx.compositor.setOverlay(ctx.toolLane.getOverlay());
          }
        }
      } else if (chunk.type === 'content') {
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
            const cols = process.stdout.columns ?? 100;
            const maxTail = Math.max(20, cols - 14); // 14 = indent + glyph budget
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
          // H2 fix: gate setOverlay behind the same 1500ms throttle to prevent
          // driving a full CupFrameRenderer.render() on every content token.
          // Discrete state transitions (tool_use_detail, tool_result, tool_diff,
          // error, done) are NOT gated — only the high-frequency streaming path.
          {
            const now = Date.now();
            const lastOverlay = _overlayLastUpdate.get(parentId) ?? 0;
            if (now - lastOverlay >= 1500) {
              _overlayLastUpdate.set(parentId, now);
              // Route the throttled refresh through the composer when present so
              // it recomposes ALL active slots in z-order. A direct
              // compositor.setOverlay would overwrite the single overlay region
              // with only the tool-lane, clobbering the markdown-pending /
              // stage-rail / thinking-tail slots — the OverlayComposer is the
              // sole writer of compositor.setOverlay while a turn is live (see
              // overlay-composer.ts). Falls back to direct setOverlay only when
              // no composer is wired (tests / non-TTY).
              if (ctx.overlayComposer) {
                ctx.overlayComposer.markDirty('tool-lane');
                ctx.overlayComposer.flush();
              } else {
                ctx.compositor.setOverlay(ctx.toolLane.getOverlay());
              }
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
      } else if (chunk.type === 'thinking') {
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
        // The synthetic Agent row itself is created by `process()` on the
        // very first event for a source — including this one — so a child
        // that opens with extended thinking becomes visible immediately
        // instead of disappearing behind the parent's "Decrypting…" spinner.
        if (ctx.thinkingMode === 'off') return;
        if (!source.thinkingLane) source.thinkingLane = new ThinkingLane();
        source.thinkingLane.push(chunk.content);
        if (ctx.thinkingMode === 'live' && ctx.isTTY && ctx.compositor) {
          const cols = process.stdout.columns ?? 100;
          const maxTail = Math.max(20, cols - 14);
          const tail = extractLatestThinkingClause(source.thinkingLane.peek(), maxTail);
          if (tail) ctx.toolLane.setThinkingTail(parentId, tail);
          // H2 fix: gate setOverlay behind the same 1500ms throttle to prevent
          // driving a full CupFrameRenderer.render() on every thinking token.
          {
            const now = Date.now();
            const lastOverlay = _overlayLastUpdate.get(parentId) ?? 0;
            if (now - lastOverlay >= 1500) {
              _overlayLastUpdate.set(parentId, now);
              // Route through the composer when present (see content path above)
              // so the throttled refresh never clobbers sibling overlay slots.
              if (ctx.overlayComposer) {
                ctx.overlayComposer.markDirty('tool-lane');
                ctx.overlayComposer.flush();
              } else {
                ctx.compositor.setOverlay(ctx.toolLane.getOverlay());
              }
            }
          }
        }
      }
      return;
    }

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
      {
        const errorSummary = `error — ${event.error.message}`;
        // Invariant: set BOTH `addResult` (the entry's own result) AND
        // `setAgentResultSummary` (the rendered Done/error line under the
        // Agent header). The done-path mirrors this in `finalizeSubagent`
        // (see this file ~540). Without setAgentResultSummary, the Agent
        // block renders WITHOUT a terminal summary line — the user sees
        // the in-flight tool children but no indication of how the
        // subagent ended. The scrollback commit on the renderer-side
        // ('error' branch of StreamRenderer.process) reads
        // agentResultSummary to render the block's bottom row, so the
        // omission here was the visible-error-vanishes regression.
        ctx.toolLane.setAgentResultSummary(parentId, errorSummary);
        ctx.toolLane.addResult(parentId, syntheticResult(errorSummary, true));
      }
      if (ctx.isTTY && ctx.compositor) {
        // Route through the composer when present so the error's terminal
        // overlay recomposes all slots instead of clobbering the overlay
        // region with the tool-lane alone (overlay-composer.ts invariant).
        if (ctx.overlayComposer) {
          ctx.overlayComposer.markDirty('tool-lane');
          ctx.overlayComposer.flush();
        } else {
          ctx.compositor.setOverlay(ctx.toolLane.getOverlay());
        }
      }
      return;

    case 'done':
      source.done = true;
      if (event.metadata) source.responseMetadata = event.metadata;
      finalizeSubagent(sourceId, source, ctx, _thinkingTailLastUpdate, _overlayLastUpdate);
      return;

    case 'suggestion':
      return;

    case 'panel':
      emitSubagentPanel(event.spec as CardSpec, sourceId, source, ctx);
      return;
  }
}
export { extractLatestThinkingClause, emitSubagentPanel, finalizeSubagent, synthesizeAgentEntry };
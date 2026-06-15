/**
 * Helper functions for subagent event handling in StreamRenderer.
 * Extracted from stream-renderer-subagent.ts to keep module files under 350 lines.
 *
 * @module cli/_lib/stream-renderer-subagent-helpers
 */

import type { SourceState } from './stream-renderer-source.js';
import type { SubagentCtx } from './stream-renderer-subagent.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';

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
  const maxWidth = Math.max(1, getTerminalWidth() - indent.length - 2 - 2);
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
  const cols = process.stdout.columns ?? 100;
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

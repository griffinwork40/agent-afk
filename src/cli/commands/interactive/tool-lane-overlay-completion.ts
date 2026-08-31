/**
 * Flat-root completion rendering via toolCard.
 *
 * Extracted from {@link ToolLane.getOverlay} so the component is used in the
 * primary tool-lane rendering path (not only in task-view replay).
 *
 * A "flat root" is a leaf tool (non-NESTING) that has a result and no parent
 * {@link agentContext}. In the live overlay it renders as a single collapsed
 * header line; `toolCard({ collapsed: true })` provides that line.
 *
 * The caller retains responsibility for:
 *   - prepending the `flatRootLead` / turn-root prefix (`'  '` or `'◉ '`)
 *   - appending diff-block lines when `entry.diff` is set
 *   - clamping the assembled line to the terminal width
 */

import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import type { ToolFailureClass } from '../../../agent/trace/types.js';
import { toolCard } from '../../render/tool-card.js';
import { isBenignFailure } from './tool-lane-format.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a completed flat-root tool entry as a collapsed {@link toolCard}
 * header line.
 *
 * Translates the `ToolResultChunk` lifecycle state into the {@link ToolCardSpec}
 * `status` field (`'done'` / `'error'` / `'blocked'`) and delegates all
 * badge, name, elapsed, and batch-badge rendering to the shared component.
 *
 * Returns a single ANSI line with no leading prefix (the `flatRootLead` and
 * the `clamp()` are the caller's responsibility so this function stays pure).
 *
 * @param toolName   The tool name stored on the entry (e.g. `'bash'`).
 * @param result     The settled {@link ToolResultChunk} (never `undefined`).
 * @param elapsedMs  Wall-clock milliseconds from `entry.startedAt` to now.
 * @param badge      Pre-styled batch-badge string from `batchBadge(result)`.
 * @param width      Terminal column budget (passed to toolCard, default 80).
 */
export function formatFlatRootCompletion(
  toolName: string,
  result: ToolResultChunk,
  elapsedMs: number,
  badge: string,
  width: number,
): string {
  const status = completionStatus(result.isError, result.failureClass);
  return toolCard({
    toolName,
    status,
    elapsed: elapsedMs,
    batchBadge: badge || undefined,
    collapsed: true,
    width,
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Map the `isError` / `failureClass` pair to a {@link ToolCardSpec} `status`.
 *
 * Mirrors the three-outcome logic of `doneGlyph` in tool-lane-format.ts:
 *   - success           → `'done'`
 *   - benign refusal    → `'blocked'`
 *   - genuine error     → `'error'`
 */
function completionStatus(
  isError: boolean | undefined,
  failureClass: ToolFailureClass | undefined,
): 'done' | 'error' | 'blocked' {
  if (!isError) return 'done';
  return isBenignFailure(failureClass) ? 'blocked' : 'error';
}

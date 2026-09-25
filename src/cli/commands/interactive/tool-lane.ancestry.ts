import { NESTING_TOOLS } from '../../tool-category.js';
import type { Entry, ToolEntry } from './tool-lane-render.js';

/**
 * Ancestor-chain walks over a ToolLane's entry map.
 *
 * Both helpers follow `agentContext` links upward from a starting entry. They
 * are pure functions over the map (no module state) so {@link ToolLane} keeps
 * its public surface and simply delegates.
 *
 * Invariant: every walk is capped at {@link ANCESTRY_CYCLE_CAP} steps and
 * tracks visited ids, so a corrupted graph (cycle, leaked parent link) can
 * never spin forever. In normal operation depth is bounded by
 * MAX_NESTING_DEPTH (small single digit), well under the cap. Under-counting
 * on a bad graph is preferred to hanging the render loop.
 */
const ANCESTRY_CYCLE_CAP = 32;

/**
 * Count how many ancestor tool entries of `id` are still alive in the lane.
 * Returns 0 for root entries (no agentContext) or when the chain reaches a
 * missing entry. A dangling agentContext (parent already flushed or never
 * registered) means the entry effectively renders at root.
 *
 * Used by ToolLane.flushSource to indent a subagent's committed scrollback
 * block under its still-in-flight ancestor instead of unparenting it.
 */
export function ancestorDepthOf(entries: ReadonlyMap<string, Entry>, id: string): number {
  const seen = new Set<string>([id]);
  let depth = 0;
  let current: string | undefined = id;
  while (current !== undefined && depth < ANCESTRY_CYCLE_CAP) {
    const entry = entries.get(current);
    if (!entry || entry.kind !== 'tool') break;
    const parent = entry.agentContext;
    if (parent === undefined) break;
    if (seen.has(parent)) break; // cycle, bail
    seen.add(parent);
    const parentEntry = entries.get(parent);
    if (!parentEntry || parentEntry.kind !== 'tool') break;
    depth += 1;
    current = parent;
  }
  return depth;
}

/**
 * Subagent-category tools that are in NESTING_TOOLS but do not dispatch a
 * child: they manage an existing background job. A failed control call (e.g.
 * cancelling an already-finished job) is not a failed descendant agent, so it
 * must never badge an ancestor.
 */
const NON_DISPATCH_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  'cancel_background_job',
  'send_message_to_agent',
  'get_background_job_health',
]);

/** True when `entry` is a dispatch (Agent / agent / Task / skill / compose). */
function isDispatchEntry(entry: Entry | undefined): entry is ToolEntry {
  return entry?.kind === 'tool'
    && NESTING_TOOLS.has(entry.toolName)
    && !NON_DISPATCH_CONTROL_TOOLS.has(entry.toolName);
}

/**
 * Increment `failedChildCount` on every live NESTING_TOOLS ancestor of
 * `failedId`, so the live overlay can badge each ancestor row (`⚠ N`).
 *
 * Contract: callers may invoke this for ANY errored entry. It is a no-op
 * unless `failedId` is itself a dispatch entry (a failed bash inside a
 * subagent is not a failed descendant agent), and it is idempotent per
 * failed entry via `failurePropagated`. Idempotence is load-bearing: a
 * mid-run subagent failure reaches the renderer twice for the same entry,
 * once as the subagent 'error' event and again as the dispatch's own
 * isError tool_result, and each must count once.
 *
 * Invariant: only NESTING_TOOLS entries (Agent / skill / compose / Task)
 * receive the count; leaf tools cannot act as parents so the field is never
 * set on them. Non-NESTING ancestors are walked through, not counted. The
 * walk stops when an agentContext lookup misses (already-flushed ancestor).
 */
export function propagateChildFailure(entries: ReadonlyMap<string, Entry>, failedId: string): void {
  const failed = entries.get(failedId);
  if (!isDispatchEntry(failed) || failed.failurePropagated) return;
  failed.failurePropagated = true;
  const seen = new Set<string>([failedId]);
  let cur: string | undefined = failedId;
  let depth = 0;
  while (cur !== undefined && depth < ANCESTRY_CYCLE_CAP) {
    const entry = entries.get(cur);
    if (!entry || entry.kind !== 'tool') break;
    const parentId = entry.agentContext;
    if (parentId === undefined) break;
    if (seen.has(parentId)) break; // cycle guard
    seen.add(parentId);
    const parentEntry = entries.get(parentId);
    if (parentEntry?.kind === 'tool' && NESTING_TOOLS.has(parentEntry.toolName)) {
      parentEntry.failedChildCount = (parentEntry.failedChildCount ?? 0) + 1;
    }
    cur = parentId;
    depth++;
  }
}

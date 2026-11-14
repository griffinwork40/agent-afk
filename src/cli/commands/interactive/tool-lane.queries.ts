/**
 * Read-only queries over a ToolLane's entry map, split out of `tool-lane.ts`
 * (350-code-line ceiling). The class keeps thin delegating methods, so its
 * public surface is unchanged.
 *
 * @module cli/commands/interactive/tool-lane.queries
 */

import { NESTING_TOOLS } from '../../tool-category.js';
import type { Entry } from './tool-lane-render.js';

/**
 * The toolName of the trailing completed *flat* root: the newest entry in
 * `order` that is a leaf tool with a result and no `agentContext`. Returns
 * `undefined` when that trailing root is in-flight, is a NESTING tool, or the
 * lane has no such root. See `ToolLane.peekTrailingCompletedRootToolName` for
 * the run-accumulation gate this drives.
 */
export function trailingCompletedRootToolName(
  entries: ReadonlyMap<string, Entry>,
  order: readonly string[],
): string | undefined {
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = entries.get(order[i] ?? '');
    if (!entry || entry.kind !== 'tool') continue; // skip non-tool entries
    if (entry.agentContext) continue;              // skip nested (non-root) entries
    // First flat root from the tail decides the verdict:
    if (entry.result === undefined) return undefined;        // in-flight → don't hold
    if (NESTING_TOOLS.has(entry.toolName)) return undefined; // nesting → own commit path
    return entry.toolName;
  }
  return undefined;
}

/**
 * Count the in-flight nesting children (Agent / Task / skill / compose rows
 * with no result yet) directly under `parentId`. Drives the stall checker's
 * `· awaiting N children` label: a parent whose own stream is silent only
 * because it is blocked on live child agents is not hung, so it must neither
 * read as `· waiting Xs` nor be auto-settled by the hard no-event cutoff.
 * Leaf tools are not counted — a parent waiting on a plain tool is covered by
 * that tool's own elapsed counter.
 */
export function liveChildAgentCount(
  entries: ReadonlyMap<string, Entry>,
  parentId: string,
): number {
  // O(N) scan over all lane entries per call. Called once per stalled source
  // per 80ms repaint tick; non-blocking at current scale (lane entries are
  // bounded by a single turn's tool-use depth). A future optimization could
  // maintain an O(1) parent→liveChildren index, but the complexity cost is
  // not justified until profiling shows this as a hotspot. (Issue #4357.)
  let count = 0;
  for (const entry of entries.values()) {
    if (entry.kind !== 'tool' || entry.agentContext !== parentId) continue;
    if (entry.result === undefined && NESTING_TOOLS.has(entry.toolName)) count += 1;
  }
  return count;
}

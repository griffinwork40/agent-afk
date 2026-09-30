/**
 * Read-only queries over a ToolLane's entry map, split out of `tool-lane.ts`
 * (350-code-line ceiling). The class keeps thin delegating methods, so its
 * public surface is unchanged.
 *
 * @module cli/commands/interactive/tool-lane.queries
 */

import { NESTING_TOOLS, SKILL_TOOLS } from '../../tool-category.js';
import type { Entry } from './tool-lane-render.js';

/**
 * Returns the toolUseId of the most-recent live `SKILL_TOOLS` entry in the
 * lane (scanning `order` from newest to oldest), or `undefined` if none.
 *
 * Implements `ToolLane.findLastSkillEntryId`. Extracted here to keep
 * `tool-lane.ts` within the 350-code-line ceiling.
 */
export function findLastSkillEntryId(
  entries: ReadonlyMap<string, Entry>,
  order: readonly string[],
): string | undefined {
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const entry = entries.get(id);
    if (entry?.kind === 'tool' && SKILL_TOOLS.has(entry.toolName)) {
      return id;
    }
  }
  return undefined;
}

/**
 * Count in-flight foreground subagent dispatches: NESTING_TOOLS entries
 * (agent, Task, Agent, compose, skill) that have NOT yet received a result.
 *
 * Used by the health rail to include foreground subagents in the `N/M subs`
 * count alongside the background registry's jobs (#2687). Only entries without
 * `entry.result` are in-flight; settled entries are not counted.
 */
export function countInFlightForegroundAgents(
  entries: ReadonlyMap<string, Entry>,
  order: readonly string[],
): number {
  let count = 0;
  for (const id of order) {
    const entry = entries.get(id);
    if (entry?.kind === 'tool' && NESTING_TOOLS.has(entry.toolName) && entry.result === undefined) {
      count++;
    }
  }
  return count;
}

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

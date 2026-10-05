/**
 * Flush operations for ToolLane -- extracted from tool-lane.ts.
 *
 * Exports: flushSource, flushCompletedRoots.
 * Both operate on the ToolLane's internal state via an explicit host
 * interface so they carry no module-scope state.
 */

import { NESTING_TOOLS } from '../../tool-category.js';
import {
  formatAgentSummary,
  formatAgentHeader,
  formatAgentChildren,
  renderGroupedRootTools,
  buildChildMap,
  type ToolEntry,
  type Entry,
} from './tool-lane-render.js';
import { scrollbackSeparator } from './tool-lane.scrollback-separator.js';
import { ancestorDepthOf as ancestorDepthIn } from './tool-lane.ancestry.js';

// ---------------------------------------------------------------------------
// ToolLaneFlushHost
// ---------------------------------------------------------------------------

/**
 * The ToolLane state slice the flush helpers need to read and mutate.
 * ToolLane passes `this` where this type is expected; all required members
 * are present on the class.
 */
export interface ToolLaneFlushHost {
  readonly entries: Map<string, Entry>;
  order: string[];
  readonly compactScrollback: boolean;
}

// ---------------------------------------------------------------------------
// ancestorDepthOf (private helper)
// ---------------------------------------------------------------------------

function ancestorDepthOf(entries: Map<string, Entry>, id: string): number {
  return ancestorDepthIn(entries, id);
}

// ---------------------------------------------------------------------------
// flushSource
// ---------------------------------------------------------------------------

/**
 * Flush only the entries belonging to a single source -- identified by
 * `parentId` (the synthetic Agent tool-use ID). Collects the parent entry
 * and all descendants (children + grandchildren via `agentContext`), removes
 * them from the lane, and renders via formatAgentSummary.
 *
 * See the full contract comment on ToolLane.flushSource in tool-lane.ts.
 * This function carries the implementation; ToolLane.flushSource is a
 * one-line delegator.
 */
export function flushSource(
  host: ToolLaneFlushHost,
  parentId: string,
  homeDir?: string,
): string[] {
  const parentEntry = host.entries.get(parentId);
  if (!parentEntry || parentEntry.kind !== 'tool') return [];

  // Resolve in-lane ancestor depth BEFORE deleting any entries.
  const ancestorIsLast: readonly boolean[] = Array.from(
    { length: ancestorDepthOf(host.entries, parentId) },
    () => false,
  );

  // Eager ancestor-header emission: walk from parentId upward through
  // agentContext links, collect live ancestors, emit headers for those
  // not yet committed (headerEmitted !== true), outermost first.
  const ancestorLines: string[] = [];
  {
    const chain: Array<{ entry: ToolEntry; depth: number }> = [];
    const seen = new Set<string>([parentId]);
    let cur: string | undefined = parentEntry.agentContext;
    while (cur !== undefined) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const anc = host.entries.get(cur);
      if (!anc || anc.kind !== 'tool') break;
      chain.push({ entry: anc, depth: ancestorDepthOf(host.entries, anc.toolUseId) });
      cur = anc.agentContext;
    }
    chain.reverse();
    for (const { entry: anc, depth } of chain) {
      if (anc.headerEmitted) continue;
      ancestorLines.push(formatAgentHeader(anc, Array.from({ length: depth }, () => false)));
      anc.headerEmitted = true;
    }
  }

  // Collect all descendants: walk agentContext tree breadth-first.
  const collected = new Set<string>([parentId]);
  const queue = [parentId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [id, entry] of host.entries) {
      if (collected.has(id)) continue;
      const ctx = entry.kind === 'tool' ? entry.agentContext : entry.agentContext;
      if (ctx === current) {
        collected.add(id);
        if (entry.kind === 'tool') queue.push(id);
      }
    }
  }

  // Build a child map scoped to collected entries only.
  const childMap = new Map<string, Entry[]>();
  for (const id of host.order) {
    if (!collected.has(id)) continue;
    const entry = host.entries.get(id);
    if (!entry) continue;
    const ctx = entry.kind === 'tool' ? entry.agentContext : entry.agentContext;
    if (!ctx) continue;
    let children = childMap.get(ctx);
    if (!children) {
      children = [];
      childMap.set(ctx, children);
    }
    children.push(entry);
  }

  // Render via the same path as flush(), shifted by ancestor depth.
  const children = childMap.get(parentEntry.toolUseId) ?? [];
  const childBlock = parentEntry.headerEmitted
    ? formatAgentChildren(parentEntry, children, childMap, homeDir, ancestorIsLast, host.compactScrollback).join('\n')
    : formatAgentSummary(parentEntry, children, childMap, homeDir, ancestorIsLast, host.compactScrollback);

  // Remove collected entries from the lane.
  for (const id of collected) {
    host.entries.delete(id);
  }
  host.order = host.order.filter((id) => !collected.has(id));

  const blockLines = childBlock === '' ? [] : [childBlock];
  const separator = scrollbackSeparator(ancestorIsLast.length);
  return [...ancestorLines, ...blockLines, separator];
}

// ---------------------------------------------------------------------------
// flushCompletedRoots
// ---------------------------------------------------------------------------

/**
 * Selective sibling of flush: commit ONLY root entries whose dispatch has
 * resolved (entry.result !== undefined), leaving in-flight roots (and their
 * descendants) in the lane for future calls.
 *
 * See the full contract comment on ToolLane.flushCompletedRoots in tool-lane.ts.
 */
export function flushCompletedRoots(
  host: ToolLaneFlushHost,
  homeDir?: string,
): string[] {
  if (host.entries.size === 0) return [];

  const childMap = buildChildMap(host.entries, host.order);
  const rootOrder: string[] = [];

  for (const id of host.order) {
    const entry = host.entries.get(id);
    if (!entry || entry.kind !== 'tool') continue;
    if (entry.agentContext) continue;          // not a root
    if (entry.result === undefined) continue;  // in-flight -- keep in lane
    rootOrder.push(id);
  }

  if (rootOrder.length === 0) return [];

  const lines: string[] = [];
  const groups = new Map<string, ToolEntry[]>();
  const groupOrder: string[] = [];

  for (const id of rootOrder) {
    const entry = host.entries.get(id);
    if (!entry || entry.kind !== 'tool') continue;
    const children = childMap.get(entry.toolUseId);

    if (NESTING_TOOLS.has(entry.toolName)) {
      lines.push(...renderGroupedRootTools(groups, groupOrder, homeDir));
      groups.clear();
      groupOrder.length = 0;
      if (entry.headerEmitted) {
        const closerLines = formatAgentChildren(entry, children ?? [], childMap, homeDir, [], host.compactScrollback);
        lines.push(...closerLines);
      } else {
        lines.push(formatAgentSummary(entry, children ?? [], childMap, homeDir, undefined, host.compactScrollback));
      }
    } else {
      if (!groups.has(entry.toolName)) {
        groups.set(entry.toolName, []);
        groupOrder.push(entry.toolName);
      }
      groups.get(entry.toolName)!.push(entry);
    }
  }

  lines.push(...renderGroupedRootTools(groups, groupOrder, homeDir));

  // BFS-collect each flushed root + its descendants. Only collected IDs
  // are removed; in-flight roots and their subtrees remain in the lane.
  const collected = new Set<string>(rootOrder);
  const bfsQueue = [...rootOrder];
  while (bfsQueue.length > 0) {
    const current = bfsQueue.shift()!;
    for (const [id, entry] of host.entries) {
      if (collected.has(id)) continue;
      const ctx = entry.kind === 'tool' ? entry.agentContext : entry.agentContext;
      if (ctx === current) {
        collected.add(id);
        if (entry.kind === 'tool') bfsQueue.push(id);
      }
    }
  }

  for (const id of collected) {
    host.entries.delete(id);
  }
  host.order = host.order.filter((id) => !collected.has(id));

  return lines;
}

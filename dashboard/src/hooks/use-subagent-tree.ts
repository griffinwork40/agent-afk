/**
 * Builds a hierarchical subagent tree from the flat SubagentItem array that
 * the transcript produces.
 *
 * Invariant: SubagentItem.parentId links children to parents by subagentId.
 * When a parent is not yet present (out-of-order replay), the child is
 * promoted to root — the same fallback used by SubagentTreeState in the
 * vanilla-TS frontend. In practice, lifecycle events for the parent always
 * arrive before its children because the parent starts first.
 *
 * Contract: this hook is pure derivation — it never mutates items and carries
 * no network side-effects. Call it with the `items` array from useTranscript
 * and pass the returned roots to SubagentTree for rendering.
 */

import { useMemo } from 'react';
import type { TranscriptItem } from '@/lib/ledger-adapter';
import type { SubagentItem } from '@/lib/ledger-adapter';

// ---------------------------------------------------------------------------
// Tree node type
// ---------------------------------------------------------------------------

export interface SubagentTreeNode {
  item: SubagentItem;
  children: SubagentTreeNode[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Derives the forest of subagent nodes from the flat transcript item list.
 * Returns only the root nodes; children are reachable via node.children.
 *
 * Memoized on the items array reference — re-runs only when new items arrive.
 */
export function useSubagentTree(items: TranscriptItem[]): SubagentTreeNode[] {
  return useMemo(() => buildTree(items), [items]);
}

// ---------------------------------------------------------------------------
// Tree builder (extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Build a forest from a flat list of transcript items.
 *
 * History: mirrors SubagentTreeState from src/web-server/frontend/subagent-tree.ts
 * but uses SubagentItem.subagentId / parentId instead of SubagentLifecycleEvent
 * fields — the shape is equivalent because ledger-adapter now surfaces parentId.
 */
export function buildTree(items: TranscriptItem[]): SubagentTreeNode[] {
  const nodes = new Map<string, SubagentTreeNode>();
  const roots: SubagentTreeNode[] = [];

  for (const item of items) {
    if (item.kind !== 'subagent') continue;

    const existing = nodes.get(item.subagentId);
    if (existing) {
      // Terminal event arrived after started — item was mutated in-place by
      // ledger-adapter; the node reference is already correct. Nothing to do.
      continue;
    }

    const node: SubagentTreeNode = { item, children: [] };
    nodes.set(item.subagentId, node);

    if (item.parentId) {
      const parent = nodes.get(item.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not yet seen — treat as root (see Invariant above).
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
}

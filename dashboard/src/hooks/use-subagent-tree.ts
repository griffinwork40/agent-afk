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
// Tree builder (extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Build a forest from a flat list of transcript items.
 *
 * History: originally mirrored SubagentTreeState from the removed legacy
 * vanilla-TS frontend, but uses SubagentItem.subagentId / parentId instead
 * of SubagentLifecycleEvent fields — the shape is equivalent because
 * ledger-adapter now surfaces parentId.
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

  // Second pass: re-parent any root whose parentId now resolves in `nodes`.
  // This handles out-of-order replay where a child arrived before its parent.
  const stillRoots: SubagentTreeNode[] = [];
  for (const node of roots) {
    const resolvedParent = node.item.parentId ? nodes.get(node.item.parentId) : undefined;
    if (resolvedParent) {
      resolvedParent.children.push(node);
    } else {
      stillRoots.push(node);
    }
  }

  return stillRoots;
}

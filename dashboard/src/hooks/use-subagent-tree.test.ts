import { describe, it, expect } from 'vitest';
import { buildTree } from './use-subagent-tree';
import type { TranscriptItem } from '@/lib/ledger-adapter';

// ---------------------------------------------------------------------------
// Minimal SubagentItem factory
// ---------------------------------------------------------------------------
function sa(
  subagentId: string,
  parentId?: string,
): Extract<TranscriptItem, { kind: 'subagent' }> {
  return {
    kind: 'subagent',
    id: `id-${subagentId}`,
    subagentId,
    parentId,
    status: 'succeeded',
    label: subagentId,
  };
}

describe('buildTree', () => {
  it('filters out non-subagent items', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'hello' },
      { kind: 'notice', id: 'n1', text: 'started' },
      sa('root-1'),
    ];
    const roots = buildTree(items);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.item.subagentId).toBe('root-1');
  });

  it('parent-before-child: child is nested under parent', () => {
    const items: TranscriptItem[] = [sa('parent-1'), sa('child-1', 'parent-1')];
    const roots = buildTree(items);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.item.subagentId).toBe('parent-1');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.item.subagentId).toBe('child-1');
  });

  it('child-before-parent: second pass re-parents the child', () => {
    // Out-of-order replay: child arrives before parent.
    const items: TranscriptItem[] = [sa('child-ooo', 'parent-ooo'), sa('parent-ooo')];
    const roots = buildTree(items);
    // After the second-pass re-parenting, only the parent is a root.
    expect(roots).toHaveLength(1);
    expect(roots[0]!.item.subagentId).toBe('parent-ooo');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.item.subagentId).toBe('child-ooo');
  });

  it('multiple roots when parentId is absent', () => {
    const items: TranscriptItem[] = [sa('root-a'), sa('root-b'), sa('root-c')];
    const roots = buildTree(items);
    expect(roots).toHaveLength(3);
  });

  it('deep nesting: grandchild is reachable', () => {
    const items: TranscriptItem[] = [
      sa('gp'),
      sa('p', 'gp'),
      sa('gc', 'p'),
    ];
    const roots = buildTree(items);
    expect(roots).toHaveLength(1);
    const grandparent = roots[0]!;
    expect(grandparent.children).toHaveLength(1);
    const parent = grandparent.children[0]!;
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]!.item.subagentId).toBe('gc');
  });

  it('duplicate subagentId: second item is skipped', () => {
    // ledger-adapter already mutated the first item in place; buildTree
    // does not create a second node for the same subagentId.
    const items: TranscriptItem[] = [sa('dup-1'), { ...sa('dup-1'), status: 'succeeded' }];
    const roots = buildTree(items);
    expect(roots).toHaveLength(1);
  });

  it('empty input returns empty roots', () => {
    expect(buildTree([])).toHaveLength(0);
  });
});

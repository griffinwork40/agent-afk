import { describe, expect, it } from 'vitest';
import { buildSpineTree } from './topology';
import type { TranscriptItem, ToolCallItem, SubagentItem } from '@/lib/ledger-adapter';

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<ToolCallItem> & { id: string; name: string }): ToolCallItem {
  return {
    kind: 'tool',
    id: overrides.id,
    name: overrides.name,
    toolUseId: overrides.toolUseId ?? `use-${overrides.id}`,
    status: overrides.status ?? 'ok',
    inputPreview: overrides.inputPreview,
    durationMs: overrides.durationMs,
  };
}

function makeAgent(overrides: Partial<SubagentItem> & { id: string; subagentId: string }): SubagentItem {
  return {
    kind: 'subagent',
    id: overrides.id,
    subagentId: overrides.subagentId,
    label: overrides.label ?? 'agent',
    status: overrides.status ?? 'succeeded',
    promptHead: overrides.promptHead,
    durationMs: overrides.durationMs,
    totalCostUsd: overrides.totalCostUsd,
    model: overrides.model,
    agentType: overrides.agentType,
    turnCount: overrides.turnCount,
    parentId: overrides.parentId,
    parentToolUseId: overrides.parentToolUseId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSpineTree', () => {
  it('assigns seq to every root node', () => {
    const items: TranscriptItem[] = [
      makeTool({ id: 't1', name: 'bash' }),
      makeAgent({ id: 'a1', subagentId: 'sa1' }),
    ];
    const roots = buildSpineTree(items);
    expect(roots).toHaveLength(2);
    for (const node of roots) {
      expect(typeof node.seq).toBe('number');
    }
  });

  it('sorts interleaved agent and tool roots by SSE arrival order', () => {
    // SSE order: tool0, agent1, tool2, agent3
    // Before this fix, Pass 3 pushed agents and Pass 5 pushed tools,
    // yielding [agent1, agent3, tool0, tool2] — now must be arrival order.
    const items: TranscriptItem[] = [
      makeTool({ id: 't0', name: 'read_file' }),               // pos 0
      makeAgent({ id: 'a1', subagentId: 'sa1' }),               // pos 1
      makeTool({ id: 't2', name: 'bash' }),                     // pos 2
      makeAgent({ id: 'a3', subagentId: 'sa3' }),               // pos 3
    ];
    const roots = buildSpineTree(items);
    expect(roots.map((n) => n.id)).toEqual(['t0', 'a1', 't2', 'a3']);
  });

  it('seq values reflect input position index', () => {
    const items: TranscriptItem[] = [
      makeTool({ id: 't0', name: 'bash' }),   // pos 0
      makeTool({ id: 't1', name: 'grep' }),   // pos 1
    ];
    const roots = buildSpineTree(items);
    expect(roots[0]!.seq).toBe(0);
    expect(roots[1]!.seq).toBe(1);
  });

  it('agent nested under parent subagent does not appear as a root', () => {
    // Child linked via parentId (agent → parent agent).
    const parent = makeAgent({ id: 'p', subagentId: 'sa-p' });
    const child = makeAgent({ id: 'c', subagentId: 'sa-c', parentId: 'sa-p' });
    const items: TranscriptItem[] = [parent, child];
    const roots = buildSpineTree(items);
    // Only the parent is a root; the child is nested.
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('p');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.id).toBe('c');
  });

  it('all-tools list preserves input order', () => {
    const items: TranscriptItem[] = [
      makeTool({ id: 'a', name: 'bash' }),
      makeTool({ id: 'b', name: 'grep' }),
      makeTool({ id: 'c', name: 'read_file' }),
    ];
    const roots = buildSpineTree(items);
    expect(roots.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('all-agents list preserves input order', () => {
    const items: TranscriptItem[] = [
      makeAgent({ id: 'x', subagentId: 'sx' }),
      makeAgent({ id: 'y', subagentId: 'sy' }),
    ];
    const roots = buildSpineTree(items);
    expect(roots.map((n) => n.id)).toEqual(['x', 'y']);
  });
});

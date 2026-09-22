/**
 * Unit tests for topology.ts — pure tree-builder, no DOM or React.
 *
 * Coverage:
 *   - categorizeToolName: every category + MCP prefix + unknown fallback
 *   - formatSpineDuration: <1s, seconds, minutes, boundary values
 *   - formatSpineCost: below threshold, above threshold, exact boundary
 *   - buildSpineTree: empty, tool-only, subagent parent-child, orphan
 *     re-parenting, claimed-tool dedup, root sort order, seq assignment
 */

import { describe, it, expect } from 'vitest';
import {
  categorizeToolName,
  formatSpineDuration,
  formatSpineCost,
  buildSpineTree,
} from './topology';
import type { TranscriptItem, ToolCallItem, SubagentItem } from '@/lib/ledger-adapter';

// ---------------------------------------------------------------------------
// Helpers — minimal TranscriptItem factories
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
// categorizeToolName
// ---------------------------------------------------------------------------

describe('categorizeToolName', () => {
  it('classifies read tools', () => {
    expect(categorizeToolName('read_file')).toBe('read');
    expect(categorizeToolName('glob')).toBe('read');
    expect(categorizeToolName('grep')).toBe('read');
    expect(categorizeToolName('list_directory')).toBe('read');
    expect(categorizeToolName('json_query')).toBe('read');
    expect(categorizeToolName('read_witness')).toBe('read');
    expect(categorizeToolName('search_witness')).toBe('read');
    expect(categorizeToolName('get_facet')).toBe('read');
    expect(categorizeToolName('clipboard_read')).toBe('read');
  });

  it('classifies write tools', () => {
    expect(categorizeToolName('write_file')).toBe('write');
    expect(categorizeToolName('edit_file')).toBe('write');
    expect(categorizeToolName('patch_apply')).toBe('write');
    expect(categorizeToolName('clipboard_write')).toBe('write');
    expect(categorizeToolName('procedure_write')).toBe('write');
  });

  it('classifies shell tools', () => {
    expect(categorizeToolName('bash')).toBe('shell');
    expect(categorizeToolName('test_run')).toBe('shell');
    expect(categorizeToolName('wait_for')).toBe('shell');
  });

  it('classifies agent tools', () => {
    expect(categorizeToolName('agent')).toBe('agent');
    expect(categorizeToolName('send_message_to_agent')).toBe('agent');
    expect(categorizeToolName('cancel_background_job')).toBe('agent');
  });

  it('classifies skill tools', () => {
    expect(categorizeToolName('skill')).toBe('skill');
  });

  it('classifies dag tools', () => {
    expect(categorizeToolName('compose')).toBe('dag');
  });

  it('classifies web tools', () => {
    expect(categorizeToolName('web_scrape')).toBe('web');
    expect(categorizeToolName('web_request')).toBe('web');
  });

  it('classifies browser tools', () => {
    expect(categorizeToolName('browser_open')).toBe('browser');
    expect(categorizeToolName('browser_act')).toBe('browser');
    expect(categorizeToolName('browser_observe')).toBe('browser');
    expect(categorizeToolName('browser_screenshot')).toBe('browser');
    expect(categorizeToolName('browser_close')).toBe('browser');
  });

  it('classifies MCP tools by mcp__ prefix', () => {
    expect(categorizeToolName('mcp__my_server__some_tool')).toBe('mcp');
    expect(categorizeToolName('mcp__github__create_pr')).toBe('mcp');
  });

  it('falls through to other for storage tools', () => {
    expect(categorizeToolName('memory_search')).toBe('other');
    expect(categorizeToolName('memory_update')).toBe('other');
    expect(categorizeToolName('state_get')).toBe('other');
    expect(categorizeToolName('workspace_publish')).toBe('other');
    expect(categorizeToolName('workspace_query')).toBe('other');
  });

  it('returns other for completely unknown names', () => {
    expect(categorizeToolName('totally_unknown_tool')).toBe('other');
    expect(categorizeToolName('')).toBe('other');
    expect(categorizeToolName('READ_FILE')).toBe('other'); // case-sensitive
  });
});

// ---------------------------------------------------------------------------
// formatSpineDuration
// ---------------------------------------------------------------------------

describe('formatSpineDuration', () => {
  it('returns <1s for 0 ms', () => {
    expect(formatSpineDuration(0)).toBe('<1s');
  });

  it('returns <1s for any value under 1000 ms', () => {
    expect(formatSpineDuration(1)).toBe('<1s');
    expect(formatSpineDuration(500)).toBe('<1s');
    expect(formatSpineDuration(999)).toBe('<1s');
  });

  it('returns X.Xs for exactly 1000 ms', () => {
    expect(formatSpineDuration(1000)).toBe('1.0s');
  });

  it('returns X.Xs for values in the 1-60 second range', () => {
    expect(formatSpineDuration(1500)).toBe('1.5s');
    expect(formatSpineDuration(10000)).toBe('10.0s');
    expect(formatSpineDuration(59999)).toBe('60.0s'); // toFixed rounds up
  });

  it('returns Xm Xs for values at 60 seconds', () => {
    expect(formatSpineDuration(60000)).toBe('1m 0s');
  });

  it('returns Xm Xs for values above 60 seconds', () => {
    expect(formatSpineDuration(61000)).toBe('1m 1s');
    expect(formatSpineDuration(90000)).toBe('1m 30s');
    expect(formatSpineDuration(120000)).toBe('2m 0s');
    expect(formatSpineDuration(3661000)).toBe('61m 1s');
  });

  it('truncates fractional seconds in the minutes range', () => {
    // 90500 ms → 90.5s → 1m 30s (floor, not round)
    expect(formatSpineDuration(90500)).toBe('1m 30s');
  });
});

// ---------------------------------------------------------------------------
// formatSpineCost
// ---------------------------------------------------------------------------

describe('formatSpineCost', () => {
  it('returns <$0.001 for values below the threshold', () => {
    expect(formatSpineCost(0)).toBe('<$0.001');
    expect(formatSpineCost(0.0001)).toBe('<$0.001');
    expect(formatSpineCost(0.0009999)).toBe('<$0.001');
  });

  it('returns formatted string for values at and above threshold', () => {
    expect(formatSpineCost(0.001)).toBe('$0.001');
    expect(formatSpineCost(0.0234)).toBe('$0.023');
    expect(formatSpineCost(1.5)).toBe('$1.500');
    expect(formatSpineCost(10)).toBe('$10.000');
  });
});

// ---------------------------------------------------------------------------
// buildSpineTree
// ---------------------------------------------------------------------------

describe('buildSpineTree', () => {
  it('returns an empty array for empty input', () => {
    expect(buildSpineTree([])).toEqual([]);
  });

  it('ignores non-tool/non-subagent items (user, assistant, notice)', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'hello' },
      { kind: 'assistant', id: 'a1', text: 'hi' },
      { kind: 'notice', id: 'n1', text: 'note' },
    ];
    expect(buildSpineTree(items)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // seq field
  // -------------------------------------------------------------------------

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

  it('seq values reflect input position index', () => {
    const items: TranscriptItem[] = [
      makeTool({ id: 't0', name: 'bash' }),  // pos 0
      makeTool({ id: 't1', name: 'grep' }),  // pos 1
    ];
    const roots = buildSpineTree(items);
    expect(roots[0]!.seq).toBe(0);
    expect(roots[1]!.seq).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Tool-only input — flat list
  // -------------------------------------------------------------------------

  it('returns tool-only inputs as flat root nodes', () => {
    const t1 = makeTool({ id: 't1', name: 'bash', status: 'ok' });
    const t2 = makeTool({ id: 't2', name: 'read_file', status: 'running' });
    const roots = buildSpineTree([t1, t2]);

    expect(roots).toHaveLength(2);
    expect(roots[0]!.kind).toBe('tool');
    expect(roots[0]!.label).toBe('bash');
    expect(roots[0]!.category).toBe('shell');
    expect(roots[0]!.status).toBe('ok');
    expect(roots[0]!.children).toEqual([]);
    expect(roots[1]!.kind).toBe('tool');
    expect(roots[1]!.label).toBe('read_file');
    expect(roots[1]!.status).toBe('running');
  });

  it('preserves input order for an all-tools list', () => {
    const items: TranscriptItem[] = [
      makeTool({ id: 'a', name: 'bash' }),
      makeTool({ id: 'b', name: 'grep' }),
      makeTool({ id: 'c', name: 'read_file' }),
    ];
    const roots = buildSpineTree(items);
    expect(roots.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('maps tool statuses correctly', () => {
    const ok      = makeTool({ id: 'ok', name: 'bash', status: 'ok' });
    const err     = makeTool({ id: 'err', name: 'bash', status: 'error' });
    const running = makeTool({ id: 'run', name: 'bash', status: 'running' });

    const roots = buildSpineTree([ok, err, running]);
    expect(roots[0]!.status).toBe('ok');
    expect(roots[0]!.isActive).toBe(false);
    expect(roots[1]!.status).toBe('error');
    expect(roots[1]!.isActive).toBe(false);
    expect(roots[2]!.status).toBe('running');
    expect(roots[2]!.isActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Subagent-only input
  // -------------------------------------------------------------------------

  it('returns an all-agents list preserving input order', () => {
    const items: TranscriptItem[] = [
      makeAgent({ id: 'x', subagentId: 'sx' }),
      makeAgent({ id: 'y', subagentId: 'sy' }),
    ];
    const roots = buildSpineTree(items);
    expect(roots.map((n) => n.id)).toEqual(['x', 'y']);
  });

  it('appears as a flat root when a subagent has no parentToolUseId and no parentId', () => {
    const standalone = makeAgent({ id: 's1', subagentId: 'sub-standalone' });
    const roots = buildSpineTree([standalone]);

    expect(roots).toHaveLength(1);
    expect(roots[0]!.kind).toBe('agent');
    expect(roots[0]!.children).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Subagent parent-child linking via parentToolUseId
  // -------------------------------------------------------------------------

  it('links a subagent to its parent tool node via parentToolUseId', () => {
    const agentTool = makeTool({ id: 'at1', name: 'agent', status: 'ok', toolUseId: 'use-at1' });
    const child = makeAgent({ id: 'c1', subagentId: 'sub-c1', parentToolUseId: 'use-at1', label: 'child agent' });

    const roots = buildSpineTree([agentTool, child]);

    // Only the parent tool node appears at root level; the subagent is nested.
    expect(roots).toHaveLength(1);
    const parentNode = roots[0]!;
    // Tool node is promoted to kind='agent' when claimed.
    expect(parentNode.kind).toBe('agent');
    expect(parentNode.label).toBe('agent');
    expect(parentNode.children).toHaveLength(1);
    expect(parentNode.children[0]!.kind).toBe('agent');
    expect(parentNode.children[0]!.label).toBe('child agent');
  });

  it('links a subagent to its parent via secondary parentId when parentToolUseId is absent', () => {
    const parentSub = makeAgent({ id: 'p1', subagentId: 'sa-p1', status: 'running' });
    const childSub = makeAgent({ id: 'ch1', subagentId: 'sa-ch1', parentId: 'sa-p1' });

    const roots = buildSpineTree([parentSub, childSub]);

    expect(roots).toHaveLength(1);
    const parentNode = roots[0]!;
    expect(parentNode.kind).toBe('agent');
    expect(parentNode.children).toHaveLength(1);
    expect(parentNode.children[0]!.kind).toBe('agent');
  });

  it('agent nested under parent subagent does not appear as a root', () => {
    const parent = makeAgent({ id: 'p', subagentId: 'sa-p' });
    const child = makeAgent({ id: 'c', subagentId: 'sa-c', parentId: 'sa-p' });
    const items: TranscriptItem[] = [parent, child];
    const roots = buildSpineTree(items);

    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('p');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.id).toBe('c');
  });

  // -------------------------------------------------------------------------
  // Orphan re-parenting — out-of-order SSE
  // -------------------------------------------------------------------------

  it('re-parents a subagent that arrived before its parent tool node (out-of-order SSE)', () => {
    const orphanChild = makeAgent({
      id: 'oc1',
      subagentId: 'sub-orphan',
      parentToolUseId: 'use-late',
    });
    const lateTool = makeTool({
      id: 'lt1',
      name: 'agent',
      toolUseId: 'use-late',
      status: 'ok',
    });

    // Pass the subagent BEFORE the tool in the items list.
    const roots = buildSpineTree([orphanChild as TranscriptItem, lateTool as TranscriptItem]);

    // The tool should be claimed and the orphan re-parented under it.
    expect(roots).toHaveLength(1);
    expect(roots[0]!.kind).toBe('agent');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.sourceId).toBe('sub-orphan');
  });

  it('re-parents a subagent whose parentId parent arrived later', () => {
    const orphanChild = makeAgent({ id: 'oc2', subagentId: 'sub-late-child', parentId: 'sub-late-parent' });
    const parentSub = makeAgent({ id: 'lp2', subagentId: 'sub-late-parent' });

    // Child listed first; pass 3 will orphan it; pass 4 re-parents.
    const roots = buildSpineTree([orphanChild as TranscriptItem, parentSub as TranscriptItem]);

    expect(roots).toHaveLength(1);
    const parentNode = roots.find((n) => n.sourceId === 'sub-late-parent');
    expect(parentNode).toBeDefined();
    expect(parentNode!.children).toHaveLength(1);
    expect(parentNode!.children[0]!.sourceId).toBe('sub-late-child');
  });

  it('falls back to flat root when parentToolUseId references a non-existent tool', () => {
    const orphan = makeAgent({ id: 'orph', subagentId: 'sub-orph', parentToolUseId: 'no-such-tool' });
    const roots = buildSpineTree([orphan as TranscriptItem]);

    expect(roots).toHaveLength(1);
    expect(roots[0]!.kind).toBe('agent');
  });

  // -------------------------------------------------------------------------
  // Claimed-tool correctness — the core bug fix
  // -------------------------------------------------------------------------

  it('includes a claimed tool node as a root with its subagent child', () => {
    // This is the bug that was introduced in 98b1b455: the guard
    // `if (!toolClaimedByAgent.has(t.id))` was dropping claimed tool nodes
    // (and their entire subtree) from the roots array entirely.
    const agentTool = makeTool({ id: 'ct1', name: 'agent', toolUseId: 'use-claimed' });
    const child = makeAgent({ id: 'cch1', subagentId: 'sub-claimed', parentToolUseId: 'use-claimed' });

    const roots = buildSpineTree([agentTool, child] as TranscriptItem[]);

    // Exactly one root: the claimed (promoted) tool node carrying the child.
    expect(roots).toHaveLength(1);
    expect(roots[0]!.kind).toBe('agent');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.sourceId).toBe('sub-claimed');
  });

  it('does not add a claimed tool node as a standalone childless root', () => {
    const agentTool = makeTool({ id: 'ct2', name: 'agent', toolUseId: 'use-claimed2' });
    const child = makeAgent({ id: 'cch2', subagentId: 'sub-claimed2', parentToolUseId: 'use-claimed2' });

    const roots = buildSpineTree([agentTool, child] as TranscriptItem[]);

    // Claimed tool appears exactly once as a root (promoted with its child, not duplicated).
    const toolRoots = roots.filter((n) => n.id === agentTool.id);
    expect(toolRoots).toHaveLength(1);
  });

  it('handles multiple agent tools each claiming a different subagent', () => {
    const t1 = makeTool({ id: 'mt1', name: 'agent', toolUseId: 'use-mt1' });
    const t2 = makeTool({ id: 'mt2', name: 'agent', toolUseId: 'use-mt2' });
    const s1 = makeAgent({ id: 'ms1', subagentId: 'sub-ms1', parentToolUseId: 'use-mt1', label: 'child-1' });
    const s2 = makeAgent({ id: 'ms2', subagentId: 'sub-ms2', parentToolUseId: 'use-mt2', label: 'child-2' });
    const unclaimed = makeTool({ id: 'mt3', name: 'bash', toolUseId: 'use-mt3' });

    const roots = buildSpineTree([t1, s1, t2, s2, unclaimed] as TranscriptItem[]);

    // Two claimed agent nodes + one unclaimed bash node = 3 roots.
    expect(roots).toHaveLength(3);
    const agentRoots = roots.filter((n) => n.children.length > 0);
    expect(agentRoots).toHaveLength(2);
    const bashRoot = roots.find((n) => n.label === 'bash');
    expect(bashRoot).toBeDefined();
    expect(bashRoot!.children).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Root sort order — SSE arrival order
  // -------------------------------------------------------------------------

  it('sorts interleaved agent and tool roots by SSE arrival order', () => {
    // SSE order: tool0, agent1, tool2, agent3
    // Before the fix, Pass 3 pushed agents and Pass 5 pushed tools,
    // yielding [agent1, agent3, tool0, tool2] — must now be arrival order.
    const items: TranscriptItem[] = [
      makeTool({ id: 't0', name: 'read_file' }),        // pos 0
      makeAgent({ id: 'a1', subagentId: 'sa1' }),        // pos 1
      makeTool({ id: 't2', name: 'bash' }),              // pos 2
      makeAgent({ id: 'a3', subagentId: 'sa3' }),        // pos 3
    ];
    const roots = buildSpineTree(items);
    expect(roots.map((n) => n.id)).toEqual(['t0', 'a1', 't2', 'a3']);
  });

  it('sorts roots by SSE arrival order for a tool-only list', () => {
    const first = makeTool({ id: 's1', name: 'bash' });
    const second = makeTool({ id: 's2', name: 'read_file' });
    const third = makeTool({ id: 's3', name: 'write_file' });

    const roots = buildSpineTree([first, second, third] as TranscriptItem[]);
    expect(roots[0]!.label).toBe('bash');
    expect(roots[1]!.label).toBe('read_file');
    expect(roots[2]!.label).toBe('write_file');
  });

  it('preserves arrival order when tools and subagents are interleaved', () => {
    const t1 = makeTool({ id: 'ia1', name: 'bash' });
    const s1 = makeAgent({ id: 'ia2', subagentId: 'sub-ia2', label: 'agent-A' }); // no parent → flat root
    const t2 = makeTool({ id: 'ia3', name: 'glob' });

    const roots = buildSpineTree([t1, s1, t2] as TranscriptItem[]);
    expect(roots).toHaveLength(3);
    expect(roots[0]!.label).toBe('bash');
    expect(roots[1]!.label).toBe('agent-A');
    expect(roots[2]!.label).toBe('glob');
  });

  // -------------------------------------------------------------------------
  // SpineNode field mapping
  // -------------------------------------------------------------------------

  it('copies sourceId from toolUseId for tool nodes', () => {
    const t = makeTool({ id: 'src1', name: 'bash', toolUseId: 'tuid-abc' });
    const roots = buildSpineTree([t] as TranscriptItem[]);
    expect(roots[0]!.sourceId).toBe('tuid-abc');
  });

  it('copies sourceId from subagentId for subagent nodes', () => {
    const s = makeAgent({ id: 'src2', subagentId: 'sub-xyz' });
    const roots = buildSpineTree([s] as TranscriptItem[]);
    expect(roots[0]!.sourceId).toBe('sub-xyz');
  });

  it('maps subagent statuses correctly', () => {
    const succeeded = makeAgent({ id: 'ss1', subagentId: 'sub-ss1', status: 'succeeded' });
    const failed    = makeAgent({ id: 'ss2', subagentId: 'sub-ss2', status: 'failed' });
    const cancelled = makeAgent({ id: 'ss3', subagentId: 'sub-ss3', status: 'cancelled' });
    const running   = makeAgent({ id: 'ss4', subagentId: 'sub-ss4', status: 'running' });

    const roots = buildSpineTree([succeeded, failed, cancelled, running] as TranscriptItem[]);
    expect(roots[0]!.status).toBe('ok');
    expect(roots[0]!.isActive).toBe(false);
    expect(roots[1]!.status).toBe('error');
    expect(roots[1]!.isActive).toBe(false);
    expect(roots[2]!.status).toBe('cancelled');
    expect(roots[2]!.isActive).toBe(false);
    expect(roots[3]!.status).toBe('running');
    expect(roots[3]!.isActive).toBe(true);
  });

  it('propagates optional fields from subagent items to the node', () => {
    const s = makeAgent({
      id: 'opt1',
      subagentId: 'sub-opt1',
      label: 'my-agent',
      model: 'claude-opus-4-5',
      agentType: 'research',
      durationMs: 3500,
      totalCostUsd: 0.042,
      promptHead: 'investigate the thing',
      turnCount: 7,
    });
    const roots = buildSpineTree([s] as TranscriptItem[]);
    const node = roots[0]!;
    expect(node.model).toBe('claude-opus-4-5');
    expect(node.agentType).toBe('research');
    expect(node.durationMs).toBe(3500);
    expect(node.costUsd).toBe(0.042);
    expect(node.preview).toBe('investigate the thing');
    expect(node.turnCount).toBe(7);
  });

  it('propagates optional fields from tool items to the node', () => {
    const t = makeTool({
      id: 'opt2',
      name: 'bash',
      inputPreview: 'ls -la',
      durationMs: 120,
      status: 'ok',
    });
    const roots = buildSpineTree([t] as TranscriptItem[]);
    const node = roots[0]!;
    expect(node.preview).toBe('ls -la');
    expect(node.durationMs).toBe(120);
    expect(node.category).toBe('shell');
  });
});

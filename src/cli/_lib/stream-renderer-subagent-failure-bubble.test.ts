/**
 * Wiring tests for failure bubbling through the subagent event handler.
 *
 * tool-lane-failure-bubble.test.ts covers ToolLane.propagateChildFailure in
 * isolation. These tests drive real events through handleSubagentEvent so a
 * dropped call site fails here, covering all three renderer failure signals:
 *
 *  - mid-run failure: subagent 'error' event (settleSubagentError)
 *  - pre-fork refusal: an isError tool_result for a nested dispatch whose
 *    child never started, so no 'error' event is ever emitted
 *  - mid-run failure seen twice: 'error' event AND the dispatch's isError
 *    tool_result for the same entry must count once
 */

import { describe, it, expect } from 'vitest';
import {
  synthesizeAgentEntry,
  handleSubagentEvent,
  type SubagentCtx,
} from './stream-renderer-subagent.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { stripAnsi } from '../display.js';
import type { Writer } from '../slash/types.js';
import type { StreamingMarkdownRenderer } from './stream-renderer.js';
import type { OutputEvent } from '../../agent/types.js';

function makeCtx(toolLane: ToolLane): SubagentCtx {
  const writer: Writer = { line() {}, raw() {}, success() {}, info() {}, warn() {}, error() {} };
  return {
    isTTY: false,
    compositor: null,
    toolLane,
    out: writer,
    streamingMarkdown: new Map<string, StreamingMarkdownRenderer>(),
    thinkingMode: 'summary',
  };
}

function startSource(ctx: SubagentCtx, sourceId: string, agentType: string, agentContext?: string): SourceState {
  const source = freshSourceState(sourceId);
  source.agentType = agentType;
  synthesizeAgentEntry(sourceId, source, ctx, agentContext);
  return source;
}

function toolUse(toolUseId: string, toolName: string): OutputEvent {
  return { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId, toolName, toolInput: '{}' } } as OutputEvent;
}

function toolError(toolUseId: string, content: string): OutputEvent {
  return { type: 'chunk', chunk: { type: 'tool_result', toolUseId, content, isError: true } } as OutputEvent;
}

function rowFor(lane: ToolLane, label: string): string | undefined {
  return stripAnsi(lane.getOverlay()).split('\n').find((r) => r.includes(label));
}

describe('handleSubagentEvent: failure bubbling', () => {
  it("a subagent 'error' event badges its NESTING ancestor", () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    const parent = startSource(ctx, 'src-parent', 'planner');
    // The parent subagent dispatches a nested agent; the child source merges
    // into that dispatch entry (merge path), so the child's Agent row IS
    // the nested dispatch entry.
    handleSubagentEvent(toolUse('nested-1', 'agent'), 'src-parent', parent, ctx);
    const child = startSource(ctx, 'src-child', 'verifier', 'nested-1');

    handleSubagentEvent({ type: 'error', error: new Error('boom') } as unknown as OutputEvent, 'src-child', child, ctx);

    expect(rowFor(lane, 'Agent(planner)')).toContain('⚠ 1');
  });

  it('a pre-fork refusal (isError tool_result, no error event) badges the ancestor', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    const parent = startSource(ctx, 'src-parent', 'planner');
    handleSubagentEvent(toolUse('nested-1', 'agent'), 'src-parent', parent, ctx);

    // Depth-ceiling style refusal: the child never forks, so the only
    // signal is the dispatch's own error result on the parent's stream.
    handleSubagentEvent(toolError('nested-1', 'max nesting depth reached'), 'src-parent', parent, ctx);

    expect(rowFor(lane, 'Agent(planner)')).toContain('⚠ 1');
  });

  it("counts a mid-run failure once when both the 'error' event and the isError tool_result arrive", () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    const parent = startSource(ctx, 'src-parent', 'planner');
    handleSubagentEvent(toolUse('nested-1', 'agent'), 'src-parent', parent, ctx);
    const child = startSource(ctx, 'src-child', 'verifier', 'nested-1');

    handleSubagentEvent({ type: 'error', error: new Error('boom') } as unknown as OutputEvent, 'src-child', child, ctx);
    handleSubagentEvent(toolError('nested-1', 'subagent failed: boom'), 'src-parent', parent, ctx);

    const row = rowFor(lane, 'Agent(planner)');
    expect(row).toContain('⚠ 1');
    expect(row).not.toContain('⚠ 2');
  });

  it('a failed leaf tool inside a subagent does not badge the ancestor', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    const parent = startSource(ctx, 'src-parent', 'planner');
    handleSubagentEvent(toolUse('bash-1', 'bash'), 'src-parent', parent, ctx);
    handleSubagentEvent(toolError('bash-1', 'exit 1'), 'src-parent', parent, ctx);

    expect(stripAnsi(lane.getOverlay())).not.toContain('⚠');
  });
});

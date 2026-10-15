/**
 * processEvent routing for the wait_for queue-to-stop hint: only the ROOT
 * session's wait_for may set the flag, because a subagent's wait_for has no
 * user-attention probe and never yields to a queued message. A hint driven by a
 * subagent wait would tell the user something false.
 */

import { describe, expect, it, vi } from 'vitest';
import { processEvent, type ProcessCtx } from './stream-renderer-process.js';
import { InFlightToolTracker } from '../input/work-derived-verb.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { createStageTracker } from '../commands/interactive/loop-stage.js';
import { CommitCoordinator } from './commit-coordinator.js';
import { ChildActivityTracker } from './child-activity-select.js';
import type { OutputEvent } from '../../agent/types.js';
import type { Writer } from '../slash/types.js';
import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';

const writer: Writer = {
  line() {}, raw() {}, success() {}, info() {}, warn() {}, error() {},
};

function makeCtx() {
  const setRootWaitActive = vi.fn();
  const compositor = { setActiveToolName: vi.fn(), setRootWaitActive } as unknown as ProcessCtx['compositor'];
  const toolLane = new ToolLane();
  const thinkingLane = new ThinkingLane();
  const streamingMarkdownRef = { current: null };
  const lastProgressByTask = new Map();
  const ctx: ProcessCtx = {
    out: writer,
    isTTY: false,
    compositor,
    overlayComposer: null,
    toolLane,
    thinkingLane,
    streamingMarkdownRef,
    stageTracker: createStageTracker(),
    coordinator: new CommitCoordinator(),
    childActivity: new ChildActivityTracker(),
    inFlightTools: new InFlightToolTracker(),
    rootTools: new InFlightToolTracker(),
    sources: new Map(),
    subagentMarkdown: new Map(),
    lastProgressByTask,
    thinkingMode: 'off',
    activeSkillName: undefined,
    onStageChange: undefined,
    // Non-TTY orchestrator ctx: compositor null so handlers take the line path.
    buildOrchestratorCtx: (): OrchestratorCtx => ({
      out: writer,
      isTTY: false,
      compositor: null,
      toolLane,
      thinkingLane,
      thinkingMode: 'off',
      streamingMarkdown: streamingMarkdownRef,
      lastProgressByTask,
    }),
  };
  return { ctx, setRootWaitActive };
}

const start = (id: string, toolName: string): OutputEvent => ({
  type: 'chunk',
  chunk: { type: 'tool_use_detail', toolUseId: id, toolName, toolInput: '{}' },
});
const done = (id: string): OutputEvent => ({
  type: 'chunk',
  chunk: { type: 'tool_result', toolUseId: id, content: 'ok', isError: false },
});

describe('processEvent: wait_for hint flag', () => {
  it('sets the flag for a root wait_for and clears it on the result', () => {
    const { ctx, setRootWaitActive } = makeCtx();
    processEvent(ctx, start('w1', 'wait_for'));
    expect(setRootWaitActive).toHaveBeenLastCalledWith(true);
    processEvent(ctx, done('w1'));
    expect(setRootWaitActive).toHaveBeenLastCalledWith(false);
  });

  it('ignores a subagent wait_for entirely', () => {
    const { ctx, setRootWaitActive } = makeCtx();
    const meta = { subagentId: 'child-1', agentType: 'research-agent' } as Parameters<typeof processEvent>[2];
    processEvent(ctx, start('cw', 'wait_for'), meta);
    expect(setRootWaitActive).not.toHaveBeenCalled();
    expect(ctx.rootTools.has('wait_for')).toBe(false);
    // The session-wide verb tracker still sees it (it spans subagents on purpose).
    expect(ctx.inFlightTools.has('wait_for')).toBe(true);
  });
});

describe('StreamRenderer.dispose: wait_for hint flag', () => {
  it('clears the flag on a borrowed compositor so an aborted turn cannot leave it stale', async () => {
    const { StreamRenderer } = await import('./stream-renderer.js');
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const setRootWaitActive = vi.fn();
    // Simulate an armed compositor whose turn is aborted mid-wait.
    (r as unknown as { compositor: unknown }).compositor = {
      setRootWaitActive,
      setActiveToolName: vi.fn(),
      setOverlay: vi.fn(),
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
      isArmed: () => true,
      disarm: vi.fn(),
      getBuffer: () => ({ text: '', queued: false }),
    };
    await r.dispose();
    expect(setRootWaitActive).toHaveBeenCalledWith(false);
  });
});

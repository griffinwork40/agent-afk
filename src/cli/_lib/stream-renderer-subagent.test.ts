/**
 * Direct unit tests for synthesizeAgentEntry — covering both branches:
 *
 * 1. **Merge path**: agentContext points to an existing `agent`/`Task` entry
 *    → mutate in place via ToolLane.mergeAgentLabel, no new synthetic entry.
 * 2. **Fallback path**: agentContext is undefined OR points to a non-
 *    SUBAGENT_TOOLS entry (compose/skill/already-merged Agent)
 *    → create a fresh `__synth_agent_<sourceId>` entry as before.
 *
 * Both branches were previously untested at the unit level — only the
 * fallback path was incidentally exercised by upstream integration tests
 * (visibility, ordering), and the merge path had zero coverage at all.
 */

import { describe, it, expect, vi } from 'vitest';
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
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { OutputEvent } from '../../agent/types.js';

interface MakeCtxOptions {
  isTTY?: boolean;
  compositor?: TerminalCompositor | null;
  out?: Writer;
}

function makeCtx(toolLane: ToolLane, opts: MakeCtxOptions = {}): SubagentCtx {
  const writer: Writer = opts.out ?? {
    line() {},
    raw() {},
    success() {},
    info() {},
    warn() {},
    error() {},
  };
  return {
    isTTY: opts.isTTY ?? false,
    compositor: opts.compositor ?? null,
    toolLane,
    out: writer,
    streamingMarkdown: new Map<string, StreamingMarkdownRenderer>(),
    thinkingMode: 'summary',
  };
}

/** Access ToolLane's internal entries map for assertion. */
function getEntries(lane: ToolLane): Map<string, { kind: string; toolName?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (lane as any).entries as Map<string, { kind: string; toolName?: string }>;
}

describe('synthesizeAgentEntry — merge path vs fallback path', () => {
  // H6.1 — Merge path: parent is an original 'agent' dispatch.
  it('mutates an existing "agent" parent entry in place (no synthetic child)', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);

    // The orchestrator emits a raw `agent` tool dispatch first
    lane.addStart('dispatch-1', 'agent', '("analyze repo")');

    const source: SourceState = freshSourceState('pragmatist');
    synthesizeAgentEntry('sub-A', source, ctx, 'dispatch-1');

    // syntheticAgentToolUseId must equal the existing dispatch id
    // (proves the merge path was taken — no fresh __synth_agent_ key).
    expect(source.syntheticAgentToolUseId).toBe('dispatch-1');

    const entries = getEntries(lane);
    // No synthetic child was created
    expect(entries.has('__synth_agent_sub-A')).toBe(false);
    // The original entry was mutated to display as 'Agent'
    const merged = entries.get('dispatch-1') as { toolName?: string; toolInput?: string };
    expect(merged.toolName).toBe('Agent');
    expect(merged.toolInput).toBe('(pragmatist)');

    // Overlay reflects the label
    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('Agent');
    expect(overlay).toContain('pragmatist');
    // The original 'agent' display should be gone (only the Agent label)
    expect(overlay).not.toContain('agent("analyze');
  });

  // H6.2 — Merge path: 'Task' parent (the other SUBAGENT_TOOLS member).
  it('mutates an existing "Task" parent entry in place', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    lane.addStart('task-1', 'Task', '("do thing")');

    const source: SourceState = freshSourceState('worker');
    synthesizeAgentEntry('sub-B', source, ctx, 'task-1');

    expect(source.syntheticAgentToolUseId).toBe('task-1');
    expect(getEntries(lane).has('__synth_agent_sub-B')).toBe(false);
    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('worker');
  });

  // H6.3 — Fallback path: agentContext undefined → create synthetic child.
  it('creates a synthetic entry when agentContext is undefined', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);

    const source: SourceState = freshSourceState('researcher');
    synthesizeAgentEntry('sub-C', source, ctx, undefined);

    expect(source.syntheticAgentToolUseId).toBe('__synth_agent_sub-C');
    const entries = getEntries(lane);
    expect(entries.has('__synth_agent_sub-C')).toBe(true);
    const synth = entries.get('__synth_agent_sub-C') as { toolName?: string };
    expect(synth.toolName).toBe('Agent');

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('Agent');
    expect(overlay).toContain('researcher');
  });

  // H6.4 — Fallback path: parent is 'compose' (not in SUBAGENT_TOOLS).
  // mergeAgentLabel returns false → we create the synthetic child.
  it('creates a synthetic entry when parent toolName is not in SUBAGENT_TOOLS (e.g. compose)', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    // Compose dispatch — owns children but is NOT in SUBAGENT_TOOLS
    lane.addStartWithAgentContext('compose-1', 'compose', '(3 nodes)', undefined);

    const source: SourceState = freshSourceState('node-A');
    synthesizeAgentEntry('sub-D', source, ctx, 'compose-1');

    // Synthetic child is created and assigned compose-1 as its agentContext.
    expect(source.syntheticAgentToolUseId).toBe('__synth_agent_sub-D');
    const entries = getEntries(lane);
    expect(entries.has('__synth_agent_sub-D')).toBe(true);
    // compose-1 was NOT mutated (still 'compose', not 'Agent')
    const compose = entries.get('compose-1') as { toolName?: string };
    expect(compose.toolName).toBe('compose');
  });

  // H6.5 — Fallback path: parent is already-merged 'Agent' (grandchild case).
  // mergeAgentLabel rejects the merge to prevent overwriting an existing
  // merged label; we fall back to synthetic-child creation.
  it('creates a synthetic entry when parent is already merged to "Agent" (grandchild)', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);

    // Simulate a parent that's already been merge-labelled by a previous
    // synthesizeAgentEntry call.
    lane.addStartWithAgentContext('parent-agent', 'Agent', '(parent-label)', undefined);

    const source: SourceState = freshSourceState('grandchild-label');
    synthesizeAgentEntry('sub-E', source, ctx, 'parent-agent');

    // Must NOT overwrite 'parent-agent'; must create a synthetic child.
    expect(source.syntheticAgentToolUseId).toBe('__synth_agent_sub-E');
    expect(getEntries(lane).has('__synth_agent_sub-E')).toBe(true);

    const parentEntry = getEntries(lane).get('parent-agent') as { toolInput?: string };
    expect(parentEntry.toolInput).toBe('(parent-label)'); // unchanged
  });

  // Idempotency — calling synthesizeAgentEntry twice for the same source
  // must be a no-op on the second call (the syntheticAgentToolUseId guard
  // at the top of the function fires).
  it('is idempotent: a second call for the same source is a no-op', () => {
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    lane.addStart('dispatch-2', 'agent', '("first task")');

    const source: SourceState = freshSourceState('worker');
    synthesizeAgentEntry('sub-F', source, ctx, 'dispatch-2');
    const firstOverlay = stripAnsi(lane.getOverlay());

    // Second call should not modify anything (early return on
    // source.syntheticAgentToolUseId).
    synthesizeAgentEntry('sub-F', source, ctx, 'dispatch-2');
    expect(stripAnsi(lane.getOverlay())).toBe(firstOverlay);
  });

  // M6 regression — the merge path must pass `maxWidth` so the merged
  // entry's prefix is truncated for narrow-terminal rendering. Without
  // this, the Agent label is stored unbounded.
  it('passes maxWidth to mergeAgentLabel so the prefix is truncated', () => {
    // We can't directly read maxWidth, but we can verify the merge prefix
    // is bounded by an upper limit consistent with process.stdout.columns.
    const lane = new ToolLane();
    const ctx = makeCtx(lane);
    lane.addStart('dispatch-3', 'agent', '("x")');

    const longLabel = 'a-very-long-agent-label-that-would-overflow-a-narrow-terminal-many-times-over-' + 'x'.repeat(200);
    const source: SourceState = freshSourceState(longLabel);
    synthesizeAgentEntry('sub-G', source, ctx, 'dispatch-3');

    const entries = getEntries(lane);
    const merged = entries.get('dispatch-3') as { prefix: string };
    // The prefix must be bounded — the raw label was 280+ chars; the
    // merged prefix shouldn't be radically larger than the resolved
    // terminal width (cols ?? 100; max(20, cols-14) → typically 86-186).
    const visiblePrefix = stripAnsi(merged.prefix);
    expect(visiblePrefix.length).toBeLessThan(longLabel.length);
  });
});

// ─── TTY-path coverage (M-6) ─────────────────────────────────────────────────
//
// The 7 tests above hard-code isTTY:false; the TTY branches in
// handleSubagentEvent (setOverlay calls on every event type) and the
// emitSubagentTextLines early-return at line ~111 of the source were
// previously uncovered. The two tests below pin the load-bearing boundary.

describe('handleSubagentEvent — TTY path (M-6)', () => {
  function makeCompositor(): TerminalCompositor {
    return {
      setOverlay: vi.fn(),
      commitAbove: vi.fn(),
    } as unknown as TerminalCompositor;
  }

  it('calls compositor.setOverlay after a tool_use_detail chunk on TTY', () => {
    const lane = new ToolLane();
    const compositor = makeCompositor();
    const ctx = makeCtx(lane, { isTTY: true, compositor });

    const source: SourceState = freshSourceState('sub-tty');
    source.agentType = 'verifier';
    synthesizeAgentEntry('src-tty', source, ctx, undefined);

    const event: OutputEvent = {
      type: 'chunk',
      chunk: {
        type: 'tool_use_detail',
        toolUseId: 'tu-tty-1',
        toolName: 'Bash',
        toolInput: '{"command":"ls"}',
      },
    } as OutputEvent;

    handleSubagentEvent(event, 'src-tty', source, ctx);

    expect(compositor.setOverlay).toHaveBeenCalled();
    // The overlay must mention the new tool — invariant: TTY branch wires
    // through to the compositor with the latest tool-lane content.
    const firstCall = (compositor.setOverlay as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall).toBeDefined();
    const overlayArg = firstCall?.[0] as string;
    expect(stripAnsi(overlayArg)).toContain('Bash');
  });

  it('does NOT write to ctx.out on a content chunk on TTY (emitSubagentTextLines early-returns)', () => {
    const lane = new ToolLane();
    const compositor = makeCompositor();
    const lineSpy = vi.fn();
    const ctx = makeCtx(lane, {
      isTTY: true,
      compositor,
      out: {
        line: lineSpy,
        raw: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const source: SourceState = freshSourceState('sub-tty2');
    source.agentType = 'verifier';
    synthesizeAgentEntry('src-tty2', source, ctx, undefined);

    const event: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'content', content: 'some subagent prose' },
    } as OutputEvent;

    handleSubagentEvent(event, 'src-tty2', source, ctx);

    // Subagent prose must NEVER reach parent scrollback on TTY — it's
    // routed to the transient thinking-tail overlay instead.
    expect(lineSpy).not.toHaveBeenCalled();
  });
});

// ── Item #6: thinking-tail throttle (≥1500ms gate) ───────────────────────────
//
// setThinkingTail should only be called when:
//   (a) ≥1500ms have elapsed since the last update for that parentId, OR
//   (b) the new tail ends with a sentence terminator (. ! ? …)
//
// The test uses vi.useFakeTimers() so we can advance time without real waits.
describe('handleSubagentEvent — thinking-tail throttle (Item #6)', () => {
  function makeCompositor(): TerminalCompositor {
    return {
      setOverlay: vi.fn(),
      commitAbove: vi.fn(),
    } as unknown as TerminalCompositor;
  }

  it('calls setThinkingTail on first content chunk (no prior timestamp)', () => {
    vi.useFakeTimers();
    try {
      const lane = new ToolLane();
      const setThinkingTailSpy = vi.spyOn(lane, 'setThinkingTail');
      const compositor = makeCompositor();
      const ctx = makeCtx(lane, { isTTY: true, compositor });

      const source: SourceState = freshSourceState('throttle-test-1');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-throttle-1', source, ctx, undefined);

      // First chunk — should fire immediately (no prior update).
      const event: OutputEvent = {
        type: 'chunk',
        chunk: { type: 'content', content: 'I am thinking about this problem. ' },
      } as OutputEvent;
      handleSubagentEvent(event, 'src-throttle-1', source, ctx);

      // setThinkingTail should have been called at least once.
      const tailCalls = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === source.syntheticAgentToolUseId && val !== undefined,
      );
      expect(tailCalls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses setThinkingTail calls within 1500ms window (no sentence boundary)', () => {
    vi.useFakeTimers();
    try {
      const lane = new ToolLane();
      const setThinkingTailSpy = vi.spyOn(lane, 'setThinkingTail');
      const compositor = makeCompositor();
      const ctx = makeCtx(lane, { isTTY: true, compositor });

      const source: SourceState = freshSourceState('throttle-test-2');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-throttle-2', source, ctx, undefined);

      const parentId = source.syntheticAgentToolUseId!;

      // First chunk — fires (no prior timestamp).
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'First clause here' } } as OutputEvent,
        'src-throttle-2', source, ctx,
      );

      const afterFirst = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;
      expect(afterFirst).toBeGreaterThan(0);

      // Advance only 500ms — still within the 1500ms gate.
      vi.advanceTimersByTime(500);

      // Second chunk — should NOT fire (500ms < 1500ms, not a sentence boundary).
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: ' more words without ending' } } as OutputEvent,
        'src-throttle-2', source, ctx,
      );

      const afterSecond = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;
      // No new non-undefined calls were added.
      expect(afterSecond).toBe(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows setThinkingTail after 1500ms have elapsed', () => {
    vi.useFakeTimers();
    try {
      const lane = new ToolLane();
      const setThinkingTailSpy = vi.spyOn(lane, 'setThinkingTail');
      const compositor = makeCompositor();
      const ctx = makeCtx(lane, { isTTY: true, compositor });

      const source: SourceState = freshSourceState('throttle-test-3');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-throttle-3', source, ctx, undefined);

      const parentId = source.syntheticAgentToolUseId!;

      // First chunk.
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'Initial thought here' } } as OutputEvent,
        'src-throttle-3', source, ctx,
      );
      const afterFirst = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;

      // Advance past the 1500ms gate.
      vi.advanceTimersByTime(1600);

      // Second chunk — should fire now (1600ms ≥ 1500ms).
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: ' continued thought after gate' } } as OutputEvent,
        'src-throttle-3', source, ctx,
      );
      const afterSecond = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;
      expect(afterSecond).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bypasses the 1500ms gate when tail ends with a sentence terminator', () => {
    vi.useFakeTimers();
    try {
      const lane = new ToolLane();
      const setThinkingTailSpy = vi.spyOn(lane, 'setThinkingTail');
      const compositor = makeCompositor();
      const ctx = makeCtx(lane, { isTTY: true, compositor });

      const source: SourceState = freshSourceState('throttle-test-4');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-throttle-4', source, ctx, undefined);

      const parentId = source.syntheticAgentToolUseId!;

      // First chunk to set initial timestamp.
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'Some thought so far' } } as OutputEvent,
        'src-throttle-4', source, ctx,
      );
      const afterFirst = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;

      // Only 100ms later — within the gate window.
      vi.advanceTimersByTime(100);

      // But this chunk ends with a sentence boundary → should bypass the gate.
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: ' The answer is clear.' } } as OutputEvent,
        'src-throttle-4', source, ctx,
      );
      const afterBoundary = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;
      // Sentence boundary bypassed the gate → new call was made.
      expect(afterBoundary).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Item #6 follow-up: error-path cleanup ────────────────────────────────
  //
  // The `case 'error'` branch in handleSubagentEvent sets source.errored=true
  // and returns without invoking finalizeSubagent (which short-circuits on
  // `source.errored`). Without an explicit delete on the error path, the
  // _thinkingTailLastUpdate entry would persist for every errored subagent.
  //
  // We can't directly read the module-scope map, so observe behavior: after
  // an error event clears the entry, a subsequent content chunk for a fresh
  // source that shares the same parentId should fire immediately (treating
  // it as a first-call, lastUpdate=0), not be suppressed by a stale stamp.
  it('deletes the throttle entry on the error path so a stale timestamp cannot suppress a later first-call', () => {
    vi.useFakeTimers();
    try {
      const lane = new ToolLane();
      const setThinkingTailSpy = vi.spyOn(lane, 'setThinkingTail');
      const compositor = makeCompositor();
      const ctx = makeCtx(lane, { isTTY: true, compositor });

      // Set up the first source and seed the throttle timestamp.
      const source1: SourceState = freshSourceState('errored-source');
      source1.agentType = 'verifier';
      synthesizeAgentEntry('src-err-1', source1, ctx, undefined);
      const parentId = source1.syntheticAgentToolUseId!;

      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'Initial thought here' } } as OutputEvent,
        'src-err-1', source1, ctx,
      );

      // Sanity: first content chunk fired (timestamp is now set in the map).
      const afterFirst = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;
      expect(afterFirst).toBeGreaterThan(0);

      // Error event — should delete the entry.
      handleSubagentEvent(
        { type: 'error', error: new Error('rate limited') } as unknown as OutputEvent,
        'src-err-1', source1, ctx,
      );

      // Advance only 100ms — well within the 1500ms gate. If the error path
      // failed to delete, this next chunk's lastUpdate lookup would return
      // the seeded timestamp and the chunk would be suppressed.
      vi.advanceTimersByTime(100);

      // Fresh source for the second run, but synthesize against the SAME
      // parentId (simulates parentId reuse — grandchild topology or merge
      // path). If the map entry leaked, this content chunk would be gated.
      const source2: SourceState = freshSourceState('errored-source-reuse');
      source2.agentType = 'verifier';
      // Manually set the synthetic id to match — this mirrors what the merge
      // path does when reusing a real toolUseId across subagent runs.
      source2.syntheticAgentToolUseId = parentId;

      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'New run after error here' } } as OutputEvent,
        'src-err-1-reuse', source2, ctx,
      );

      const afterReuse = setThinkingTailSpy.mock.calls.filter(
        ([id, val]) => id === parentId && val !== undefined,
      ).length;
      // The reused-parentId chunk fired because cleanup wiped the stale
      // timestamp on the error path.
      expect(afterReuse).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});

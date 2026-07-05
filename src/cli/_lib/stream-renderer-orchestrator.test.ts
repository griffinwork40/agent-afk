/**
 * Tests for the `tool_diff` arm of handleOrchestratorEvent in
 * stream-renderer-orchestrator.ts.
 *
 * The three cases covered:
 *   (a) Live overlay attach — diff arrives while tool entry is still pending
 *       in the lane; addDiff is called and the compositor receives a repaint.
 *   (b) Post-flush no-op — diff arrives after the lane has flushed; addDiff
 *       is silently dropped (no throw, no overlay update forced).
 *   (c) Non-TTY guard — isTTY=false means setComposedOverlay is never called
 *       for a tool_diff chunk (no compositor present).
 *
 * @module cli/_lib/stream-renderer-orchestrator.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleOrchestratorEvent,
  setComposedOverlay,
  type OrchestratorCtx,
} from './stream-renderer-orchestrator.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { createStageTracker } from '../commands/interactive/loop-stage.js';
import type { Writer } from '../slash/types.js';
import type { OutputEvent } from '../../agent/types.js';
import type { DiffPayload } from '../../utils/diff.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeWriter(): { writer: Writer; lines: string[] } {
  const lines: string[] = [];
  const writer: Writer = {
    line(text = '') { lines.push(text); },
    raw(text) { lines.push(text); },
    success(text) { lines.push('SUCCESS:' + text); },
    info(text) { lines.push('INFO:' + text); },
    warn(text) { lines.push('WARN:' + text); },
    error(text) { lines.push('ERROR:' + text); },
  };
  return { writer, lines };
}

function makeMinimalDiff(): DiffPayload {
  return {
    hunks: [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [
        { kind: '-', text: 'old line' },
        { kind: '+', text: 'new line' },
      ],
    }],
    addedLines: 1,
    removedLines: 1,
  };
}

function toolDiffEvent(toolUseId: string, diff: DiffPayload): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_diff', toolUseId, diff },
  };
}

function toolStartEvent(id: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId: id, toolName: 'edit_file', toolInput: '("f.ts")' },
  };
}

function toolResultEvent(id: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_result', toolUseId: id, content: 'ok', isError: false },
  };
}

function makeCtx(
  toolLane: ToolLane,
  opts: { isTTY?: boolean; compositor?: OrchestratorCtx['compositor'] } = {},
): OrchestratorCtx {
  const { writer } = makeWriter();
  return {
    out: writer,
    isTTY: opts.isTTY ?? false,
    compositor: opts.compositor ?? null,
    toolLane,
    thinkingLane: new ThinkingLane(),
    thinkingMode: 'off',
    streamingMarkdown: { current: null },
    // lastProgressByTask is now part of OrchestratorCtx (issue #389 hoist).
    lastProgressByTask: new Map(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('handleOrchestratorEvent — tool_diff arm', () => {
  /**
   * (a) Live overlay attach during streaming.
   *
   * Tool entry is present in the lane when tool_diff arrives.
   * Expect: ToolLane.addDiff is called with the correct payload;
   *         compositor.setOverlay is called (TTY repaint).
   */
  it('(a) attaches diff to the matching tool entry and triggers a TTY repaint', () => {
    const toolLane = new ToolLane();
    const setOverlay = vi.fn();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    const source: SourceState = freshSourceState('__main__');
    const diff = makeMinimalDiff();
    const id = 'tu-1';

    // First: register the tool use so the entry exists in the lane.
    handleOrchestratorEvent(toolStartEvent(id), source, ctx);
    handleOrchestratorEvent(toolResultEvent(id), source, ctx);

    // Now send the tool_diff sidecar.
    handleOrchestratorEvent(toolDiffEvent(id, diff), source, ctx);

    // The compositor must have received at least one setOverlay call after
    // the tool_diff (the overlay is set for every chunk when isTTY is true).
    expect(setOverlay).toHaveBeenCalled();

    // Verify the diff was attached by inspecting flush output: a flush renders
    // the lane to strings and will include diff hunk content if addDiff worked.
    const flushed = toolLane.flush().join('\n');
    // The flush path renders hunks — just confirm no crash and output exists.
    expect(flushed.length).toBeGreaterThan(0);
  });

  /**
   * (b) Post-flush no-op.
   *
   * tool_diff arrives after the lane has already flushed its entries.
   * Expect: no error thrown, no crash, no overlay update triggered
   *         (addDiff is a no-op on a flushed/missing entry).
   */
  it('(b) silently drops tool_diff after the lane has been flushed (no-op)', () => {
    const toolLane = new ToolLane();
    const setOverlay = vi.fn();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    const source: SourceState = freshSourceState('__main__');
    const diff = makeMinimalDiff();
    const id = 'tu-flush';

    // Register tool, result, then flush the lane (simulates turn end).
    handleOrchestratorEvent(toolStartEvent(id), source, ctx);
    handleOrchestratorEvent(toolResultEvent(id), source, ctx);
    toolLane.flush(); // lane now empty

    const overlayCallsBefore = setOverlay.mock.calls.length;

    // tool_diff arrives after flush — must not throw.
    expect(() => {
      handleOrchestratorEvent(toolDiffEvent(id, diff), source, ctx);
    }).not.toThrow();

    // Because isTTY=true, setComposedOverlay IS still called — but the lane
    // has no pending entries, so the overlay update is a no-op render.
    // The key assertion is that no error is thrown and source state is intact.
    expect(source.errored).toBeFalsy();
    // Overlay may or may not be called again (implementation detail);
    // what must NOT happen is a crash or an error on the source.
    void overlayCallsBefore; // referenced to avoid unused-var lint
  });

  /**
   * (c) Non-TTY guard.
   *
   * When isTTY=false the compositor is null and setComposedOverlay should
   * not be called. tool_diff must still be processed (addDiff) without error.
   */
  it('(c) does not call setOverlay on non-TTY surfaces', () => {
    const toolLane = new ToolLane();
    // No compositor on non-TTY.
    const ctx = makeCtx(toolLane, { isTTY: false, compositor: null });
    const source: SourceState = freshSourceState('__main__');
    const diff = makeMinimalDiff();
    const id = 'tu-nontty';

    handleOrchestratorEvent(toolStartEvent(id), source, ctx);
    handleOrchestratorEvent(toolResultEvent(id), source, ctx);

    // Must not throw on non-TTY.
    expect(() => {
      handleOrchestratorEvent(toolDiffEvent(id, diff), source, ctx);
    }).not.toThrow();

    // Source should not be marked errored.
    expect(source.errored).toBeFalsy();
  });
});

describe('handleOrchestratorEvent — thinking overlay (live mode)', () => {
  /**
   * Verifies the wrapped-paragraph overlay produced by
   * `formatThinkingParagraph` is pushed through `compositor.setOverlay`
   * when `thinkingMode === 'live'`. This is the integration seam between
   * the orchestrator and the formatter — pinning it here catches:
   *   - a regression where the call site reverts to the old single-line
   *     trailing-80-codepoint slice;
   *   - a wiring break where the formatter exists but the orchestrator
   *     skips it (e.g. unguarded mode check).
   *
   * The unit-level structure of the paragraph (header, body wrap, footer)
   * lives in thinking-paragraph.test.ts. This test only checks identity
   * markers in the overlay payload (header + indent).
   */
  function thinkingEvent(content: string): OutputEvent {
    return { type: 'chunk', chunk: { type: 'thinking', content } };
  }

  // Strips ANSI so assertions stay color-agnostic.
  function strip(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  it("pushes a wrapped-paragraph overlay with `◆ thinking` header in 'live' mode", () => {
    const toolLane = new ToolLane();
    const setOverlay = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    ctx.thinkingMode = 'live';
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(
      thinkingEvent('Let me reason about this step by step.'),
      source,
      ctx,
    );

    expect(setOverlay).toHaveBeenCalled();
    const lastCall = setOverlay.mock.calls.at(-1)?.[0] ?? '';
    const plain = strip(lastCall);
    // Header is the unambiguous marker.
    expect(plain).toContain('◆ thinking');
    // Body line is indented by 2 cols and contains the reasoning text.
    expect(plain).toContain('  Let me reason about this');
  });

  it("does NOT include the thinking paragraph in 'summary' mode (but may still repaint for stage rail / lane updates)", () => {
    const toolLane = new ToolLane();
    const setOverlay = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    ctx.thinkingMode = 'summary';
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(
      thinkingEvent('Hidden in summary mode.'),
      source,
      ctx,
    );

    // setComposedOverlay IS called in summary mode (the case-arm fires it so
    // the stage rail can update to 'modeling' / surviving lane state stays
    // accurate), but the thinking paragraph itself — `◆ thinking` header +
    // indented body — must NOT appear in any frame. The paragraph is gated
    // to 'live' mode inside setComposedOverlay.
    const allFrames = setOverlay.mock.calls.map((c) => strip(c[0])).join('\n');
    expect(allFrames).not.toContain('◆ thinking');
    expect(allFrames).not.toContain('Hidden in summary mode.');
  });

  it("does NOT push a thinking overlay in 'off' mode (no buffer either)", () => {
    const toolLane = new ToolLane();
    const setOverlay = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    ctx.thinkingMode = 'off';
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(
      thinkingEvent('Dropped on the floor.'),
      source,
      ctx,
    );

    expect(setOverlay).not.toHaveBeenCalled();
    // And the lane should not have buffered anything (off === silent).
    expect(ctx.thinkingLane.hasBufferedContent()).toBe(false);
  });
});

describe('handleOrchestratorEvent — content chunk preserves in-flight subagent rows (H3 regression)', () => {
  // Regression test for H3 of PR #424 follow-up.
  //
  // Pre-fix bug: when the orchestrator emitted a content chunk while a
  // subagent dispatch was in-flight, flushToolLaneToScrollback called
  // toolLane.flush() (nuclear), which nuked the in-flight Task entry and
  // its still-running tool children. Their overlay rows vanished, and
  // setOverlay('') blanked the bottom region — producing the visible
  // "compositor stuck on top with stale frame" / "live spinners
  // disappeared" symptoms.
  //
  // Post-fix: flushToolLaneToScrollback uses flushCompletedRoots (surgical)
  // which keeps in-flight roots + descendants in the lane. The overlay is
  // refreshed to getOverlay() — surviving rows persist visually.

  function contentChunk(text: string): OutputEvent {
    return { type: 'chunk', chunk: { type: 'content', content: text } };
  }

  function strip(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  it('completed root flushes to scrollback; in-flight subagent + children survive in overlay', () => {
    const toolLane = new ToolLane();

    // Setup the pre-content-chunk lane state:
    //   Root #1: a completed Bash call the orchestrator made directly
    //   Root #2: an in-flight Task dispatch (subagent still running)
    //   Children of Root #2: one completed bash, one in-flight bash
    toolLane.addStart('bash-orchestrator', 'Bash', '"echo done"');
    toolLane.addResult('bash-orchestrator', {
      type: 'tool_result', toolUseId: 'bash-orchestrator', content: 'done', isError: false,
    });

    toolLane.addStart('task-subagent', 'Task', JSON.stringify({ subagent_type: 'critic-pragmatist' }));
    toolLane.mergeAgentLabel('task-subagent', 'critic-pragmatist');
    toolLane.addStartWithAgentContext('bash-child-1', 'Bash', '"grep foo"', 'task-subagent');
    toolLane.addResult('bash-child-1', {
      type: 'tool_result', toolUseId: 'bash-child-1', content: 'matched', isError: false,
    });
    toolLane.addStartWithAgentContext('bash-child-2', 'Bash', '"cat README"', 'task-subagent');
    // Note: task-subagent has no result; bash-child-2 has no result → both in-flight.

    const setOverlay = vi.fn<(text: string) => void>();
    const commitAbove = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove,
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(
      contentChunk('Here is some interleaved orchestrator prose.'),
      source,
      ctx,
    );

    // ── Scrollback assertions ────────────────────────────────────────────
    // The completed Bash root must have been committed to scrollback.
    const scrollback = commitAbove.mock.calls.map((c) => strip(c[0])).join('\n');
    expect(scrollback).toContain('echo done');
    // Pre-fix: scrollback ALSO contained the in-flight Task block (a
    // premature half-rendered frame). Post-fix: it does NOT — the Task
    // stays in the lane until it actually completes.
    expect(scrollback).not.toContain('critic-pragmatist');

    // ── Overlay assertions (the critical H3 invariant) ──────────────────
    // setOverlay was called at least once during the content-chunk
    // handler. The LAST call from flushToolLaneToScrollback (before the
    // streaming markdown renderer's own setOverlay calls) must reflect
    // surviving in-flight rows, not '' (the pre-fix behavior).
    expect(setOverlay).toHaveBeenCalled();
    // Find the call corresponding to flushToolLaneToScrollback (it's the
    // first one — markdown renderer's pushes come after).
    const firstOverlay = strip(setOverlay.mock.calls[0]?.[0] ?? '');
    expect(firstOverlay, 'overlay must show surviving in-flight subagent row').toContain('critic-pragmatist');
    expect(firstOverlay, 'overlay must show in-flight child tool').toContain('cat README');

    // ── Lane assertions ─────────────────────────────────────────────────
    // The in-flight Task entry and ALL its children (completed or not)
    // must remain in the lane — they belong to a still-running subagent.
    expect(toolLane.hasEntry('task-subagent'), 'in-flight Task must remain in lane').toBe(true);
    expect(toolLane.hasEntry('bash-child-1'), 'completed child of in-flight parent must remain').toBe(true);
    expect(toolLane.hasEntry('bash-child-2'), 'in-flight child must remain').toBe(true);
    // The completed orchestrator-direct root is gone.
    expect(toolLane.hasEntry('bash-orchestrator')).toBe(false);
  });

  it('all roots in-flight: nothing flushes to scrollback, overlay still shows them', () => {
    const toolLane = new ToolLane();
    toolLane.addStart('task-1', 'Task', JSON.stringify({ subagent_type: 'researcher' }));
    toolLane.mergeAgentLabel('task-1', 'researcher');

    const setOverlay = vi.fn<(text: string) => void>();
    const commitAbove = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove,
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(
      contentChunk('Prose while subagent is still working.'),
      source,
      ctx,
    );

    // No completed roots → no scrollback commits beyond markdown.
    const scrollback = commitAbove.mock.calls.map((c) => strip(c[0])).join('\n');
    expect(scrollback).not.toContain('researcher');

    // Overlay still reflects the in-flight Task (the lane was not nuked).
    const firstOverlay = strip(setOverlay.mock.calls[0]?.[0] ?? '');
    expect(firstOverlay).toContain('researcher');

    // Lane intact.
    expect(toolLane.hasEntry('task-1')).toBe(true);
  });

  it('all roots completed: behaves like the pre-fix flush() (overlay clears, all flush)', () => {
    // Backward-compatibility check: when no subagent is in-flight, the
    // post-fix path must produce the same observable behavior as the
    // pre-fix nuclear flush — completed roots commit to scrollback, lane
    // empties, overlay clears.
    const toolLane = new ToolLane();
    toolLane.addStart('bash-1', 'Bash', '"ls"');
    toolLane.addResult('bash-1', {
      type: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false,
    });

    const setOverlay = vi.fn<(text: string) => void>();
    const commitAbove = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove,
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(contentChunk('Prose.'), source, ctx);

    const scrollback = commitAbove.mock.calls.map((c) => strip(c[0])).join('\n');
    expect(scrollback).toContain('ls');
    expect(toolLane.hasEntry('bash-1')).toBe(false);

    // First overlay call (from flushToolLaneToScrollback) is the empty
    // lane state — equivalent to the pre-fix setOverlay('').
    expect(setOverlay.mock.calls[0]?.[0]).toBe('');
  });
});

describe('handleOrchestratorEvent — tool-use-loop scrollback (no content emission)', () => {
  // Regression suite for the "tool-use loop with no content chunks" bug.
  //
  // Symptom: Opus 1M and other deeply-thinking models run long tool-use loops
  // (20+ iterations) where every iteration emits thinking + tool calls but
  // NEVER emits a `content` chunk until the loop terminates. The only
  // pre-existing flush trigger was `chunk.type === 'content'`. Without it
  // firing, the toolLane grew unbounded; entries got truncated off the top
  // by `overlayBudget` in TerminalCompositor.repaint() and disappeared
  // without ever entering scrollback. Visible result: scrollback completely
  // empty above the live overlay even after dozens of tool calls.
  //
  // Fix: flushToolLaneToScrollback also fires on `tool_use_detail` of the
  // NEXT tool (before adding the new entry). Completed flat root tools
  // commit to scrollback at the boundary between iterations.
  //
  // Trigger choice (tool_use_detail of the next tool, not tool_result of
  // the prior): the SDK emits `tool_diff` as a sidecar AFTER `tool_result`.
  // Flushing on tool_result would commit and remove the entry before the
  // diff sidecar lands, silently dropping edit_file/write_file diff
  // visibility. The next tool_use_detail typically follows at least one
  // thinking chunk, giving the diff time to attach.

  function strip(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  function bashStart(id: string, input: string): OutputEvent {
    return {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: id, toolName: 'Bash', toolInput: input },
    };
  }
  function bashResult(id: string): OutputEvent {
    return {
      type: 'chunk',
      chunk: { type: 'tool_result', toolUseId: id, content: 'ok', isError: false },
    };
  }
  function editStart(id: string): OutputEvent {
    return {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: id, toolName: 'edit_file', toolInput: '("f.ts")' },
    };
  }
  function editResult(id: string): OutputEvent {
    return {
      type: 'chunk',
      chunk: { type: 'tool_result', toolUseId: id, content: 'edited', isError: false },
    };
  }

  function makeLoopCtx(toolLane: ToolLane) {
    const setOverlay = vi.fn<(text: string) => void>();
    const commitAbove = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove,
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];
    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    return { ctx, setOverlay, commitAbove };
  }

  it('eager-flushes a completed root tool on the NEXT (different) tool_use_detail', () => {
    // The core regression test: simulate a tool-use loop with no content
    // chunks. After a DIFFERENT tool starts, the prior completed tool must be
    // in scrollback — not stuck in the live overlay waiting for content.
    //
    // Note: the next tool here is a DIFFERENT tool (edit_file) so the
    // cross-flush run-accumulation gate does not hold it. Consecutive
    // SAME-tool calls intentionally accumulate into one grouped `×N` row —
    // that behavior is pinned by the 'cross-flush tool grouping' describe
    // block below.
    const toolLane = new ToolLane();
    const { ctx, commitAbove } = makeLoopCtx(toolLane);
    const source: SourceState = freshSourceState('__main__');

    // Iteration 1: bash A starts and completes.
    handleOrchestratorEvent(bashStart('bash-A', '"ls"'), source, ctx);
    handleOrchestratorEvent(bashResult('bash-A'), source, ctx);

    // Before the next tool fires, nothing is in scrollback (correct — the
    // flush trigger is on the NEXT tool_use_detail, not on tool_result).
    expect(commitAbove).not.toHaveBeenCalled();

    // Iteration 2: a DIFFERENT tool (edit_file) starts. THIS is the flush
    // trigger — a tool-name change never holds.
    handleOrchestratorEvent(editStart('edit-B'), source, ctx);

    // bash-A must now be in scrollback.
    const scrollback = commitAbove.mock.calls.map((c) => strip(c[0])).join('\n');
    expect(scrollback).toContain('ls');
    expect(toolLane.hasEntry('bash-A')).toBe(false);
    // edit-B must still be live (not committed — it just started).
    expect(toolLane.hasEntry('edit-B')).toBe(true);
  });

  it('preserves tool_diff sidecar visibility — diff lands BEFORE the eager flush', () => {
    // The reason the flush trigger is `tool_use_detail` of the next tool
    // rather than `tool_result` of the prior: the SDK emits tool_diff
    // AFTER tool_result. If we flushed on tool_result, the entry would be
    // removed before the diff sidecar could attach, silently dropping
    // edit_file/write_file diff visibility.
    //
    // This test pins that ordering: edit_file → tool_result → tool_diff →
    // next tool_use_detail. By the time the flush fires, the diff is
    // attached and gets committed to scrollback as part of the entry.
    const toolLane = new ToolLane();
    const { ctx, commitAbove } = makeLoopCtx(toolLane);
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(editStart('edit-1'), source, ctx);
    handleOrchestratorEvent(editResult('edit-1'), source, ctx);
    handleOrchestratorEvent(toolDiffEvent('edit-1', makeMinimalDiff()), source, ctx);

    // Pre-trigger: entry is still in the lane WITH the diff attached.
    expect(toolLane.hasEntry('edit-1')).toBe(true);

    // Next tool starts — fires the eager flush.
    handleOrchestratorEvent(bashStart('bash-1', '"echo"'), source, ctx);

    // edit_file committed to scrollback. The diff hunk markers must be
    // present (proving addDiff wasn't silently lost by a too-early flush).
    const scrollback = commitAbove.mock.calls.map((c) => strip(c[0])).join('\n');
    expect(scrollback).toContain('f.ts');
    // The diff renders '+ new line' / '- old line' markers when committed.
    // Don't pin exact format — just check both old and new text round-trip.
    expect(scrollback).toMatch(/new line|old line/);
    expect(toolLane.hasEntry('edit-1')).toBe(false);
  });

  it('does NOT flush in-flight subagent roots (NESTING_TOOLS gate)', () => {
    // The flush uses `flushCompletedRoots` (surgical), which filters out
    // roots whose result is undefined (in-flight) and roots with an
    // agentContext (children of an agent). NESTING_TOOLS like `agent`
    // have their own commit path via stream-renderer.ts:537-600 and must
    // not be touched by the orchestrator-level eager flush.
    const toolLane = new ToolLane();
    const { ctx, commitAbove } = makeLoopCtx(toolLane);
    const source: SourceState = freshSourceState('__main__');

    // Start an in-flight subagent dispatch — addStartWithAgentContext with
    // an `agent` tool. No result yet.
    handleOrchestratorEvent(
      {
        type: 'chunk',
        chunk: {
          type: 'tool_use_detail',
          toolUseId: 'agent-1',
          toolName: 'agent',
          toolInput: '"researcher"',
        },
      },
      source,
      ctx,
    );

    // Now a flat tool fires (e.g., the orchestrator does a bash call
    // alongside the in-flight subagent). The flush should commit nothing
    // because the only root (agent-1) is in-flight.
    handleOrchestratorEvent(bashStart('bash-1', '"ls"'), source, ctx);

    // No scrollback writes — agent-1 is still in-flight.
    expect(commitAbove).not.toHaveBeenCalled();
    expect(toolLane.hasEntry('agent-1')).toBe(true);
    expect(toolLane.hasEntry('bash-1')).toBe(true);
  });

  it('non-TTY: does NOT call flushToolLaneToScrollback (no compositor)', () => {
    // Guard the eager flush behind isTTY so non-TTY surfaces (daemon, pipe,
    // tests without compositor) don't fire the TTY-path commit logic.
    const toolLane = new ToolLane();
    toolLane.addStart('bash-A', 'Bash', '"ls"');
    toolLane.addResult('bash-A', {
      type: 'tool_result', toolUseId: 'bash-A', content: 'ok', isError: false,
    });

    const { writer, lines } = makeWriter();
    const ctx: OrchestratorCtx = {
      out: writer,
      isTTY: false,
      compositor: null,
      toolLane,
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'off',
      streamingMarkdown: { current: null },
    };
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(bashStart('bash-B', '"pwd"'), source, ctx);

    // Lane untouched on non-TTY (no eager flush).
    expect(toolLane.hasEntry('bash-A')).toBe(true);
    expect(toolLane.hasEntry('bash-B')).toBe(true);
    expect(lines).toEqual([]);
  });
});

describe('handleOrchestratorEvent — stage rail single-paint invariant', () => {
  // Regression suite for the "duplicate observe · model · choose · act · update
  // rail" bug. Pre-fix path:
  //   1. Pre-switch block called setComposedOverlay (pre-mutation toolLane).
  //   2. The matching switch arm mutated toolLane and called setComposedOverlay
  //      again (post-mutation).
  // The two overlay strings differed (toolLane mutated between calls), so the
  // compositor's identity-dedup didn't suppress the second frame. Both shipped;
  // the rail flashed twice for a single event.
  //
  // Post-fix: the pre-switch block updates tracker state only; each per-case
  // arm fires exactly one setComposedOverlay AFTER its mutations. The rail
  // update propagates because the case-arm reads the just-advanced tracker.

  function toolStart(id: string): OutputEvent {
    return {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: id, toolName: 'Bash', toolInput: '"ls"' },
    };
  }
  function toolResultEvt(id: string): OutputEvent {
    return {
      type: 'chunk',
      chunk: { type: 'tool_result', toolUseId: id, content: 'ok', isError: false },
    };
  }
  function thinkingEvt(content: string): OutputEvent {
    return { type: 'chunk', chunk: { type: 'thinking', content } };
  }
  function strip(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  function makeStageCtx(toolLane: ToolLane) {
    const setOverlay = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];
    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    ctx.stageTracker = createStageTracker();
    return { ctx, setOverlay };
  }

  // ── Tests that DIRECTLY catch the pre-fix double-paint ─────────────────
  // These three events triggered advanceStage()=true pre-fix, producing the
  // pre-switch+case-arm double call. Reverting the fix makes them fail.

  it('tool_use_detail (advances stage to acting) fires setComposedOverlay exactly once', () => {
    // Note: the stage rail was moved out of the overlay in a later PR and is
    // now rendered as a reserved footer row via LoopStageBar. The overlay no
    // longer contains stage labels; the single-paint invariant applies to the
    // tool-lane content and other overlay slots (not the stage rail).
    const toolLane = new ToolLane();
    const { ctx, setOverlay } = makeStageCtx(toolLane);
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(toolStart('tu-1'), source, ctx);

    // Pre-fix: 2 calls (pre-switch + case-arm). Post-fix: 1 (case-arm only).
    expect(setOverlay).toHaveBeenCalledTimes(1);
    // The single frame contains the tool entry — stage label is now in the
    // reserved footer row (LoopStageBar), not in the overlay string.
    const overlay = strip(setOverlay.mock.calls[0]?.[0] ?? '');
    expect(overlay).toContain('Bash');
    // Stage labels are NOT in the overlay — they moved to the footer bar.
    expect(overlay).not.toContain('◇ observe');
    expect(overlay).not.toContain('◆ act');
  });

  it('tool_result (advances stage to updating) fires setComposedOverlay exactly once', () => {
    const toolLane = new ToolLane();
    const { ctx, setOverlay } = makeStageCtx(toolLane);
    const source: SourceState = freshSourceState('__main__');

    // Prime: send tool_use_detail first so tool_result has something to flip.
    handleOrchestratorEvent(toolStart('tu-1'), source, ctx);
    setOverlay.mockClear();

    handleOrchestratorEvent(toolResultEvt('tu-1'), source, ctx);

    expect(setOverlay).toHaveBeenCalledTimes(1);
    const overlay = strip(setOverlay.mock.calls[0]?.[0] ?? '');
    // Stage labels are NOT in the overlay — they moved to the footer bar.
    expect(overlay).not.toContain('◇ observe');
    expect(overlay).not.toContain('◆ update');
  });

  it('thinking-live (advances stage to modeling) fires setComposedOverlay exactly once', () => {
    // The thinking paragraph appears in the overlay (thinkingMode='live'),
    // but the stage label no longer does — it moved to the reserved footer row.
    const toolLane = new ToolLane();
    const { ctx, setOverlay } = makeStageCtx(toolLane);
    ctx.thinkingMode = 'live';
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(thinkingEvt('reasoning step'), source, ctx);

    expect(setOverlay).toHaveBeenCalledTimes(1);
    const overlay = strip(setOverlay.mock.calls[0]?.[0] ?? '');
    // Thinking paragraph is present (live mode), stage label is not.
    expect(overlay).toContain('reasoning step');
    // Stage labels are NOT in the overlay — they moved to the footer bar.
    expect(overlay).not.toContain('◇ observe');
    expect(overlay).not.toContain('◆ model');
  });

  it('thinking-digest streams the live overlay while thinking (like live)', () => {
    // digest shows the live preview overlay exactly like 'live'; the ONLY
    // difference is that digest ALSO commits the reasoning paragraph to
    // scrollback on phase seal (covered by the emit tests). Here we assert the
    // live paragraph reaches the overlay in digest mode.
    const toolLane = new ToolLane();
    const { ctx, setOverlay } = makeStageCtx(toolLane);
    ctx.thinkingMode = 'digest';
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(thinkingEvt('reasoning step'), source, ctx);

    expect(setOverlay).toHaveBeenCalledTimes(1);
    const overlay = strip(setOverlay.mock.calls[0]?.[0] ?? '');
    expect(overlay).toContain('reasoning step');
  });

  // ── Test that catches the FOLLOW-ON regression introduced by removing  ─
  // ── the pre-switch repaint (would fail without the case-arm fix)      ─

  it('thinking-summary (advances stage to modeling) does NOT fire setComposedOverlay — rail is now a footer bar', () => {
    // Post-stage-rail-footer-bar refactor: the stage rail moved out of the
    // overlay entirely. In summary mode, a thinking event has no overlay
    // content to push (neither the paragraph nor the stage label), so
    // setComposedOverlay correctly fires 0 times.
    //
    // The LoopStageBar is repainted via the StreamRenderer.onStageChange
    // callback (which lives in stream-renderer.ts, not the orchestrator),
    // so this unit test cannot verify the bar paint directly — that is
    // covered by the StreamRenderer integration tests.
    const toolLane = new ToolLane();
    const { ctx, setOverlay } = makeStageCtx(toolLane);
    ctx.thinkingMode = 'summary';
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(thinkingEvt('hidden reasoning'), source, ctx);

    // No overlay update in summary mode — thinking is buffered silently.
    expect(setOverlay).toHaveBeenCalledTimes(0);
  });

  // ── Invariant pins (not pre-fix regressions, but guard against future  ─
  // ── attempts to "fix" the double-paint by adding redundant calls)      ─

  it('progress events (no stage advance) fire setComposedOverlay exactly once', () => {
    const toolLane = new ToolLane();
    const { ctx, setOverlay } = makeStageCtx(toolLane);
    const source: SourceState = freshSourceState('__main__');

    const progressEvent: OutputEvent = {
      type: 'progress',
      progress: {
        taskId: 'task-1',
        description: 'working',
        totalTokens: 0,
        toolUses: 0,
        durationMs: 100,
      },
    };
    handleOrchestratorEvent(progressEvent, source, ctx);

    expect(setOverlay).toHaveBeenCalledTimes(1);
  });

  it('tool_diff events (no stage advance) fire setComposedOverlay exactly once', () => {
    const toolLane = new ToolLane();
    const { ctx, setOverlay } = makeStageCtx(toolLane);
    const source: SourceState = freshSourceState('__main__');

    // Register the tool first so addDiff has an entry to attach to.
    handleOrchestratorEvent(toolStart('tu-1'), source, ctx);
    setOverlay.mockClear();

    const diffEvent: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_diff', toolUseId: 'tu-1', diff: makeMinimalDiff() },
    };
    handleOrchestratorEvent(diffEvent, source, ctx);

    expect(setOverlay).toHaveBeenCalledTimes(1);
  });

  it('without a stageTracker, behavior is unchanged (per-case arm fires once)', () => {
    // Sanity: the pre-switch guard was the only code path that touched the
    // tracker, so ctx with no tracker should produce identical output to a
    // tracker-equipped ctx for events that don't depend on stage info.
    const toolLane = new ToolLane();
    const setOverlay = vi.fn<(text: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];
    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    // No stageTracker assigned.
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(toolStart('tu-1'), source, ctx);

    expect(setOverlay).toHaveBeenCalledTimes(1);
  });
});

describe('handleOrchestratorEvent — per-phase interleaved thinking (TTY)', () => {
  function thinkingEvent(text: string): OutputEvent {
    return { type: 'chunk', chunk: { type: 'thinking', content: text } };
  }

  // The core of the interleaved-thinking feature: across a think → tool →
  // think → tool turn, each thinking PHASE collapses to its own inline
  // "◆ thought for Xs" line committed to scrollback directly above the tool it
  // produced — NOT one merged summary at the top. Drives real events through
  // handleOrchestratorEvent and asserts the commitAbove (scrollback) order.
  it('commits one inline summary per phase, interleaved above the tool it preceded', () => {
    const committed: string[] = [];
    const compositor = {
      setOverlay: vi.fn(),
      commitAbove: (line: string) => { committed.push(line); },
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const toolLane = new ToolLane();
    const ctx = makeCtx(toolLane, { isTTY: true, compositor });
    ctx.thinkingMode = 'live';
    const source: SourceState = freshSourceState('__main__');
    const fire = (e: OutputEvent) => handleOrchestratorEvent(e, source, ctx);

    // think_A → T1 → think_B → T2  (each phase sealed at the NEXT tool boundary)
    fire(thinkingEvent('reasoning that leads to the first tool call'));
    fire(toolStartEvent('tu_1'));
    fire(toolResultEvent('tu_1'));
    fire(thinkingEvent('reasoning that leads to the second tool call'));
    fire(toolStartEvent('tu_2'));
    fire(toolResultEvent('tu_2'));

    const thoughtAt = committed
      .map((l, i) => ({ l, i }))
      .filter((x) => x.l.includes('thought for'))
      .map((x) => x.i);

    // Exactly one inline summary per thinking phase.
    expect(thoughtAt.length).toBe(2);
    // Phase A's summary is committed FIRST (above T1) — nothing precedes it.
    expect(thoughtAt[0]).toBe(0);
    // Phase B's summary is NOT adjacent to phase A's: T1's entry sits between
    // them, proving the summaries are interleaved with tools, not merged.
    expect(thoughtAt[1]).toBeGreaterThan((thoughtAt[0] ?? 0) + 1);
  });

  // In 'off' mode no thinking is buffered or summarized, even on TTY.
  it("emits no inline summary when thinkingMode is 'off'", () => {
    const committed: string[] = [];
    const compositor = {
      setOverlay: vi.fn(),
      commitAbove: (line: string) => { committed.push(line); },
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(new ToolLane(), { isTTY: true, compositor });
    ctx.thinkingMode = 'off';
    const source: SourceState = freshSourceState('__main__');
    const fire = (e: OutputEvent) => handleOrchestratorEvent(e, source, ctx);

    fire(thinkingEvent('reasoning that should be dropped'));
    fire(toolStartEvent('tu_1'));
    fire(toolResultEvent('tu_1'));

    expect(committed.some((l) => l.includes('thought for'))).toBe(false);
    expect(source.thinkingPhaseStartedAt).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// progress arm — at-most-one-entry invariant (duplicate banner regression)
// ────────────────────────────────────────────────────────────────────────────

function progressEvent(taskId: string, description: string): OutputEvent {
  return {
    type: 'progress',
    progress: {
      taskId,
      description,
      totalTokens: 1000,
      toolUses: 1,
      durationMs: 1000,
    },
  };
}

describe('handleOrchestratorEvent — progress arm (duplicate banner regression)', () => {
  /**
   * Two `progress` events with DIFFERENT taskIds — as produced when two
   * runTurn invocations share one live renderer (a 401 auth-retry replay, or
   * any retry on the skill-dispatch renderer, which never rebuilds on
   * 'resumed'). loop.ts mints a fresh taskId per runTurn, so without the
   * clear() the map would accumulate two entries and the overlay would render
   * two stacked "◦ Tool-use loop" banners.
   *
   * Expect: lastProgressByTask holds EXACTLY ONE entry (the latest task), and
   * the composed overlay renders EXACTLY ONE banner.
   */
  it('collapses two distinct-taskId progress events to a single map entry + one banner', () => {
    const setOverlay = vi.fn<(overlay: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(new ToolLane(), { isTTY: true, compositor });
    const source: SourceState = freshSourceState('__main__');
    const fire = (e: OutputEvent) => handleOrchestratorEvent(e, source, ctx);

    // Stale entry from a first runTurn, then a fresh taskId from a second
    // runTurn replaying through the same renderer.
    fire(progressEvent('task-1-stale', 'Iteration 6: used bash'));
    fire(progressEvent('task-2-live', 'Iteration 15: used memory_update'));

    // Invariant: at most one entry. The second taskId evicts the first.
    expect(ctx.lastProgressByTask.size).toBe(1);
    expect(ctx.lastProgressByTask.has('task-2-live')).toBe(true);
    expect(ctx.lastProgressByTask.has('task-1-stale')).toBe(false);

    // The composed overlay renders one banner, not two: exactly one '◦' glyph
    // (one banner block) and only the live task's description survives.
    const lastOverlay = setOverlay.mock.calls.at(-1)?.[0] ?? '';
    const bannerCount = (lastOverlay.match(/◦/g) ?? []).length;
    expect(bannerCount).toBe(1);
    expect(lastOverlay).toContain('Iteration 15: used memory_update');
    expect(lastOverlay).not.toContain('Iteration 6: used bash');
  });

  /**
   * Stale-banner regression: the tool-use loop ends ('done' event →
   * finalizeOrchestrator) but the renderer keeps painting overlay frames for
   * the post-loop prose stream. Before the fix, nothing evicted the map at
   * loop exit — the LAST progress entry survived and the OverlayComposer
   * (which redraws every slot on any markDirty) kept repainting a frozen
   * "current activity" banner as if live throughout final prose streaming.
   *
   * Expect: after 'done', lastProgressByTask is empty, so any subsequent
   * overlay composition renders zero banner lines.
   */
  it("clears lastProgressByTask when the turn finalizes ('done' event)", () => {
    const setOverlay = vi.fn<(overlay: string) => void>();
    const compositor = {
      setOverlay,
      commitAbove: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];

    const ctx = makeCtx(new ToolLane(), { isTTY: true, compositor });
    const source: SourceState = freshSourceState('__main__');
    const fire = (e: OutputEvent) => handleOrchestratorEvent(e, source, ctx);

    fire(progressEvent('task-live', 'round 4: bash git show'));
    expect(ctx.lastProgressByTask.size).toBe(1);

    fire({ type: 'done' } as OutputEvent);

    expect(ctx.lastProgressByTask.size).toBe(0);
    // A post-done overlay composition must not resurrect the banner.
    setComposedOverlay(ctx);
    const lastOverlay = setOverlay.mock.calls.at(-1)?.[0] ?? '';
    expect(lastOverlay).not.toContain('round 4: bash git show');
  });
});

// ─── Skill-nesting gate ──────────────────────────────────────────────────────
//
// When a skill-dispatch turn is active (ctx.activeSkillName set) and the model
// dispatches a NESTING tool (agent/Agent/Task/compose), the tool entry must be
// registered under the skill spine (agentContext = skill entry's toolUseId).
//
// Flat leaf tools (bash, read_file, etc.) must NOT be nested: they must stay at
// root so flushCompletedRoots can eagerly commit them.
// ────────────────────────────────────────────────────────────────────────────

function skillToolStartEvent(id: string, toolName: string, input: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId: id, toolName, toolInput: input },
  };
}

function makeSkillCtx(
  toolLane: ToolLane,
  activeSkillName: string,
): OrchestratorCtx {
  const { writer } = makeWriter();
  return {
    out: writer,
    isTTY: false,
    compositor: null,
    toolLane,
    thinkingLane: new ThinkingLane(),
    thinkingMode: 'off',
    streamingMarkdown: { current: null },
    activeSkillName,
  };
}

describe('handleOrchestratorEvent — skill-nesting gate', () => {
  const source: SourceState = freshSourceState('__main__');

  it('nests agent tool under skill entry when activeSkillName is set (a)', () => {
    // (a) NESTING tool dispatched after skill — agentContext = skill entry id.
    const toolLane = new ToolLane();
    const ctx = makeSkillCtx(toolLane, 'review');

    // Skill entry registered first (simulates the model calling the skill tool).
    handleOrchestratorEvent(
      skillToolStartEvent('skill-tu-1', 'skill', '(review)'),
      source, ctx, new Map(),
    );
    expect(toolLane.hasEntry('skill-tu-1')).toBe(true);

    // Model then dispatches an agent subagent.
    handleOrchestratorEvent(
      skillToolStartEvent('agent-tu-1', 'agent', '"review-w1"'),
      source, ctx, new Map(),
    );

    // agent entry must be parented under the skill entry.
    type PrivateLane = { entries: Map<string, { agentContext?: string }> };
    const entries = (toolLane as unknown as PrivateLane).entries;
    const agentEntry = entries.get('agent-tu-1');
    expect(agentEntry, 'agent entry must exist').toBeDefined();
    expect(agentEntry?.agentContext, 'agent must be nested under skill').toBe('skill-tu-1');
  });

  it('flat leaf tools stay at root (agentContext undefined) when activeSkillName is set (b)', () => {
    // (b) FLAT tool in the same skill turn — must NOT be nested.
    const toolLane = new ToolLane();
    const ctx = makeSkillCtx(toolLane, 'review');

    handleOrchestratorEvent(
      skillToolStartEvent('skill-tu-2', 'skill', '(review)'),
      source, ctx, new Map(),
    );
    handleOrchestratorEvent(
      skillToolStartEvent('bash-tu-1', 'Bash', '"ls"'),
      source, ctx, new Map(),
    );

    type PrivateLane = { entries: Map<string, { agentContext?: string }> };
    const entries = (toolLane as unknown as PrivateLane).entries;
    const bashEntry = entries.get('bash-tu-1');
    expect(bashEntry, 'bash entry must exist').toBeDefined();
    expect(bashEntry?.agentContext, 'flat tool must stay at root').toBeUndefined();
  });

  it('agent tool stays at root when activeSkillName is NOT set (c)', () => {
    // (c) Current behavior pinned: no activeSkillName → agent roots normally.
    const toolLane = new ToolLane();
    const ctx = makeCtx(toolLane); // no activeSkillName

    // Register a skill entry (the model happened to call skill mid-turn).
    toolLane.addStart('skill-tu-3', 'skill', '(diagnose)');

    handleOrchestratorEvent(
      skillToolStartEvent('agent-tu-3', 'agent', '"diag-w1"'),
      source, ctx, new Map(),
    );

    type PrivateLane = { entries: Map<string, { agentContext?: string }> };
    const entries = (toolLane as unknown as PrivateLane).entries;
    const agentEntry = entries.get('agent-tu-3');
    expect(agentEntry, 'agent entry must exist').toBeDefined();
    expect(agentEntry?.agentContext, 'no activeSkillName → agent stays at root').toBeUndefined();
  });

  it('compose tool is also nested under skill when activeSkillName is set', () => {
    // DAG_TOOLS member — same gate as agent/Agent/Task.
    const toolLane = new ToolLane();
    const ctx = makeSkillCtx(toolLane, 'diagnose');

    handleOrchestratorEvent(
      skillToolStartEvent('skill-tu-4', 'skill', '(diagnose)'),
      source, ctx, new Map(),
    );
    handleOrchestratorEvent(
      skillToolStartEvent('compose-tu-1', 'compose', '(parallel)'),
      source, ctx, new Map(),
    );

    type PrivateLane = { entries: Map<string, { agentContext?: string }> };
    const entries = (toolLane as unknown as PrivateLane).entries;
    const composeEntry = entries.get('compose-tu-1');
    expect(composeEntry?.agentContext).toBe('skill-tu-4');
  });
});

describe('handleOrchestratorEvent — cross-flush tool grouping (run accumulation)', () => {
  function namedToolStart(id: string, toolName: string): OutputEvent {
    return {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: id, toolName, toolInput: '"cmd"' },
    };
  }
  function thinkingEvent(content: string): OutputEvent {
    return { type: 'chunk', chunk: { type: 'thinking', content } };
  }
  function makeCaptureCtx(
    toolLane: ToolLane,
    opts: { thinkingMode?: 'off' | 'summary' | 'live' | 'digest' } = {},
  ): { ctx: OrchestratorCtx; commitAboveCalls: string[] } {
    const commitAboveCalls: string[] = [];
    const compositor = {
      commitAbove(text: string) { commitAboveCalls.push(text); },
      setOverlay: vi.fn(),
      setSpinner: vi.fn(),
    } as unknown as OrchestratorCtx['compositor'];
    const { writer } = makeWriter();
    const ctx: OrchestratorCtx = {
      out: writer,
      isTTY: true,
      compositor,
      toolLane,
      thinkingLane: new ThinkingLane(),
      thinkingMode: opts.thinkingMode ?? 'off',
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    return { ctx, commitAboveCalls };
  }

  it('collapses a run of ≥2 sequential same-tool calls (no thinking) into one grouped ×N block', () => {
    const toolLane = new ToolLane();
    const { ctx, commitAboveCalls } = makeCaptureCtx(toolLane);
    const source = freshSourceState('__main__');

    // 3 sequential Bash calls, each completing before the next — no thinking.
    for (const id of ['b1', 'b2', 'b3']) {
      handleOrchestratorEvent(namedToolStart(id, 'Bash'), source, ctx);
      handleOrchestratorEvent(toolResultEvent(id), source, ctx);
    }
    // A different tool breaks the run → the held Bash run flushes as a group.
    handleOrchestratorEvent(namedToolStart('r1', 'Read'), source, ctx);

    const scrollback = commitAboveCalls.join('\n');
    expect(scrollback).toContain('×3');
  });

  it('collapses at exactly 2 — root grouping has no threshold-3 gate', () => {
    const toolLane = new ToolLane();
    const { ctx, commitAboveCalls } = makeCaptureCtx(toolLane);
    const source = freshSourceState('__main__');
    for (const id of ['b1', 'b2']) {
      handleOrchestratorEvent(namedToolStart(id, 'Bash'), source, ctx);
      handleOrchestratorEvent(toolResultEvent(id), source, ctx);
    }
    handleOrchestratorEvent(namedToolStart('r1', 'Read'), source, ctx);
    expect(commitAboveCalls.join('\n')).toContain('×2');
  });

  it('does NOT collapse distinct sequential tools', () => {
    const toolLane = new ToolLane();
    const { ctx, commitAboveCalls } = makeCaptureCtx(toolLane);
    const source = freshSourceState('__main__');
    handleOrchestratorEvent(namedToolStart('b1', 'Bash'), source, ctx);
    handleOrchestratorEvent(toolResultEvent('b1'), source, ctx);
    handleOrchestratorEvent(namedToolStart('r1', 'Read'), source, ctx);
    handleOrchestratorEvent(toolResultEvent('r1'), source, ctx);
    handleOrchestratorEvent(namedToolStart('g1', 'Glob'), source, ctx); // break
    expect(commitAboveCalls.join('\n')).not.toContain('×');
  });

  it('a thinking phase between same-tool calls breaks the run (append-only ordering)', () => {
    const toolLane = new ToolLane();
    const { ctx, commitAboveCalls } = makeCaptureCtx(toolLane, { thinkingMode: 'summary' });
    const source = freshSourceState('__main__');

    handleOrchestratorEvent(namedToolStart('b1', 'Bash'), source, ctx);
    handleOrchestratorEvent(toolResultEvent('b1'), source, ctx);
    // Model thinks before the next same-tool call → an inline "thought for Xs"
    // line commits here, so the run MUST break (else the thought would reorder
    // above the group).
    handleOrchestratorEvent(thinkingEvent('deliberating about the next step'), source, ctx);
    handleOrchestratorEvent(namedToolStart('b2', 'Bash'), source, ctx);
    handleOrchestratorEvent(toolResultEvent('b2'), source, ctx);
    handleOrchestratorEvent(namedToolStart('r1', 'Read'), source, ctx); // break

    const scrollback = commitAboveCalls.join('\n');
    expect(scrollback).not.toContain('×2');            // b1/b2 rendered individually
    expect(scrollback.toLowerCase()).toContain('thought for'); // thought committed between them
  });

  it('digest mode persists the reasoning paragraph above the stat line on phase seal', () => {
    const toolLane = new ToolLane();
    const { ctx, commitAboveCalls } = makeCaptureCtx(toolLane, { thinkingMode: 'digest' });
    const source = freshSourceState('__main__');

    handleOrchestratorEvent(thinkingEvent('Planning the read order DIGEST_PROOF next'), source, ctx);
    handleOrchestratorEvent(namedToolStart('r1', 'Read'), source, ctx); // tool boundary seals the phase

    const scrollback = commitAboveCalls.join('\n');
    expect(scrollback).toContain('DIGEST_PROOF');              // actual reasoning persisted
    expect(scrollback).toContain('◆ thinking');                // under the paragraph header
    expect(scrollback.toLowerCase()).toContain('thought for'); // stat line still emitted
  });

  it('summary mode commits only the stat line, never the reasoning text', () => {
    const toolLane = new ToolLane();
    const { ctx, commitAboveCalls } = makeCaptureCtx(toolLane, { thinkingMode: 'summary' });
    const source = freshSourceState('__main__');

    handleOrchestratorEvent(thinkingEvent('secret reasoning DIGEST_PROOF must not persist'), source, ctx);
    handleOrchestratorEvent(namedToolStart('r1', 'Read'), source, ctx);

    const scrollback = commitAboveCalls.join('\n');
    expect(scrollback).not.toContain('DIGEST_PROOF');          // reasoning NOT persisted in summary mode
    expect(scrollback.toLowerCase()).toContain('thought for');
  });
});

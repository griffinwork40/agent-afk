/**
 * Production-wiring regression tests for the StreamRenderer ctx factories.
 *
 * Issue #389 shipped with every subagent overlay repaint routed through
 * `setComposedOverlay(ctx.orchestratorCtx)`, but `makeSubagentCtx` — the SOLE
 * production constructor of SubagentCtx, called by StreamRenderer.process() —
 * never set `orchestratorCtx`. The `ctx.orchestratorCtx` guard in every
 * subagent handler was therefore permanently false in production, so no
 * subagent state transition ever repainted the overlay. The PR's own tests
 * missed it because they hand-assembled a SubagentCtx with `orchestratorCtx`
 * wired in — exercising a path production never takes.
 *
 * These tests build the ctx through the REAL factories (`makeSubagentCtx` +
 * `makeOrchestratorCtx`), the exact path production uses, and assert the
 * repaint actually fires. They fail on the pre-fix code.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeSubagentCtx, makeOrchestratorCtx } from './stream-renderer-contexts.js';
import { handleSubagentEvent, synthesizeAgentEntry } from './stream-renderer-subagent.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { CommitCoordinator } from './commit-coordinator.js';
import { stripAnsi } from '../display.js';
import type { Writer } from '../slash/types.js';
import type { StreamingMarkdownRenderer } from './stream-renderer.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { OutputEvent } from '../../agent/types.js';

function makeWriter(): Writer {
  return { line() {}, raw() {}, success() {}, info() {}, warn() {}, error() {} };
}

function makeCompositor() {
  const overlayCalls: string[] = [];
  const compositor = {
    setOverlay: (text: string) => { overlayCalls.push(text); },
    commitAbove: vi.fn(),
  } as unknown as TerminalCompositor;
  return { compositor, overlayCalls };
}

describe('stream-renderer-contexts — issue #389 production wiring', () => {
  it('makeSubagentCtx forwards orchestratorCtx onto the SubagentCtx', () => {
    const { compositor } = makeCompositor();
    const writer = makeWriter();
    const toolLane = new ToolLane();
    const orchestratorCtx = makeOrchestratorCtx({
      out: writer,
      isTTY: true,
      compositor,
      overlayComposer: null,
      toolLane,
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'off',
      streamingMarkdown: { current: null },
      coordinator: new CommitCoordinator(),
      lastProgressByTask: new Map(),
    });

    const ctx = makeSubagentCtx({
      isTTY: true,
      compositor,
      toolLane,
      out: writer,
      streamingMarkdown: new Map<string, StreamingMarkdownRenderer>(),
      thinkingMode: 'off',
      orchestratorCtx,
    });

    // The factory MUST thread orchestratorCtx through — dropping it (pre-fix)
    // is exactly what neutered every subagent repaint in production.
    expect(ctx.orchestratorCtx).toBe(orchestratorCtx);
  });

  it('a subagent tool event fires a composed overlay repaint that preserves the orchestrator thinking paragraph', () => {
    const { compositor, overlayCalls } = makeCompositor();
    const writer = makeWriter();
    const toolLane = new ToolLane();
    // Orchestrator is mid-thought in live mode — its paragraph must survive
    // a subagent state transition (the whole point of issue #389).
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('Orchestrator reasoning that must survive subagent repaints.');

    const orchestratorCtx = makeOrchestratorCtx({
      out: writer,
      isTTY: true,
      compositor,
      // null composer → setComposedOverlay takes the legacy compose path,
      // which renders the thinking paragraph + tool lane directly.
      overlayComposer: null,
      toolLane,
      thinkingLane,
      thinkingMode: 'live',
      streamingMarkdown: { current: null },
      coordinator: new CommitCoordinator(),
      lastProgressByTask: new Map(),
    });

    const ctx = makeSubagentCtx({
      isTTY: true,
      compositor,
      toolLane,
      out: writer,
      streamingMarkdown: new Map<string, StreamingMarkdownRenderer>(),
      thinkingMode: 'live',
      orchestratorCtx,
    });

    const source: SourceState = freshSourceState('verifier');
    source.agentType = 'verifier';
    synthesizeAgentEntry('src-wire', source, ctx, undefined);

    const toolStart: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 'tu-wire', toolName: 'Bash', toolInput: '"echo hi"' },
    } as OutputEvent;
    handleSubagentEvent(toolStart, 'src-wire', source, ctx);

    // Pre-fix: zero overlay calls (the ctx.orchestratorCtx guard was false).
    expect(overlayCalls.length).toBeGreaterThan(0);
    // The composed frame includes the orchestrator's live thinking paragraph —
    // proving it was NOT a bare tool-lane-only write.
    const lastFrame = stripAnsi(overlayCalls[overlayCalls.length - 1] ?? '');
    expect(lastFrame).toContain('◆ thinking');
  });

  it('the done/finalize path fires a composed overlay repaint through orchestratorCtx', () => {
    const { compositor, overlayCalls } = makeCompositor();
    const writer = makeWriter();
    const toolLane = new ToolLane();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('Synthesizing the final answer.');

    const orchestratorCtx = makeOrchestratorCtx({
      out: writer,
      isTTY: true,
      compositor,
      overlayComposer: null,
      toolLane,
      thinkingLane,
      thinkingMode: 'live',
      streamingMarkdown: { current: null },
      coordinator: new CommitCoordinator(),
      lastProgressByTask: new Map(),
    });

    const ctx = makeSubagentCtx({
      isTTY: true,
      compositor,
      toolLane,
      out: writer,
      streamingMarkdown: new Map<string, StreamingMarkdownRenderer>(),
      thinkingMode: 'live',
      orchestratorCtx,
    });

    const source = freshSourceState('verifier');
    source.agentType = 'verifier';
    synthesizeAgentEntry('src-done', source, ctx, undefined);

    handleSubagentEvent({ type: 'done' } as OutputEvent, 'src-done', source, ctx);

    // finalizeSubagent (the live copy in stream-renderer-subagent.ts) must
    // repaint via setComposedOverlay(ctx.orchestratorCtx) — pre-fix this guard
    // was false in production and the Done row never repainted live.
    expect(overlayCalls.length).toBeGreaterThan(0);
  });
});

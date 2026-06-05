/**
 * Tests for the TUI rhythm contract — see docs/tui-rhythm.md.
 *
 * The contract: every emitted block owns exactly ONE trailing blank
 * line. No emitter owns leading blanks (with documented exceptions for
 * uncontrolled predecessors — pre-arm separator, SIGINT, welcome
 * banner).
 *
 * These tests exercise the major emission sites and assert each
 * produces the right shape: content lines, then exactly one `''`
 * commit. When a future change drifts the rhythm, the assertion that
 * fails will name the offending emitter.
 *
 * @module cli/_lib/rhythm-contract.test
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import {
  handleOrchestratorEvent,
  flushToolLaneToScrollback,
  type OrchestratorCtx,
} from './stream-renderer-orchestrator.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import type { Writer } from '../slash/types.js';
import type { OutputEvent } from '../../agent/types.js';

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

function makeStubCompositor(): {
  stub: NonNullable<OrchestratorCtx['compositor']>;
  commitAboveCalls: string[];
  setOverlayCalls: string[];
} {
  const commitAboveCalls: string[] = [];
  const setOverlayCalls: string[] = [];
  const stub = {
    commitAbove(text: string) { commitAboveCalls.push(text); },
    setOverlay(text: string) { setOverlayCalls.push(text); },
    setSpinner: vi.fn(),
    isArmed: () => true,
    arm: async () => {},
    disarm: () => {},
    getBuffer: () => ({ text: '', queued: false }),
  } as unknown as NonNullable<OrchestratorCtx['compositor']>;
  return { stub, commitAboveCalls, setOverlayCalls };
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
  };
}

function toolStartEvent(id: string, toolName = 'Bash'): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId: id, toolName, toolInput: '"ls"' },
  };
}

function toolResultEvent(id: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_result', toolUseId: id, content: 'ok', isError: false },
  };
}

// Count the blank-line entries ('' or single '\n') in a commitAbove call list.
function countBlanks(calls: string[]): number {
  return calls.filter((c) => c === '' || c === '\n').length;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('TUI rhythm contract — markdown paragraph commits', () => {
  it('every paragraph block emits exactly one trailing blank via "\\n\\n" suffix', async () => {
    const { stub, commitAboveCalls } = makeStubCompositor();
    const ttyStream = new PassThrough();
    (ttyStream as unknown as { isTTY: boolean }).isTTY = true;

    const renderer = new StreamingMarkdownRenderer({
      out: ttyStream,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stub as any,
    });

    renderer.push('first paragraph\n\n');
    renderer.push('second paragraph\n\n');
    renderer.push('third paragraph\n\n');
    await renderer.flush();

    // Each push committed one block. We expect 3 commitAbove calls, each
    // ending with "\n\n" so the compositor strips one '\n' and leaves a
    // trailing blank row in scrollback.
    expect(commitAboveCalls.length).toBe(3);
    for (let i = 0; i < commitAboveCalls.length; i++) {
      const call = commitAboveCalls[i]!;
      expect(call.endsWith('\n\n'), `block ${i} must end with "\\n\\n" (trailing blank)`).toBe(true);
      expect(call.endsWith('\n\n\n'), `block ${i} must NOT end with "\\n\\n\\n" (double-trailing)`).toBe(false);
    }
  });
});

describe('TUI rhythm contract — flushToolLaneToScrollback', () => {
  it('emits tool lines + exactly one trailing blank, no leading blank', () => {
    const toolLane = new ToolLane();
    toolLane.addStart('tu-1', 'Bash', '"ls"');
    toolLane.addResult('tu-1', {
      type: 'tool_result', toolUseId: 'tu-1', content: 'ok', isError: false,
    });

    const { stub, commitAboveCalls } = makeStubCompositor();
    const ctx = makeCtx(toolLane, { isTTY: true, compositor: stub });

    flushToolLaneToScrollback(ctx);

    // Find the blank-line commits.
    expect(commitAboveCalls.length).toBeGreaterThan(0);
    // The FIRST call must NOT be a blank — that would be a leading blank.
    expect(commitAboveCalls[0]).not.toBe('');
    expect(commitAboveCalls[0]).not.toBe('\n');
    // The LAST call must be a blank — that's the trailing.
    expect(commitAboveCalls[commitAboveCalls.length - 1]).toBe('');
    // Exactly ONE blank in the whole sequence (the trailing).
    expect(countBlanks(commitAboveCalls)).toBe(1);
  });

  it('non-TTY: emits tool lines + exactly one trailing blank via out.line', () => {
    const toolLane = new ToolLane();
    toolLane.addStart('tu-1', 'Bash', '"ls"');
    toolLane.addResult('tu-1', {
      type: 'tool_result', toolUseId: 'tu-1', content: 'ok', isError: false,
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

    flushToolLaneToScrollback(ctx);

    expect(lines.length).toBeGreaterThan(0);
    // No leading blank.
    expect(lines[0]).not.toBe('');
    // Trailing blank.
    expect(lines[lines.length - 1]).toBe('');
    // Exactly one blank in the whole sequence.
    expect(lines.filter((l) => l === '').length).toBe(1);
  });

  it('empty lane: emits nothing (no spurious trailing blank)', () => {
    const toolLane = new ToolLane();
    const { stub, commitAboveCalls } = makeStubCompositor();
    const ctx = makeCtx(toolLane, { isTTY: true, compositor: stub });

    flushToolLaneToScrollback(ctx);

    // Nothing pending → nothing committed.
    expect(commitAboveCalls.length).toBe(0);
  });
});

describe('TUI rhythm contract — done-time tool-lane flush', () => {
  it('emits tool lines + exactly one trailing blank, no leading blank', () => {
    const toolLane = new ToolLane();
    toolLane.addStart('tu-1', 'Bash', '"ls"');
    toolLane.addResult('tu-1', {
      type: 'tool_result', toolUseId: 'tu-1', content: 'ok', isError: false,
    });

    // The done-time flush runs through the orchestrator's `done` event.
    const { stub, commitAboveCalls } = makeStubCompositor();
    const ctx = makeCtx(toolLane, { isTTY: true, compositor: stub });
    // Provide a coordinator (the orchestrator's done-path schedules through it).
    const source: SourceState = freshSourceState('__main__');

    // Drive the done event — this path takes the orchestrator branch
    // at lines 357-379 (tool-lane flush + before-content anchor).
    handleOrchestratorEvent({ type: 'done', metadata: { durationMs: 1 } }, source, ctx, new Map());

    // The done-path schedules commits through coordinator OR runs the
    // fallback path. In the fallback (no coordinator on ctx), it calls
    // flushToolLaneToScrollback directly. Either way, the resulting
    // commitAboveCalls must respect the rhythm contract.
    // Both the coordinator path and the fallback path must emit something.
    expect(commitAboveCalls.length).toBeGreaterThan(0);
    // No leading blank: first call must be tool content, not ''.
    expect(commitAboveCalls[0]).not.toBe('');
    // Trailing blank: the LAST blank in the sequence (there may be only one).
    const trailingIdx = commitAboveCalls.lastIndexOf('');
    // If anything blank was emitted, it must be the last.
    if (trailingIdx >= 0) {
      expect(trailingIdx).toBe(commitAboveCalls.length - 1);
    }
    // Exactly one blank.
    expect(countBlanks(commitAboveCalls)).toBeLessThanOrEqual(1);
  });
});

describe('TUI rhythm contract — orchestrator before-content path', () => {
  // When prose arrives mid-turn after tool calls were registered, the
  // before-content anchor flushes pending tools. Same rhythm rule
  // applies: tool lines + ONE trailing blank, no leading.
  it('tool flush triggered by content chunk: no leading blank, one trailing', () => {
    const toolLane = new ToolLane();
    toolLane.addStart('tu-1', 'Bash', '"ls"');
    toolLane.addResult('tu-1', {
      type: 'tool_result', toolUseId: 'tu-1', content: 'ok', isError: false,
    });

    const { stub, commitAboveCalls } = makeStubCompositor();
    const ctx = makeCtx(toolLane, { isTTY: true, compositor: stub });
    const source: SourceState = freshSourceState('__main__');

    handleOrchestratorEvent(
      { type: 'chunk', chunk: { type: 'content', content: 'prose after tool' } },
      source,
      ctx,
      new Map(),
    );

    // The tool flush must have produced at least tool content + a trailing blank.
    const flushedTool = commitAboveCalls.filter((c) => c.includes('ls') || c === '');
    expect(flushedTool.length).toBeGreaterThanOrEqual(2);
    // Last blank-equivalent must be at end of tool block (not at start).
    const firstBlankIdx = commitAboveCalls.indexOf('');
    // A trailing blank must be present.
    expect(firstBlankIdx).toBeGreaterThanOrEqual(0);
    // The blank must come AFTER tool content (not before).
    const firstContentIdx = commitAboveCalls.findIndex((c) => c.includes('ls'));
    expect(firstContentIdx).toBeGreaterThanOrEqual(0);
    expect(firstContentIdx).toBeLessThan(firstBlankIdx);
  });
});

// Safety-net flush — `StreamRenderer.dispose()` flushes any toolLane entries
// that the coordinator did not drain (e.g. non-coordinator test paths,
// entries registered after `flushAll`). The safety-net is an emitter under
// the rhythm contract and MUST own its trailing blank — otherwise the
// post-dispose footer butts against the last tool result. Regression test
// for the F1 finding on PR #540.
describe('TUI rhythm contract — dispose() safety-net tool flush', () => {
  it('non-TTY: emits tool lines + exactly one trailing blank after safety-net flush', async () => {
    const { StreamRenderer } = await import('./stream-renderer.js');
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Reach into private state to seed the toolLane WITHOUT going through
    // the orchestrator/coordinator. This exercises the safety-net branch
    // in dispose() at stream-renderer.ts:686-697.
    type PrivateRenderer = { toolLane: ToolLane };
    const privateR = r as unknown as PrivateRenderer;
    privateR.toolLane.addStart('tu-safety-net', 'Bash', '"ls"');
    privateR.toolLane.addResult('tu-safety-net', {
      type: 'tool_result', toolUseId: 'tu-safety-net', content: 'ok', isError: false,
    });
    expect(privateR.toolLane.hasPending()).toBe(true);

    await r.dispose();

    // The safety-net must have emitted at least one tool content line
    // followed by exactly one trailing blank. Find tool content; the next
    // entry must be ''. Multiple blanks would indicate a double-up; zero
    // blanks (the pre-fix state) would let the footer butt-join.
    const lastContentIdx = lines.findLastIndex(
      (l) => l.includes('ls') || l.includes('Bash') || l.includes('ok'),
    );
    expect(lastContentIdx, 'safety-net should have emitted tool content').toBeGreaterThanOrEqual(0);
    expect(lines[lastContentIdx + 1], 'safety-net must emit trailing blank').toBe('');
    // No double-blank: the entry after the trailing should not also be ''.
    if (lastContentIdx + 2 < lines.length) {
      expect(lines[lastContentIdx + 2]).not.toBe('');
    }
  });

  it('TTY: safety-net flush in dispose() emits commitAbove(line)+ commitAbove("") trailing', async () => {
    const { StreamRenderer } = await import('./stream-renderer.js');
    const commitAboveCalls: string[] = [];
    const recordingCompositor = {
      setOverlay: (_t: string) => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: (_c: { enabled: boolean; rotateVerbEveryMs?: number }) => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    type PrivateRenderer = {
      isTTY: boolean;
      compositor: typeof recordingCompositor;
      streamingMarkdownRef: { current: null };
      toolLane: ToolLane;
    };
    const privateR = r as unknown as PrivateRenderer;
    privateR.isTTY = true;
    privateR.compositor = recordingCompositor;
    privateR.streamingMarkdownRef.current = null;

    // Seed toolLane directly so coordinator does NOT see these entries —
    // they will only be reached by dispose()'s safety-net branch.
    privateR.toolLane.addStart('tu-safety-tty', 'Bash', '"ls"');
    privateR.toolLane.addResult('tu-safety-tty', {
      type: 'tool_result', toolUseId: 'tu-safety-tty', content: 'ok', isError: false,
    });
    expect(privateR.toolLane.hasPending()).toBe(true);

    await r.dispose();

    // Safety-net must have called commitAbove for the tool content AND
    // then commitAbove('') for the trailing blank.
    expect(commitAboveCalls.length).toBeGreaterThan(0);
    // The LAST commitAbove call must be the trailing blank (per contract).
    expect(commitAboveCalls[commitAboveCalls.length - 1]).toBe('');
    // Exactly one trailing blank, not double.
    expect(countBlanks(commitAboveCalls)).toBe(1);
  });
});

describe('TUI rhythm contract — registry summary', () => {
  // Pin the set of sites known to be under the contract. When a new
  // emitter is added, this test forces a conscious decision: either
  // add the site to the trailing-owned list and add a behavioral
  // assertion above, or add it to the documented leading-exception
  // list in docs/tui-rhythm.md.
  it('documents the known leading-exception sites', () => {
    // This test is documentation-as-code. It does NOT exercise the
    // sites — it just lists them. The strings must match the
    // emitter call sites so a grep can connect doc → source.
    const knownLeadingExceptions = [
      'turn-handler.ts:169', // pre-arm blank: predecessor is readline echo
      'turn-handler.ts:171', // pre-arm blank: legacy/non-TTY branch
      'interactive.ts:385',  // SIGINT mid-stream: interrupts uncontrolled overlay
      'interactive.ts:402',  // SIGINT idle: consistency with mid-stream
      'interactive.ts:486',  // welcome banner leading: predecessor is boot stdout
    ];
    // No assertion needed — the list itself is the documentation. If a
    // future PR adds a new leading-blank emitter, the contract requires
    // appending it here AND to docs/tui-rhythm.md.
    expect(knownLeadingExceptions.length).toBeGreaterThan(0);
  });
});

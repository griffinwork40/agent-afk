/**
 * Tests for StreamRenderer — the shared rendering core consumed by skill
 * streaming (and, post-Phase 2, by the main turn handler).
 *
 * Tests target the non-TTY path because vitest's stdout has no TTY; the
 * renderer detects this and falls back to line-based output through the
 * Writer. TTY-path correctness is validated via manual smoke (run `/mint`
 * in `pnpm dev`); these tests cover the sink contract, mode transitions,
 * lifecycle, and the structural shape of the output.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { Writer } from '../slash/types.js';
import type {
  OutputEvent,
  SubagentProgressMeta,
} from '../../agent/types.js';
import type { Message, ToolResultChunk, ResponseMetadata } from '../../agent/types/message-types.js';

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

function contentEvent(chunk: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'content', content: chunk },
  };
}

function toolStartEvent(id: string, name: string, input: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: {
      type: 'tool_use_detail',
      toolUseId: id,
      toolName: name,
      toolInput: input,
    },
  };
}

function toolResultEvent(id: string, content: string, isError = false): OutputEvent {
  const chunk: ToolResultChunk = {
    type: 'tool_result',
    toolUseId: id,
    content,
    isError,
  };
  return { type: 'chunk', chunk };
}

function thinkingEvent(text: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'thinking', content: text },
  };
}

function errorEvent(message: string): OutputEvent {
  return { type: 'error', error: new Error(message) };
}

function messageEvent(content: string): OutputEvent {
  const message: Message = {
    role: 'assistant',
    content,
  };
  return { type: 'message', message };
}

function doneEvent(metadata?: ResponseMetadata): OutputEvent {
  return metadata !== undefined ? { type: 'done', metadata } : { type: 'done' };
}

function meta(subagentId: string, agentType?: string): SubagentProgressMeta {
  return agentType !== undefined ? { subagentId, agentType } : { subagentId };
}

describe('StreamRenderer — lifecycle', () => {
  it('exposes a sink property bound to process()', () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    expect(typeof r.sink).toBe('function');
    expect(r.sink).not.toBe(r.process);  // bound, not raw
    r.dispose();
  });

  it('dispose() is idempotent', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    await r.dispose();
    await expect(r.dispose()).resolves.not.toThrow();
  });

  it('process() after dispose() is a no-op', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    await r.dispose();
    r.process(contentEvent('this should be ignored'));
    r.process(doneEvent());
    expect(lines.join('\n')).not.toContain('this should be ignored');
  });
});

describe('StreamRenderer — orchestrator source (no subagentId)', () => {
  it('renders content chunks as markdown on done', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(contentEvent('## Heading\n\nSome '));
    r.process(contentEvent('content here.\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('Heading');
    expect(output).toContain('Some content here.');
  });

  it('renders tool calls as compact lines on done', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(toolStartEvent('t1', 'Read', '("foo.ts")'));
    r.process(toolResultEvent('t1', 'file contents'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('Read');
  });

  it('renders error events as errorBox', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(errorEvent('something went wrong'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('something went wrong');
  });

  it('renders message event as fallback when no content chunks streamed', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(messageEvent('Final answer is 42.'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('Final answer is 42.');
  });

  it('does NOT duplicate content when both content chunks and a final message arrive', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(contentEvent('streamed text\n\n'));
    r.process(messageEvent('streamed text'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    const matches = output.match(/streamed text/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('does NOT emit ◆ start / ◇ complete chrome', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(contentEvent('Hi.\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).not.toContain('◆ start');
    expect(output).not.toContain('◇ complete');
  });

  it('thinking is collapsed to a summary line in non-verbose mode', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, verbose: false, forceNonTty: true });
    r.process(thinkingEvent('considering options...'));
    r.process(thinkingEvent(' more thinking...'));
    r.process(contentEvent('Final.\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('thought for');
    expect(output).not.toContain('considering options');
  });

  it('renders a panel event as a card via the writer', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process({
      type: 'panel',
      spec: { kind: 'checkpoint', title: 'build', body: 'all green' },
    });
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('build');
    expect(output).toContain('all green');
    expect(output).toContain('╭');
    expect(output).toContain('╰');
  });

  it('flushes streamed content before rendering a panel', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(contentEvent('intro line\n\n'));
    r.process({
      type: 'panel',
      spec: { kind: 'plan', body: 'step 1' },
    });
    r.process(contentEvent('outro line\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    const introIdx = output.indexOf('intro line');
    const planIdx = output.indexOf('PLAN');
    const outroIdx = output.indexOf('outro line');
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThan(introIdx);
    expect(outroIdx).toBeGreaterThan(planIdx);
  });
});

describe('StreamRenderer — subagent source (any subagentId)', () => {
  it('synthesizes an Agent(<agentType>) entry on the first event', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolResultEvent('a-1', 'a result'), meta('src-A', 'pragmatist'));
    r.process(doneEvent({ durationMs: 1000 } as ResponseMetadata), meta('src-A', 'pragmatist'));

    await r.dispose();
    const output = lines.join('\n');

    expect(output).toContain('Agent');
    expect(output).toContain('pragmatist');
    expect(output).toContain('Read');
  });

  it('two parallel subagents each get their own Agent entry', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolStartEvent('b-1', 'Bash', '("grep")'), meta('src-B', 'paranoid'));
    r.process(toolResultEvent('a-1', 'a result'), meta('src-A', 'pragmatist'));
    r.process(toolResultEvent('b-1', 'b result'), meta('src-B', 'paranoid'));
    r.process(doneEvent({ durationMs: 1000 } as ResponseMetadata), meta('src-A', 'pragmatist'));
    r.process(doneEvent({ durationMs: 1100 } as ResponseMetadata), meta('src-B', 'paranoid'));

    await r.dispose();
    const output = lines.join('\n');

    expect(output).toContain('pragmatist');
    expect(output).toContain('paranoid');
    expect(output).toContain('Read');
    expect(output).toContain('Bash');
  });

  it('subagent content renders as a text child under its Agent entry', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolStartEvent('b-1', 'Read', '("b.ts")'), meta('src-B', 'paranoid'));

    r.process(contentEvent('verdict from pragmatist: cheap is best'), meta('src-A', 'pragmatist'));
    r.process(contentEvent('verdict from paranoid: safe is best'), meta('src-B', 'paranoid'));

    r.process(doneEvent(), meta('src-A', 'pragmatist'));
    r.process(doneEvent(), meta('src-B', 'paranoid'));

    await r.dispose();
    const output = lines.join('\n');

    // Subagent prose now appears (under its Agent entry as a text child).
    expect(output).toContain('cheap is best');
    expect(output).toContain('safe is best');
  });

  it('emits Done summary line per Agent entry', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolStartEvent('b-1', 'Read', '("b.ts")'), meta('src-B', 'paranoid'));
    r.process(toolResultEvent('a-1', '5 lines'), meta('src-A', 'pragmatist'));
    r.process(toolResultEvent('b-1', '7 lines'), meta('src-B', 'paranoid'));
    r.process(doneEvent({ durationMs: 1234 } as ResponseMetadata), meta('src-A', 'pragmatist'));
    r.process(doneEvent({ durationMs: 1500 } as ResponseMetadata), meta('src-B', 'paranoid'));

    await r.dispose();
    const output = lines.join('\n');

    const doneCount = (output.match(/Done/g) ?? []).length;
    expect(doneCount).toBeGreaterThanOrEqual(2);
  });

  it('regression: a single content character does NOT leak into root scrollback', async () => {
    // Reproduces the historical "I" bug — when the first chunk from a
    // subagent was a single-character content delta, it leaked to root
    // scrollback during the (deleted) mode flip. Under the new routing,
    // subagent content can never reach root.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('I'), meta('src-A', 'pragmatist'));
    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolStartEvent('b-1', 'Read', '("b.ts")'), meta('src-B', 'paranoid'));
    r.process(toolResultEvent('a-1', 'a result'), meta('src-A', 'pragmatist'));
    r.process(toolResultEvent('b-1', 'b result'), meta('src-B', 'paranoid'));
    r.process(doneEvent(), meta('src-A', 'pragmatist'));
    r.process(doneEvent(), meta('src-B', 'paranoid'));

    await r.dispose();
    // Look for a literal lone "I" line at root indent (two-space prefix).
    const lonelyI = lines.some((l) => /^  I\s*$/.test(l));
    expect(lonelyI).toBe(false);
  });

  it('renders a panel emitted from a subagent without flushing parent tool lane', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process({
      type: 'panel',
      spec: { kind: 'checkpoint', title: 'sub build', body: 'tests pass' },
    }, meta('src-A', 'pragmatist'));
    r.process(toolResultEvent('a-1', 'ok'), meta('src-A', 'pragmatist'));
    r.process(doneEvent(), meta('src-A', 'pragmatist'));

    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('sub build');
    expect(output).toContain('tests pass');
    expect(output).toContain('╭');
  });

  it('flushes streamed content before rendering a panel from a subagent', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('subagent intro\n\n'), meta('src-A', 'pragmatist'));
    r.process({
      type: 'panel',
      spec: { kind: 'checkpoint', title: 'sub result', body: 'all pass' },
    }, meta('src-A', 'pragmatist'));
    r.process(contentEvent('subagent outro\n\n'), meta('src-A', 'pragmatist'));
    r.process(doneEvent(), meta('src-A', 'pragmatist'));

    await r.dispose();
    const output = lines.join('\n');
    const introIdx = output.indexOf('subagent intro');
    const cardIdx = output.indexOf('╭');
    const outroIdx = output.indexOf('subagent outro');
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(cardIdx).toBeGreaterThan(introIdx);
    expect(outroIdx).toBeGreaterThan(cardIdx);
  });

  it('content across tool boundaries: content → tool → content preserves both blocks', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('first text block'), meta('src-A', 'pragmatist'));
    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolResultEvent('a-1', 'a result'), meta('src-A', 'pragmatist'));
    r.process(contentEvent('second text block'), meta('src-A', 'pragmatist'));
    r.process(doneEvent(), meta('src-A', 'pragmatist'));

    await r.dispose();
    const output = lines.join('\n');

    expect(output).toContain('first text block');
    expect(output).toContain('second text block');
  });

  it('orchestrator + subagent: orchestrator content streams at root, subagent nests', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Orchestrator emits prose at root.
    r.process(contentEvent('Orchestrator says hi.\n\n'));
    // Then dispatches a subagent with its own content + tool.
    r.process(contentEvent('subagent thinking...'), meta('src-A', 'researcher'));
    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'researcher'));
    r.process(toolResultEvent('a-1', 'a result'), meta('src-A', 'researcher'));
    r.process(doneEvent(), meta('src-A', 'researcher'));
    // Orchestrator wraps up.
    r.process(doneEvent());

    await r.dispose();
    const output = lines.join('\n');

    // Orchestrator prose appears.
    expect(output).toContain('Orchestrator says hi');
    // Subagent prose appears (nested under Agent entry as text child).
    expect(output).toContain('subagent thinking');
    // Subagent tool appears.
    expect(output).toContain('Read');
    // Subagent's Agent label appears.
    expect(output).toContain('researcher');
  });

});

describe('StreamRenderer — subagent abort (Ctrl+C / error-event) commits to scrollback', () => {
  // Regression suite for the "killed subagent vanishes from scrollback" bug.
  //
  // Symptom: when the user hits Ctrl+C while a subagent is mid-flight, the
  // AbortGraph cascades the abort to all subagent sessions. Each subagent's
  // iterator throws AbortError; the SDK surfaces this as an
  // `event.type === 'error'` event (NOT `done`). Pre-fix, the flush-to-
  // scrollback path in StreamRenderer.process() gated on `event.type === 'done'`
  // only — so 'error' events fell through, leaving the subagent's partial
  // work stranded in the live overlay. When the live overlay was later
  // cleared (by dispose's setOverlay('') for the borrowed compositor), the
  // user's view of the in-flight work was silently lost.
  //
  // Fix: treat 'error' as terminal-equivalent to 'done'. Both schedule the
  // after-subagent coordinator batch and drain it eagerly. The merged
  // Agent entry already has its result set by handleSubagentEvent's
  // 'error' branch via `addResult` (error message → synthetic error
  // result), so flushSource renders the block with all the in-flight
  // tool calls + the error summary line.

  it('errored subagent flushes its block to scrollback (parallel: done sibling still flushes)', async () => {
    // Two subagents: one completes normally, one errors mid-flight. Both
    // must end up in scrollback. Pre-fix, only the 'done' one was flushed.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolStartEvent('b-1', 'Bash', '("grep -r foo")'), meta('src-B', 'paranoid'));
    r.process(toolResultEvent('a-1', '5 lines'), meta('src-A', 'pragmatist'));
    // src-A completes normally.
    r.process(doneEvent({ durationMs: 1234 } as ResponseMetadata), meta('src-A', 'pragmatist'));
    // src-B is killed mid-bash — emits an error event with abort message.
    r.process(errorEvent('aborted by user'), meta('src-B', 'paranoid'));

    await r.dispose();
    const output = lines.join('\n');

    // Both Agent labels appear in scrollback.
    expect(output).toContain('pragmatist');
    expect(output).toContain('paranoid');
    // Both tools appear.
    expect(output).toContain('Read');
    expect(output).toContain('Bash');
    // The errored subagent's error message appears as its result line.
    expect(output).toContain('aborted by user');
  });

  it('errored subagent with in-flight tool children flushes the WHOLE block', async () => {
    // The killed subagent had multiple in-flight tool calls when aborted.
    // All children must appear in scrollback under the Agent entry, not
    // disappear into the cleared overlay.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('m-1', 'memory_search', '("scrollback")'), meta('src-B', 'diagnose'));
    r.process(toolResultEvent('m-1', '12 facts'), meta('src-B', 'diagnose'));
    r.process(toolStartEvent('g-1', 'glob', '("**/*.ts")'), meta('src-B', 'diagnose'));
    r.process(toolResultEvent('g-1', '120 paths'), meta('src-B', 'diagnose'));
    r.process(toolStartEvent('r-1', 'read_file', '("foo.ts")'), meta('src-B', 'diagnose'));
    // No tool_result for r-1 — still in flight when abort fires.
    r.process(errorEvent('Ctrl+C: aborted'), meta('src-B', 'diagnose'));

    await r.dispose();
    const output = lines.join('\n');

    // All three tool calls must appear in scrollback, including the one
    // that never returned a tool_result (it's still a child of the Agent).
    expect(output).toContain('memory_search');
    expect(output).toContain('glob');
    expect(output).toContain('read_file');
    // Error result is the Agent's terminal summary line.
    expect(output).toContain('Ctrl+C: aborted');
    // The Agent label is present (the parent of all those tool calls).
    expect(output).toContain('diagnose');
  });

  it('idempotency: 2× error events for the same source do not double-commit', async () => {
    // Defensive: if the SDK emits multiple terminal events (defensive abort
    // chains can fire both an error and a done), the second one must not
    // re-flush the lane (which is already empty after the first flush).
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(toolStartEvent('a-1', 'Read', '("a.ts")'), meta('src-A', 'pragmatist'));
    r.process(toolResultEvent('a-1', '5 lines'), meta('src-A', 'pragmatist'));
    r.process(errorEvent('first abort'), meta('src-A', 'pragmatist'));
    r.process(doneEvent({ durationMs: 100 } as ResponseMetadata), meta('src-A', 'pragmatist'));

    await r.dispose();
    const output = lines.join('\n');

    // The first 'error' event committed the block. The 'done' event finds
    // hasEntry(syntheticId) === false (lane already flushed) and no-ops.
    // The Read tool appears exactly once — no double-emission.
    const readCount = (output.match(/Read/g) ?? []).length;
    expect(readCount).toBe(1);
    expect(output).toContain('first abort');
  });
});

describe('StreamRenderer — error paths', () => {
  it('an error event in single mode renders an error box and continues', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    r.process(toolStartEvent('t1', 'Read', '("missing.ts")'));
    r.process(errorEvent('Tool failed: missing file'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('Tool failed: missing file');
  });
});

describe('StreamRenderer — sink integration', () => {
  it('sink is callable and forwards events to process()', () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const spy = vi.spyOn(r, 'process');
    r.sink({ type: 'progress', progress: { taskId: 't', description: 'd', totalTokens: 0, toolUses: 0, durationMs: 0 } }, meta('s-1'));
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    r.dispose();
  });
});

describe('handleOrchestratorEvent — pending markdown commit on tool boundary', () => {
  // Direct unit test of the orchestrator handler in TTY mode. Reproduces the
  // bug where pre-skill narration disappears when the tool widget renders and
  // reappears below the tool entries on done. The fix: when a tool_use_detail
  // or tool_result chunk arrives, commitPending() must be called on the
  // streaming markdown renderer BEFORE setOverlay swaps the overlay to the
  // tool lane, otherwise the in-flight markdown is orphaned.
  function makeStubs() {
    const overlayCalls: string[] = [];
    const commitAboveCalls: string[] = [];
    const commitPendingCalls: number[] = [];
    const setOverlayTimestamps: number[] = [];
    let counter = 0;

    const setSpinnerCalls: Array<{ enabled: boolean }> = [];
    const compositor = {
      setOverlay: (text: string) => {
        overlayCalls.push(text);
        setOverlayTimestamps.push(++counter);
      },
      commitAbove: (text: string) => {
        commitAboveCalls.push(text);
      },
      setSpinner: (config: { enabled: boolean; rotateVerbEveryMs?: number }) => {
        setSpinnerCalls.push({ enabled: config.enabled });
      },
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };

    const markdownRenderer = {
      commitPending: () => {
        commitPendingCalls.push(++counter);
      },
      push: () => {},
      flush: async () => {},
      dispose: () => {},
    };

    return {
      compositor,
      markdownRenderer,
      overlayCalls,
      commitAboveCalls,
      commitPendingCalls,
      setOverlayTimestamps,
      setSpinnerCalls,
    };
  }

  it('calls commitPending() before setOverlay() when tool_use_detail arrives', async () => {
    const { handleOrchestratorEvent } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const stubs = makeStubs();
    const { writer } = makeWriter();
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane: new ToolLane(),
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'summary' as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamingMarkdown: { current: stubs.markdownRenderer as any },
      lastProgressByTask: new Map(),
    };
    const source = freshSourceState(undefined);

    handleOrchestratorEvent(
      {
        type: 'chunk',
        chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'audit-fit', toolInput: '{}' },
      },
      source,
      ctx,
    );

    expect(stubs.commitPendingCalls.length).toBe(1);
    expect(stubs.setOverlayTimestamps.length).toBe(1);
    // commitPending must run BEFORE setOverlay swaps to the tool lane.
    expect(stubs.commitPendingCalls[0]).toBeLessThan(stubs.setOverlayTimestamps[0]!);
  });

  it('calls commitPending() before setOverlay() when tool_result arrives', async () => {
    const { handleOrchestratorEvent } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const stubs = makeStubs();
    const { writer } = makeWriter();
    const toolLane = new ToolLane();
    toolLane.addStartWithAgentContext('t1', 'audit-fit', '{}', undefined);
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane,
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'summary' as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamingMarkdown: { current: stubs.markdownRenderer as any },
      lastProgressByTask: new Map(),
    };
    const source = freshSourceState(undefined);

    handleOrchestratorEvent(
      {
        type: 'chunk',
        chunk: { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
      },
      source,
      ctx,
    );

    expect(stubs.commitPendingCalls.length).toBe(1);
    expect(stubs.setOverlayTimestamps.length).toBe(1);
    expect(stubs.commitPendingCalls[0]).toBeLessThan(stubs.setOverlayTimestamps[0]!);
  });

  it('pauses the spinner when streamed content arrives (TTY)', async () => {
    // The spinner is a "waiting" signal. While the model is emitting visible
    // text the user is no longer waiting — they are reading. The spinner must
    // pause as soon as content actually pushes into the markdown renderer.
    const { handleOrchestratorEvent } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const stubs = makeStubs();
    const { writer } = makeWriter();
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane: new ToolLane(),
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'summary' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    const source = freshSourceState(undefined);

    handleOrchestratorEvent(
      { type: 'chunk', chunk: { type: 'content', content: 'hello world' } },
      source,
      ctx,
    );

    const disables = stubs.setSpinnerCalls.filter((c) => c.enabled === false);
    expect(disables.length).toBeGreaterThanOrEqual(1);
  });

  it('re-enables the spinner on tool_use_detail (tool-execution gap)', async () => {
    // After streaming text, when the model dispatches a tool call, real
    // waiting resumes — the spinner should come back so the user sees an
    // honest "waiting on tool" signal instead of nothing.
    const { handleOrchestratorEvent } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const stubs = makeStubs();
    const { writer } = makeWriter();
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane: new ToolLane(),
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'summary' as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamingMarkdown: { current: stubs.markdownRenderer as any },
      lastProgressByTask: new Map(),
    };
    const source = freshSourceState(undefined);

    handleOrchestratorEvent(
      {
        type: 'chunk',
        chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'bash', toolInput: '{}' },
      },
      source,
      ctx,
    );

    const enables = stubs.setSpinnerCalls.filter((c) => c.enabled === true);
    expect(enables.length).toBeGreaterThanOrEqual(1);
  });
});

describe('handleSubagentEvent — streaming content via markdown renderer', () => {
  function makeOverlayStubs() {
    const overlayCalls: string[] = [];
    const commitAboveCalls: string[] = [];
    const compositor = {
      setOverlay: (text: string) => { overlayCalls.push(text); },
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    return { compositor, overlayCalls, commitAboveCalls };
  }

  it('suppresses content from parent scrollback on TTY and routes it to the thinking tail (leak fix)', async () => {
    // Under the post-leak-fix contract: subagent prose is internal reasoning.
    // On TTY it MUST NOT commit to parent scrollback (no `commitAbove` of
    // content). Instead it surfaces as a transient one-liner under the
    // synthetic Agent row via `setThinkingTail` → `setOverlay`. The buffered
    // text accumulates in `source.contentBuffer` for clause extraction, but
    // nothing reaches scrollback while the subagent is mid-flight.
    const { handleSubagentEvent, synthesizeAgentEntry } = await import(
      './stream-renderer-subagent.js'
    );
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');
    const { StreamingMarkdownRenderer } = await import('../markdown-stream.js');

    const stubs = makeOverlayStubs();
    const { writer } = makeWriter();
    const streamingMarkdown = new Map<string, InstanceType<typeof StreamingMarkdownRenderer>>();
    const toolLane = new ToolLane();
    // Provide orchestratorCtx so subagent handlers route through
    // setComposedOverlay (issue #389 — all overlay repaints composed).
    const orchCtx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane,
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'off' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    const ctx = {
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane,
      out: writer,
      streamingMarkdown,
      orchestratorCtx: orchCtx,
    };
    const source = freshSourceState('pragmatist');
    synthesizeAgentEntry('src-A', source, ctx);

    handleSubagentEvent(
      { type: 'chunk', chunk: { type: 'content', content: 'hello world' } },
      'src-A',
      source,
      ctx,
    );

    // Contract 1: no per-subagent markdown renderer is created. The
    // streaming-markdown map is orchestrator territory now; subagent code
    // never reaches into it.
    expect(streamingMarkdown.has('src-A')).toBe(false);

    // Contract 2: the prose was never committed to parent scrollback.
    // Zero-scrollback-writes-on-TTY is the primary invariant — a fix that
    // suppresses 9/10 calls would still pass a presence check, so we assert
    // exhaustion: no `commitAbove` calls at all while the subagent is mid-flight.
    expect(stubs.commitAboveCalls).toHaveLength(0);

    // Contract 3: the prose IS surfaced via the overlay path (under the
    // Agent row, transient). The most recent overlay paint should reflect
    // the thinking tail carrying a clause derived from "hello world".
    expect(stubs.overlayCalls.length).toBeGreaterThan(0);
    const lastOverlay = stubs.overlayCalls[stubs.overlayCalls.length - 1] ?? '';
    expect(lastOverlay).toContain('hello world');

    // Contract 4: the raw buffer still accumulates content for future
    // clause extraction (and, on non-TTY, scrollback emission). This is
    // the in-memory state that backs Contract 3's overlay text.
    expect(source.contentBuffer).toBe('hello world');
  });

  it('clears the thinking tail when a tool_use_detail follows content (TTY)', async () => {
    // The transient tail is overridden by stronger signals: once the child
    // transitions from reasoning to acting, the tool_use is the new state.
    // Pinning this so a future change can't accidentally let a stale prose
    // clause survive past the tool boundary.
    const { handleSubagentEvent, synthesizeAgentEntry } = await import(
      './stream-renderer-subagent.js'
    );
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');
    const { StreamingMarkdownRenderer } = await import('../markdown-stream.js');

    const stubs = makeOverlayStubs();
    const { writer } = makeWriter();
    const streamingMarkdown = new Map<string, InstanceType<typeof StreamingMarkdownRenderer>>();
    const toolLane = new ToolLane();
    // Provide orchestratorCtx so subagent handlers route through
    // setComposedOverlay (issue #389 — all overlay repaints composed).
    const orchCtx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane,
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'off' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    const ctx = {
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane,
      out: writer,
      streamingMarkdown,
      orchestratorCtx: orchCtx,
    };
    const source = freshSourceState('pragmatist');
    synthesizeAgentEntry('src-A', source, ctx);

    handleSubagentEvent(
      { type: 'chunk', chunk: { type: 'content', content: 'thinking about it.' } },
      'src-A', source, ctx,
    );
    handleSubagentEvent(
      {
        type: 'chunk',
        chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'Read', toolInput: '("a.ts")' },
      },
      'src-A', source, ctx,
    );

    const lastOverlay = stubs.overlayCalls[stubs.overlayCalls.length - 1] ?? '';
    // The tail clause from the content chunk must not survive past the
    // tool boundary in the visible overlay.
    expect(lastOverlay).not.toContain('thinking about it');
    // Sanity: the tool itself is now visible under the Agent row.
    expect(lastOverlay).toContain('Read');
    // And no prose leaked to scrollback across the boundary.
    expect(stubs.commitAboveCalls.some((c) => c.includes('thinking about it'))).toBe(false);
  });

  it('clears thinking tail on error after content (TTY) and never commits to scrollback', async () => {
    // Covers the content → error completion path — the only completion sequence
    // that previously had no explicit TTY test. Contract:
    //   (a) no `commitAbove` calls (subagent prose stays off parent scrollback), and
    //   (b) the thinking tail is cleared so the error result reads as final state
    //       under the Agent row without a stale clause alongside it.
    const { handleSubagentEvent, synthesizeAgentEntry } = await import(
      './stream-renderer-subagent.js'
    );
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');
    const { StreamingMarkdownRenderer } = await import('../markdown-stream.js');

    const stubs = makeOverlayStubs();
    const { writer } = makeWriter();
    const streamingMarkdown = new Map<string, InstanceType<typeof StreamingMarkdownRenderer>>();

    // Spy on setThinkingTail so we can assert the clear call.
    const toolLane = new ToolLane();
    const setThinkingTailCalls: Array<[string, string | undefined]> = [];
    const origSet = toolLane.setThinkingTail.bind(toolLane);
    toolLane.setThinkingTail = (id: string, tail: string | undefined) => {
      setThinkingTailCalls.push([id, tail]);
      return origSet(id, tail);
    };

    // Provide orchestratorCtx so subagent handlers route through
    // setComposedOverlay (issue #389 — all overlay repaints composed).
    const orchCtx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane,
      thinkingLane: new ThinkingLane(),
      thinkingMode: 'off' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    const ctx = {
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stubs.compositor as any,
      toolLane,
      out: writer,
      streamingMarkdown,
      orchestratorCtx: orchCtx,
    };
    const source = freshSourceState('pragmatist');
    synthesizeAgentEntry('src-A', source, ctx);
    const parentId = source.syntheticAgentToolUseId!;

    // Step 1: content chunk — installs a thinking tail.
    handleSubagentEvent(
      { type: 'chunk', chunk: { type: 'content', content: 'in-flight reasoning' } },
      'src-A', source, ctx,
    );

    // Step 2: error event — should clear the tail and not commit prose to scrollback.
    handleSubagentEvent(
      { type: 'error', error: new Error('subagent failed') },
      'src-A', source, ctx,
    );

    // (a) No prose reached parent scrollback.
    expect(stubs.commitAboveCalls).toHaveLength(0);

    // (b) The thinking tail was cleared (setThinkingTail called with undefined
    //     for this parentId after the error event).
    const clearCall = setThinkingTailCalls.find(
      ([id, tail]) => id === parentId && tail === undefined,
    );
    expect(clearCall).toBeDefined();
  });

  it('falls back to line-buffering on non-TTY', async () => {
    const { handleSubagentEvent, synthesizeAgentEntry } = await import(
      './stream-renderer-subagent.js'
    );
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { StreamingMarkdownRenderer } = await import('../markdown-stream.js');

    const { writer, lines } = makeWriter();
    const streamingMarkdown = new Map<string, InstanceType<typeof StreamingMarkdownRenderer>>();
    const ctx = {
      isTTY: false,
      compositor: null,
      toolLane: new ToolLane(),
      out: writer,
      streamingMarkdown,
    };
    const source = freshSourceState('pragmatist');
    synthesizeAgentEntry('src-A', source, ctx);

    handleSubagentEvent(
      { type: 'chunk', chunk: { type: 'content', content: 'committed line\nstill pending' } },
      'src-A',
      source,
      ctx,
    );

    expect(streamingMarkdown.has('src-A')).toBe(false);
    expect(lines.some((l) => l.includes('committed line'))).toBe(true);
  });
});

describe('StreamRenderer — thinkingMode', () => {
  it("'off' suppresses thinking entirely (no buffer, no summary)", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, thinkingMode: 'off', forceNonTty: true });
    r.process(thinkingEvent('considering options...'));
    r.process(thinkingEvent(' more thinking...'));
    r.process(contentEvent('Answer.\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).not.toContain('considering options');
    expect(output).not.toContain('thought for');
    expect(output).toContain('Answer');
  });

  it("'summary' (default) collapses to a summary line on done", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, thinkingMode: 'summary', forceNonTty: true });
    r.process(thinkingEvent('considering options...'));
    r.process(contentEvent('Answer.\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('thought for');
    expect(output).not.toContain('considering options');
  });

  it("'live' still produces the finalize summary on non-TTY (preview overlay is TTY-only)", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, thinkingMode: 'live', forceNonTty: true });
    r.process(thinkingEvent('considering...'));
    r.process(contentEvent('Done.\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('thought for');
  });

  it("'verbose: true' is a back-compat alias for 'live'", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, verbose: true, forceNonTty: true });
    r.process(thinkingEvent('considering...'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).toContain('thought for');
  });

  it('explicit thinkingMode wins over the verbose alias', async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({
      out: writer,
      verbose: true,
      thinkingMode: 'off',
      forceNonTty: true,
    });
    r.process(thinkingEvent('hidden by off'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).not.toContain('thought for');
  });
});

describe('StreamRenderer — capture-mode', () => {
  // Regression for audit RC-1 + Fix 4 wiring. Capture-mode is set when the
  // stream is being recorded by `script(1)` / `asciinema rec` / explicit
  // `AFK_DEMO_CLEAN=1`. Two behaviors must hold:
  //
  //   (a) `thinkingMode: 'live'` is downgraded to `'summary'` so the
  //       per-thinking-chunk overlay paint doesn't flood the artifact.
  //   (b) The `Writer.line()` channel is wrapped in a deduping pass so
  //       any runs of identical lines collapse to `… (line repeated N
  //       more times)`. Other channels (success/info/warn/error/raw)
  //       bypass dedup verbatim — they are not flood sources.

  it("captureMode=true: thinkingMode 'live' is downgraded to 'summary'", async () => {
    // Before the downgrade, 'live' would emit a per-chunk overlay paint
    // that survives as preserved frames in a captured stream. Asserting
    // the summary-line output here proves the runtime mode is `summary`.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({
      out: writer,
      thinkingMode: 'live',
      captureMode: true,
      forceNonTty: true,
    });
    r.process(thinkingEvent('this thinking text should not stream live'));
    r.process(contentEvent('Done.\n\n'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    // 'summary' mode emits a one-line `◆ thought for …` footer instead of
    // the per-chunk preview. Live preview would leak the raw thinking text.
    expect(output).toContain('thought for');
    expect(output).not.toContain('this thinking text should not stream live');
  });

  it('captureMode=true: line() channel collapses runs of identical lines', async () => {
    // Wire-through test: simulate an emitter that flood-writes the same
    // line many times into the writer (e.g. a future bug or a recording
    // artifact). The dedup wrapper must collapse the run into a `…
    // repeated N more times` summary before the artifact is recorded.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({
      out: writer,
      captureMode: true,
      forceNonTty: true,
    });
    // Reach into the wrapped writer through the same surface the
    // orchestrator uses internally — the StreamRenderer's `out` field.
    const wrapped = (r as unknown as { out: Writer }).out;
    for (let i = 0; i < 10; i++) wrapped.line('+ duplicated line');
    wrapped.line('+ divergent line');
    await r.dispose();
    // 2 pass-through + 1 summary + 1 divergent = 4 outputs.
    const duplicateCount = lines.filter((l) => l === '+ duplicated line').length;
    expect(duplicateCount).toBe(2);
    expect(lines.some((l) => /repeated 8 more times/.test(l))).toBe(true);
    expect(lines).toContain('+ divergent line');
  });

  it('captureMode=true: dispose() flushes a trailing suppressed run', async () => {
    // Without the flush at dispose-time, a session that ends mid-run
    // (e.g. abort during a flood) would silently drop the summary line
    // and the artifact would understate the suppressed count.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({
      out: writer,
      captureMode: true,
      forceNonTty: true,
    });
    const wrapped = (r as unknown as { out: Writer }).out;
    for (let i = 0; i < 5; i++) wrapped.line('same');
    // No divergent line — only `dispose()` can finalize the summary.
    await r.dispose();
    expect(lines.filter((l) => l === 'same')).toHaveLength(2);
    expect(lines.some((l) => /repeated 3 more times/.test(l))).toBe(true);
  });

  it('captureMode=false (default): writer is NOT wrapped — runs pass through verbatim', async () => {
    // Live-TTY regression guard: omitting captureMode preserves the
    // existing unfiltered Writer behavior. If this fails, dedup has
    // accidentally been promoted to the live path.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({
      out: writer,
      forceNonTty: true,
    });
    const wrapped = (r as unknown as { out: Writer }).out;
    for (let i = 0; i < 5; i++) wrapped.line('verbatim');
    await r.dispose();
    expect(lines.filter((l) => l === 'verbatim')).toHaveLength(5);
    expect(lines.some((l) => /repeated/.test(l))).toBe(false);
  });
});

describe('StreamRenderer — subagent thinking cascade', () => {
  // Pre-fix behavior (commit 7dd9ec0 era): subagent thinking events were
  // dropped on the floor with no on-screen evidence the child was alive.
  // Symptom users hit: `◆ skill (research) …` with `Decrypting…` spinner and
  // nothing under it for many seconds while the child reasoned. These tests
  // pin the cascaded behavior — thinkingMode propagates from orchestrator to
  // subagent so one knob controls both surfaces.

  it("'off' still drops subagent thinking (legacy behavior preserved)", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, thinkingMode: 'off', forceNonTty: true });
    r.process(thinkingEvent('child is thinking...'), meta('sub-1', 'researcher'));
    r.process(doneEvent(), meta('sub-1', 'researcher'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    // No thinking summary on the subagent's Done row.
    expect(output).not.toMatch(/thought\s+\d/);
  });

  it("'summary' (default) appends `· thought Xs · N tok` to the subagent Done row", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, thinkingMode: 'summary', forceNonTty: true });
    // Subagent opens with a thinking block, then finishes without ever
    // emitting content or a tool_use. Pre-fix: nothing visible at all.
    r.process(thinkingEvent('considering options thoroughly enough to register'), meta('sub-1', 'researcher'));
    r.process(doneEvent(), meta('sub-1', 'researcher'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    // The synthetic Agent row was synthesized on the first thinking event, so
    // the subagent label survives all the way to the flushed scrollback.
    expect(output).toContain('researcher');
    // And the Done row carries the thinking annotation.
    expect(output).toMatch(/thought\s+\d/);
    expect(output).toMatch(/tok/);
  });

  it("does NOT stream raw thinking text into scrollback (parity with orchestrator)", async () => {
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, thinkingMode: 'live', forceNonTty: true });
    r.process(thinkingEvent('this exact sentinel text should never appear in scrollback'), meta('sub-1', 'researcher'));
    r.process(toolStartEvent('t1', 'Read', '("a.ts")'), meta('sub-1', 'researcher'));
    r.process(toolResultEvent('t1', 'ok'), meta('sub-1', 'researcher'));
    r.process(doneEvent(), meta('sub-1', 'researcher'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    expect(output).not.toContain('sentinel text');
    expect(output).toMatch(/thought\s+\d/);
  });

  it('synthetic Agent row appears even when the child only ever emits thinking', async () => {
    // Regression for the original screenshot: child opened with extended
    // thinking, parent's `◆ skill` row stayed empty underneath.
    const { writer, lines } = makeWriter();
    const r = new StreamRenderer({ out: writer, thinkingMode: 'summary', forceNonTty: true });
    r.process(thinkingEvent('only thinking, no other output'), meta('sub-1', 'analyst'));
    r.process(doneEvent(), meta('sub-1', 'analyst'));
    r.process(doneEvent());
    await r.dispose();
    const output = lines.join('\n');
    // Synthesizing the Agent entry on the first thinking event is what makes
    // the child's identity visible at all. Without it the lane flushes
    // empty and the user sees nothing.
    expect(output).toContain('analyst');
  });

  it("`extractLatestThinkingClause` returns the trailing in-flight clause", async () => {
    const { extractLatestThinkingClause } = await import('./stream-renderer-subagent.js');
    // Sentence boundary case — should return text after the last period.
    expect(extractLatestThinkingClause('First idea. Second idea pending', 80))
      .toBe('Second idea pending');
    // Newline boundary case — bullet-style thinking.
    expect(extractLatestThinkingClause('- option A\n- option B in flight', 80))
      .toBe('- option B in flight');
    // Empty / whitespace input.
    expect(extractLatestThinkingClause('   \n  ', 80)).toBe('');
    // Truncation case — must end with ellipsis.
    const long = 'a'.repeat(200);
    const out = extractLatestThinkingClause(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('finalizeOrchestrator — thinking summary routing', () => {
  // Regression for the silent-drop bug: in TTY mode the thinking summary
  // was emitted via ctx.out.line() (= console.log), which races the
  // log-update region and either gets erased or lands below the
  // turn-end footer. The fix is to route through compositor.commitAbove()
  // when a compositor is present, mirroring the skill-badge pattern at
  // L121–125 of stream-renderer-orchestrator.ts.
  it('routes the thinking summary through compositor.commitAbove() in TTY', async () => {
    const { finalizeOrchestrator } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const commitAboveCalls: string[] = [];
    const compositor = {
      setOverlay: () => {},
      commitAbove: (text: string) => { commitAboveCalls.push(text); },
      setSpinner: () => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    const { writer, lines } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('reasoning about the problem');
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: compositor as any,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'summary' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    const source = freshSourceState(undefined);
    // Per-phase model: phases commit inline DURING the turn; finalize seals a
    // trailing phase. Simulate an in-flight phase (the thinking-chunk handler
    // sets this in the live flow) so finalize emits the inline summary.
    source.thinkingPhaseStartedAt = Date.now();

    finalizeOrchestrator(source, ctx);

    expect(commitAboveCalls.some((s) => s.includes('thought for'))).toBe(true);
    // The TTY path must NOT also fall back to the writer — that's the bug.
    expect(lines.join('\n')).not.toContain('thought for');
  });

  it('falls back to ctx.out.line() in non-TTY mode', async () => {
    const { finalizeOrchestrator } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const { writer, lines } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('reasoning');
    const ctx = {
      out: writer,
      isTTY: false,
      compositor: null,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'summary' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    const source = freshSourceState(undefined);

    finalizeOrchestrator(source, ctx);

    expect(lines.join('\n')).toContain('thought for');
  });

  // Defense-in-depth: in production isTTY can be true while compositor is null
  // (e.g. dispose() ran or compositor failed to arm). The guard
  // `ctx.isTTY && ctx.compositor` must fall through to ctx.out.line() rather
  // than null-deref on compositor.commitAbove.
  it('falls back to ctx.out.line() when isTTY=true but compositor is null', async () => {
    const { finalizeOrchestrator } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const { writer, lines } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('reasoning');
    const ctx = {
      out: writer,
      isTTY: true,
      compositor: null,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'summary' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };
    const source = freshSourceState(undefined);
    // Trailing phase in flight → finalize seals it; compositor is null so the
    // commit must fall through to ctx.out.line() rather than null-deref.
    source.thinkingPhaseStartedAt = Date.now();

    expect(() => finalizeOrchestrator(source, ctx)).not.toThrow();
    expect(lines.join('\n')).toContain('thought for');
  });

  // Position invariant: the collapsed `◆ thought for Xs · N tok` line must
  // commit ABOVE the assistant response, mirroring where the live `◆ thinking`
  // overlay rendered during streaming. Pre-fix the summary was scheduled at
  // the `after-content` anchor, which placed it between the response text
  // and the footer — visually disconnected from where the thinking actually
  // happened. Encoded as a coordinator-anchor assertion so a future refactor
  // can't silently move it back.
  it('schedules the thinking summary at the before-content anchor (above response)', async () => {
    const { finalizeOrchestrator } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    // Capture all commits to a single shared array. Each batch's commits
    // are closures that captured `compositor` at schedule-time — we wire
    // them to a stable sink here so we can label each batch by what it
    // wrote, regardless of how/when the test inspects it.
    const captured: Array<{ anchor: string; lines: string[] }> = [];
    const sink: string[] = [];
    const compositor = {
      setOverlay: () => {},
      commitAbove: (line: string) => { sink.push(line); },
      setSpinner: () => {},
    };

    const coordinator = {
      schedule: (batch: { anchor: string; commits: Array<() => void> }) => {
        const before = sink.length;
        for (const c of batch.commits) c();
        captured.push({ anchor: batch.anchor, lines: sink.slice(before) });
      },
    };

    const { writer } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('reasoning that should appear ABOVE the response');
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: compositor as any,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'summary' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      coordinator: coordinator as any,
    };
    const source = freshSourceState(undefined);
    // Trailing thinking phase in flight → finalize schedules it at the
    // before-content anchor (above the assistant response).
    source.thinkingPhaseStartedAt = Date.now();
    finalizeOrchestrator(source, ctx);

    // Find which anchor carries the thinking summary.
    const beforeContent = captured
      .filter((b) => b.anchor === 'before-content')
      .flatMap((b) => b.lines)
      .join('\n');
    const afterContent = captured
      .filter((b) => b.anchor === 'after-content')
      .flatMap((b) => b.lines)
      .join('\n');

    expect(beforeContent).toContain('thought for');
    // Regression guard: pre-fix anchor was `after-content`. No new turn-end
    // feature should re-route thinking through it.
    expect(afterContent).not.toContain('thought for');
  });

  // Per-phase model: thinking that PRECEDES a tool is committed inline during
  // the turn (commitThinkingPhase at the tool_use_detail boundary), so the only
  // thinking left at finalize is a TRAILING phase (think → tool → think → done,
  // no prose). That trailing phase must commit AFTER the tool-lane so it lands
  // beneath the final tool. Both schedule at `before-content`; within an anchor
  // batches drain in registration order — so we assert schedule() order by
  // tagging each captured batch.
  it('schedules a trailing thinking phase AFTER tool-lane entries (below the final tool)', async () => {
    const { finalizeOrchestrator } = await import('./stream-renderer-orchestrator.js');
    const { freshSourceState } = await import('./stream-renderer-source.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const order: string[] = [];
    const sink: string[] = [];
    const compositor = {
      setOverlay: () => {},
      commitAbove: (line: string) => { sink.push(line); },
      setSpinner: () => {},
    };
    const coordinator = {
      schedule: (batch: { anchor: string; commits: Array<() => void> }) => {
        const before = sink.length;
        for (const c of batch.commits) c();
        const written = sink.slice(before).join('\n');
        if (written.includes('thought for')) order.push('thinking');
        else order.push('tools');
      },
    };

    const { writer } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('reasoning before tool call');
    const toolLane = new ToolLane();
    toolLane.addStartWithAgentContext('tu_1', 'Read', '{"path":"/tmp/x"}', undefined);
    // Complete the tool — finalizeOrchestrator flushes via flushCompletedRoots
    // (selective), so an in-flight root would (correctly) be skipped and no
    // tools batch scheduled. This test pins the tools-before-trailing-thinking
    // ORDER for completed entries.
    toolLane.addResult('tu_1', { type: 'tool_result', toolUseId: 'tu_1', content: 'ok', isError: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = {
      out: writer,
      isTTY: true,
      compositor,
      toolLane,
      thinkingLane,
      thinkingMode: 'summary' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
      coordinator,
    };
    const source = freshSourceState(undefined);
    // Trailing thinking phase in flight (e.g. think → tool → think → done).
    source.thinkingPhaseStartedAt = Date.now();
    finalizeOrchestrator(source, ctx);

    // Tool-lane must be scheduled FIRST; the trailing thinking phase after it.
    // Same-anchor batches drain in schedule order, so this enforces that the
    // trailing reasoning lands BELOW the final tool in the rendered turn.
    expect(order[0]).toBe('tools');
    expect(order).toContain('thinking');
    expect(order.indexOf('tools')).toBeLessThan(order.indexOf('thinking'));
  });
});

describe('setComposedOverlay — live thinking preview', () => {
  // Regression for the silent-drop bug: setComposedOverlay previously
  // assembled only (stage rail, tool lane, progress banner). Live mode
  // thinking chunks were pushed to ThinkingLane and triggered an overlay
  // recompose — but the overlay produced never included thinking text, so
  // the user saw nothing on screen during reasoning.
  function makeCompositor() {
    const overlayCalls: string[] = [];
    const compositor = {
      setOverlay: (text: string) => { overlayCalls.push(text); },
      commitAbove: () => {},
      setSpinner: () => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    return { compositor, overlayCalls };
  }

  it("includes a thinking preview in the overlay when thinkingMode is 'live'", async () => {
    const { setComposedOverlay } = await import('./stream-renderer-orchestrator.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const { compositor, overlayCalls } = makeCompositor();
    const { writer } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('I am reasoning about the user request');
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: compositor as any,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'live' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };

    setComposedOverlay(ctx);

    const overlay = overlayCalls.at(-1) ?? '';
    expect(overlay).toContain('◆');
    expect(overlay).toMatch(/reasoning|request/);
  });

  it("omits the thinking preview in 'summary' mode (visible only at turn-end)", async () => {
    const { setComposedOverlay } = await import('./stream-renderer-orchestrator.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const { compositor, overlayCalls } = makeCompositor();
    const { writer } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('I am reasoning');
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: compositor as any,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'summary' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };

    setComposedOverlay(ctx);

    const overlay = overlayCalls.at(-1) ?? '';
    expect(overlay).not.toContain('reasoning');
  });

  it('tail-scrolls long thinking buffers: keeps the trailing wrapped lines, drops the head', async () => {
    const { setComposedOverlay } = await import('./stream-renderer-orchestrator.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const { compositor, overlayCalls } = makeCompositor();
    const { writer } = makeWriter();
    const thinkingLane = new ThinkingLane();
    // The new paragraph overlay caps the BODY at ~5 wrapped lines (header
    // and `⋯ +N chars earlier` footer don't count toward the cap). The
    // buffer below is intentionally large enough that even on a
    // 500-column terminal it wraps to well more than 5 body lines, so
    // the head marker is guaranteed to scroll off and the tail marker
    // is guaranteed to survive — independent of the test runner's
    // `process.stdout.columns` value.
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';
    thinkingLane.push(
      'ALPHA_HEAD_MARKER ' + filler.repeat(200) + ' OMEGA_TAIL_MARKER',
    );
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: compositor as any,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'live' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };

    setComposedOverlay(ctx);

    const overlay = overlayCalls.at(-1) ?? '';
    // Tail is preserved (last wrapped lines kept).
    expect(overlay).toContain('OMEGA_TAIL_MARKER');
    // Head was scrolled off (oldest lines dropped from the top).
    expect(overlay).not.toContain('ALPHA_HEAD_MARKER');
    // The `⋯ +N chars earlier` footer (U+22EF MIDLINE HORIZONTAL ELLIPSIS)
    // surfaces the elided character count.
    expect(overlay).toContain('⋯');
    expect(overlay).toMatch(/\+\d+ chars earlier/);
  });

  it('emits the `◆ thinking` header before the body when buffered content exists', async () => {
    // Pins the visual-identity contract: the header glyph and label must
    // match what `ThinkingLane.collapse()` later commits as the static
    // summary line, so the stream → collapsed transition feels continuous.
    const { setComposedOverlay } = await import('./stream-renderer-orchestrator.js');
    const { ToolLane } = await import('../commands/interactive/tool-lane.js');
    const { ThinkingLane } = await import('../commands/interactive/thinking-lane.js');

    const { compositor, overlayCalls } = makeCompositor();
    const { writer } = makeWriter();
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('First clause of reasoning.');
    const ctx = {
      out: writer,
      isTTY: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: compositor as any,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: 'live' as const,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
    };

    setComposedOverlay(ctx);

    const overlay = overlayCalls.at(-1) ?? '';
    // eslint-disable-next-line no-control-regex
    const plain = overlay.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = plain.split('\n').filter((l) => l.length > 0);
    // Header is the first non-empty line, body follows beneath it.
    expect(lines[0]).toContain('◆ thinking');
    expect(lines.slice(1).join(' ')).toContain('First clause of reasoning.');
  });
});

describe('StreamRenderer — getCompositor()', () => {
  it('returns null on non-TTY surfaces', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    expect(r.getCompositor()).toBeNull();
    await r.arm();
    expect(r.getCompositor()).toBeNull();
    await r.dispose();
  });

  it('returns null after dispose()', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    await r.dispose();
    expect(r.getCompositor()).toBeNull();
  });
});

describe('StreamRenderer — dispose() borrowed-compositor failure isolation', () => {
  // Regression test for H1 of PR #424 follow-up. The borrow-dispose path
  // previously bundled three cleanup calls into a single try/catch:
  //
  //   try {
  //     compositor.setSpinner({ enabled: false });
  //     compositor.setOverlay('');
  //     compositor.setInputMode('idle');
  //   } catch (e) { debugLog(...) }
  //
  // When setSpinner threw (e.g. logUpdate() propagates EPIPE/EBADF from a
  // closed TTY — documented at terminal-compositor.ts:676), setOverlay('')
  // and setInputMode('idle') were silently skipped. The compositor stayed
  // armed with a stale overlay frame painted and the input mode stuck on
  // 'streaming' — visually the "compositor stayed on top" symptom.
  //
  // The fix splits the calls into per-step try/catch blocks so a throw in
  // an earlier step cannot prevent later steps from executing. These tests
  // pin that behavior.

  function makeBorrowDisposeStubs(opts: {
    spinnerThrows?: boolean;
    overlayThrows?: boolean;
    inputModeThrows?: boolean;
    /** Pre-existing onCancel that arm() should capture and dispose() should restore. */
    priorOnCancel?: (() => void) | undefined;
  } = {}) {
    const calls: string[] = [];
    /** Records every value passed to setOnCancel, in order — used by arm/dispose capture+restore assertions. */
    const setOnCancelArgs: Array<(() => void) | null> = [];
    // Mutable owner-side onCancel state. arm() should read this via getOnCancel
    // BEFORE swapping in the skill's onCancel; dispose() should restore the
    // captured value via setOnCancel. Initialized to opts.priorOnCancel so a
    // test can simulate "owner had a sigintHandler installed".
    let ownerOnCancel: (() => void) | undefined = opts.priorOnCancel;
    const compositor = {
      setSpinner: (_config: { enabled: boolean; rotateVerbEveryMs?: number }) => {
        calls.push('setSpinner');
        if (opts.spinnerThrows) throw new Error('EPIPE: simulated TTY close');
      },
      setOverlay: (_text: string) => {
        calls.push('setOverlay');
        if (opts.overlayThrows) throw new Error('EBADF: simulated');
      },
      setInputMode: (_mode: 'idle' | 'streaming') => {
        calls.push('setInputMode');
        if (opts.inputModeThrows) throw new Error('EPIPE: simulated');
      },
      // Required by the arm() borrow path (capture + swap-in) and by
      // dispose() borrow-cleanup (restore-to-prior). Tracks the call AND
      // records the argument so tests can assert WHICH handler was set.
      // Absence of this stub causes a runtime TypeError on any partial fix
      // that calls compositor.setOnCancel — catching that at CI time is the point.
      setOnCancel: (handler: (() => void) | null) => {
        calls.push('setOnCancel');
        setOnCancelArgs.push(handler);
        ownerOnCancel = handler ?? undefined;
      },
      // Required by the arm() borrow path for capture-before-swap. Returns
      // whatever was last passed to setOnCancel (or the initial prior).
      getOnCancel: () => ownerOnCancel,
      // Required by the arm() borrow path (setInputMode flip).
      setInputModeForArm: (_mode: 'idle' | 'streaming') => {},
      // Other compositor surface — unused by borrow-dispose but required
      // for type-shape compatibility with the renderer's private cast.
      commitAbove: () => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    return { compositor, calls, setOnCancelArgs };
  }

  // Inject the stub into the renderer's private fields, mirroring the
  // pattern used by stream-renderer-ordering.test.ts (private-access cast).
  // ownsCompositor=false routes dispose() into the borrow-dispose branch.
  function injectBorrowedCompositor(
    r: StreamRenderer,
    compositor: ReturnType<typeof makeBorrowDisposeStubs>['compositor'],
  ): void {
    type PrivateRenderer = {
      compositor: typeof compositor;
      ownsCompositor: boolean;
      borrowedCompositor: typeof compositor;
    };
    const priv = r as unknown as PrivateRenderer;
    priv.compositor = compositor;
    priv.borrowedCompositor = compositor;
    priv.ownsCompositor = false;
  }

  it('happy path: all four cleanup calls fire in sequence (setSpinner → setOverlay → setInputMode → setOnCancel)', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const { compositor, calls } = makeBorrowDisposeStubs();
    injectBorrowedCompositor(r, compositor);

    await r.dispose();

    expect(calls).toEqual(['setSpinner', 'setOverlay', 'setInputMode', 'setOnCancel']);
  });

  it('setSpinner throws: setOverlay and setInputMode still fire (regression for stuck-overlay bug)', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const { compositor, calls } = makeBorrowDisposeStubs({ spinnerThrows: true });
    injectBorrowedCompositor(r, compositor);

    await expect(r.dispose()).resolves.not.toThrow();

    // The critical assertion: setOverlay('') and setInputMode('idle') MUST
    // run even when setSpinner threw. Pre-fix, this array was just
    // ['setSpinner'] — the stale overlay stayed painted and the surface
    // stayed in 'streaming' mode, producing the "compositor on top" symptom.
    // setOnCancel(null) also fires unconditionally to clear any skill closure.
    expect(calls).toEqual(['setSpinner', 'setOverlay', 'setInputMode', 'setOnCancel']);
  });

  it('setOverlay throws: setInputMode still fires (ordering invariant: idle flip must always run)', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const { compositor, calls } = makeBorrowDisposeStubs({ overlayThrows: true });
    injectBorrowedCompositor(r, compositor);

    await expect(r.dispose()).resolves.not.toThrow();

    // Even if setOverlay throws (stale frame stays painted, unavoidable),
    // setInputMode('idle') MUST still run so the surface's pending readLine
    // can resolve. Otherwise the user's next Enter is queued forever.
    // setOnCancel(null) also fires unconditionally to clear any skill closure.
    expect(calls).toEqual(['setSpinner', 'setOverlay', 'setInputMode', 'setOnCancel']);
  });

  it('all three throw: dispose() still resolves cleanly (no error escapes)', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    const { compositor, calls } = makeBorrowDisposeStubs({
      spinnerThrows: true,
      overlayThrows: true,
      inputModeThrows: true,
    });
    injectBorrowedCompositor(r, compositor);

    await expect(r.dispose()).resolves.not.toThrow();

    // All three were attempted (the per-step catch ate each throw).
    expect(calls).toEqual(['setSpinner', 'setOverlay', 'setInputMode', 'setOnCancel']);
  });

  // H1 regression: arm() must call compositor.setOnCancel(skillOnCancel) on the
  // borrow path so Ctrl+C during a slash-skill fires the skill's cancel handler
  // instead of the REPL's sigintHandler. Before the fix, setOnCancel was never
  // called in arm() borrow branch — only the own-compositor path threaded it
  // through the TerminalCompositor constructor.
  it('arm() borrow path: setOnCancel is called with the skill onCancel on the borrowed compositor', async () => {
    const { writer } = makeWriter();
    const skillOnCancel = () => {};
    const r = new StreamRenderer({ out: writer, forceNonTty: true, onCancel: skillOnCancel });

    const { compositor, calls, setOnCancelArgs } = makeBorrowDisposeStubs();
    // Inject into arm()-phase fields (pre-arm state).
    type PrivateRenderer = { borrowedCompositor: typeof compositor; ownsCompositor: boolean };
    const priv = r as unknown as PrivateRenderer;
    priv.borrowedCompositor = compositor;
    priv.ownsCompositor = false;

    // arm() is gated on this.isTTY — force it for this test.
    type IsTTYRenderer = { isTTY: boolean };
    (r as unknown as IsTTYRenderer).isTTY = true;

    await r.arm();

    // The critical assertion: setOnCancel was called with the skill's onCancel,
    // meaning Ctrl+C during the skill now fires the skill's closure instead of
    // the REPL's sigintHandler.
    expect(setOnCancelArgs).toContain(skillOnCancel);
    // setInputMode('streaming') should also have fired (existing contract).
    expect(calls).toContain('setInputMode');

    await r.dispose();
  });

  // H2 regression: dispose() borrow-cleanup must RESTORE the prior onCancel
  // captured by arm(), not clear it with setOnCancel(null). Clearing would
  // leave the compositor with onCancel === undefined, which silently no-ops
  // Ctrl+C in idle mode (terminal-compositor.ts:1106-1108) — breaking
  // between-turns SIGINT after the first slash-skill exits.
  //
  // The owner (InputSurface.armCompositor) installs its sigintHandler via the
  // TerminalCompositor constructor; armCompositor() is idempotent and only
  // runs once per REPL boot (input-surface.ts:215 — `if (this.compositor) return;`),
  // so there is no other code path to recover the owner's handler.
  // arm() must capture-before-swap; dispose() must restore-the-capture.
  it('dispose() borrow path: setOnCancel restores the prior owner handler, not null', async () => {
    const { writer } = makeWriter();
    const ownerSigintHandler = () => { /* simulated REPL sigintHandler */ };
    const skillOnCancel = () => {};
    const r = new StreamRenderer({ out: writer, forceNonTty: true, onCancel: skillOnCancel });

    // Compositor starts with the owner's sigintHandler installed (as if
    // InputSurface.armCompositor had constructed it that way).
    const { compositor, setOnCancelArgs } = makeBorrowDisposeStubs({
      priorOnCancel: ownerSigintHandler,
    });

    // Walk through the full arm → dispose lifecycle so the capture happens
    // naturally (rather than poking private state directly).
    type PrivateRenderer = { borrowedCompositor: typeof compositor; ownsCompositor: boolean };
    const priv = r as unknown as PrivateRenderer;
    priv.borrowedCompositor = compositor;
    priv.ownsCompositor = false;
    type IsTTYRenderer = { isTTY: boolean };
    (r as unknown as IsTTYRenderer).isTTY = true;

    await r.arm();
    await r.dispose();

    // Expected setOnCancel argument sequence:
    //   1. arm()    → skillOnCancel       (swap-in)
    //   2. dispose() → ownerSigintHandler  (restore-to-prior; NOT null)
    expect(setOnCancelArgs).toEqual([skillOnCancel, ownerSigintHandler]);
  });

  // H3 regression: when the owner had no prior onCancel (non-REPL borrow
  // surfaces, or owner that never installed one), arm() should still capture
  // (as undefined) and dispose() should restore-to-null without crashing.
  // Establishes the symmetric-restore contract holds in both priorOnCancel
  // states — `null` is the correct restore value ONLY when the owner truly
  // had no handler, not as a generic "clear" step.
  it('dispose() borrow path: restores to null when owner had no prior onCancel', async () => {
    const { writer } = makeWriter();
    const skillOnCancel = () => {};
    const r = new StreamRenderer({ out: writer, forceNonTty: true, onCancel: skillOnCancel });

    // priorOnCancel omitted → owner had no handler installed.
    const { compositor, setOnCancelArgs } = makeBorrowDisposeStubs();

    type PrivateRenderer = { borrowedCompositor: typeof compositor; ownsCompositor: boolean };
    const priv = r as unknown as PrivateRenderer;
    priv.borrowedCompositor = compositor;
    priv.ownsCompositor = false;
    type IsTTYRenderer = { isTTY: boolean };
    (r as unknown as IsTTYRenderer).isTTY = true;

    await r.arm();
    await r.dispose();

    // arm() swap-in then dispose() restore-to-null (since priorOnCancel was undefined).
    expect(setOnCancelArgs).toEqual([skillOnCancel, null]);
  });
});

describe('StreamRenderer — reduced-motion', () => {
  type PrivateRenderer = { reducedMotion: boolean };

  it('stores reducedMotion: true when passed in options', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true, reducedMotion: true });
    expect((r as unknown as PrivateRenderer).reducedMotion).toBe(true);
    await r.dispose();
  });

  it('stores reducedMotion: false when explicitly passed', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true, reducedMotion: false });
    expect((r as unknown as PrivateRenderer).reducedMotion).toBe(false);
    await r.dispose();
  });

  it('falls back to detectReducedMotion() (a boolean) when the option is omitted', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    expect(typeof (r as unknown as PrivateRenderer).reducedMotion).toBe('boolean');
    await r.dispose();
  });
});

describe('StreamRenderer — setInterrupting', () => {
  type PrivateRenderer = { interrupting: boolean };

  it('flips the interrupting flag and is a safe no-op before arm() (no overlayComposer yet)', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    expect((r as unknown as PrivateRenderer).interrupting).toBe(false);
    expect(() => r.setInterrupting(true)).not.toThrow();
    expect((r as unknown as PrivateRenderer).interrupting).toBe(true);
    r.setInterrupting(false);
    expect((r as unknown as PrivateRenderer).interrupting).toBe(false);
    await r.dispose();
  });

  it('does not throw when called after dispose()', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });
    await r.dispose();
    expect(() => r.setInterrupting(true)).not.toThrow();
  });
});

describe('StreamRenderer — AFK_PLAIN_OUTPUT full render opt-out (Lever 2)', () => {
  // Regression for the "--plain doesn't suppress the mid-turn overlay" bug.
  // Root cause: AFK_PLAIN_OUTPUT was only read by createReplRenderer()
  // (the between-turn seam) — StreamRenderer computed isTTY purely from
  // process.stdout/stdin.isTTY, so a --plain session on a real TTY still
  // got a live overlay for every turn. Folding isPlainOutputRequested()
  // into the isTTY computation makes StreamRenderer agree with the seam:
  // when the flag is set, this.isTTY is forced false regardless of the
  // underlying stream's real TTY-ness, so arm() builds no compositor and
  // every `if (this.isTTY && ...)` overlay branch is skipped.
  //
  // Streams here are real TTY-shaped stand-ins (not `forceNonTty`) so the
  // test exercises the actual process.stdout/stdin.isTTY read path — using
  // forceNonTty would make the assertion vacuous (isTTY is already false
  // for a different reason).
  type PrivateRenderer = { isTTY: boolean };

  const origStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const origStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  afterEach(() => {
    vi.unstubAllEnvs();
    if (origStdoutIsTTY) Object.defineProperty(process.stdout, 'isTTY', origStdoutIsTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (origStdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', origStdinIsTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  function stubProcessTTY(isTTY: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
  }

  it('isTTY is false when AFK_PLAIN_OUTPUT=1 even though process.stdout/stdin.isTTY are true', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer });

    expect((r as unknown as PrivateRenderer).isTTY).toBe(false);
    await r.dispose();
  });

  it('isTTY is false when AFK_PLAIN_OUTPUT=true (case-insensitive) on a real TTY', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', 'TRUE');

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer });

    expect((r as unknown as PrivateRenderer).isTTY).toBe(false);
    await r.dispose();
  });

  it('isTTY stays true on a real TTY when AFK_PLAIN_OUTPUT is unset (no behavior change)', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer });

    expect((r as unknown as PrivateRenderer).isTTY).toBe(true);
    await r.dispose();
  });

  it('arm() builds no compositor when AFK_PLAIN_OUTPUT=1 forces isTTY false on a real TTY', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer });

    await r.arm();
    expect(r.getCompositor()).toBeNull();
    await r.dispose();
  });

  it('does not force isTTY false for unrecognized values (e.g. "0")', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', '0');

    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer });

    expect((r as unknown as PrivateRenderer).isTTY).toBe(true);
    await r.dispose();
  });
});

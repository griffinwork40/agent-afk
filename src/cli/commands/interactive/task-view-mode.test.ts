/**
 * Tests for task-view-mode.ts helpers and the live-tail loop in
 * enterTaskViewMode.
 *
 * Covers:
 *   - renderTaskViewHeader — header string construction
 *   - buildTaskFooterLine — footer message for running/completed states
 *   - exitTaskViewMode — clears viewingTaskId, repaint, emits return notice
 *   - enterTaskViewMode (completed handle) — shows completed footer, no tail loop
 *   - enterTaskViewMode (disk fallback) — renders events from disk replay
 *   - Natural completion: tailOutputStream resolves → FOOTER_COMPLETE emitted,
 *     ictx.viewingTaskId cleared (exitTaskViewMode called from finally).
 *   - Esc abort: soft-stop handler fires → stream aborted, exitTaskViewMode
 *     called from handler directly (NOT from the finally block a second time).
 *   - setSoftStopHandler wired: running subagent → setSoftStopHandler called
 *     with the abort+exit closure before tailing begins.
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Temp AFK_HOME so disk lookups don't touch real ~/.afk
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tv-tail-test-'));
process.env['AFK_HOME'] = tmpDir;

import {
  renderTaskViewHeader,
  buildTaskFooterLine,
  exitTaskViewMode,
  enterTaskViewMode,
} from './task-view-mode.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { SubagentHandle } from '../../../agent/subagent/handle.js';
import type { SubagentStatus } from '../../../agent/subagent/result.js';
import type { SlashContext, SessionStats } from '../../slash/types.js';
import type { InteractiveCtx } from './shared.js';
import type { OutputEvent } from '../../../agent/types/session-types.js';
import { CompletedCache } from '../../../agent/subagent/completed-cache.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  };
}

/**
 * Build a minimal SlashContext. The `setSoftStopHandler` spy stores the most
 * recently registered handler; `fireSoftStop()` calls it so tests can simulate
 * the user pressing Esc.
 */
function makeCtx(): {
  ctx: SlashContext;
  lines: string[];
  softStopSpy: ReturnType<typeof vi.fn>;
  fireSoftStop: () => void;
} {
  const lines: string[] = [];
  let registeredHandler: (() => void) | null = null;

  const softStopSpy = vi.fn((fn: (() => void) | null) => {
    registeredHandler = fn;
  });

  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw:  (t: string): void => { lines.push(t); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info:    (t: string): void => { lines.push(`INFO:${t}`); },
      warn:    (t: string): void => { lines.push(`WARN:${t}`); },
      error:   (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    setSoftStopHandler: softStopSpy,
  };

  return {
    ctx,
    lines,
    softStopSpy,
    fireSoftStop: () => registeredHandler?.(),
  };
}

function makeICtx(overrides: Partial<InteractiveCtx> = {}): InteractiveCtx {
  return { viewingTaskId: undefined, ...overrides } as unknown as InteractiveCtx;
}

/** Make a completed (or any-status) SubagentHandle for use in completed-cache tests. */
function makeHandle(id: string, status: SubagentStatus = 'succeeded'): SubagentHandle {
  return {
    id,
    status,
    cancel:          vi.fn().mockResolvedValue(undefined),
    teardown:        vi.fn().mockResolvedValue(undefined),
    run:             vi.fn(),
    runToResult:     vi.fn(),
    runInBackground: vi.fn(),
    session: {
      getHistory:      vi.fn().mockReturnValue([]),
      getOutputStream: vi.fn().mockImplementation(async function* () {}),
      sessionId:       `sess-${id}`,
    },
  } as unknown as SubagentHandle;
}

/**
 * Make a running SubagentHandle whose getOutputStream() is provided by
 * the caller as a factory.
 */
function makeRunningHandle(
  id: string,
  streamGen: () => AsyncIterable<OutputEvent>,
): SubagentHandle {
  return {
    id,
    status: 'running' as const,
    cancel:          vi.fn().mockResolvedValue(undefined),
    teardown:        vi.fn().mockResolvedValue(undefined),
    run:             vi.fn(),
    runToResult:     vi.fn(),
    runInBackground: vi.fn(),
    session: {
      getHistory:      vi.fn().mockReturnValue([]),
      getOutputStream: streamGen,
      sessionId:       `sess-${id}`,
    },
  } as unknown as SubagentHandle;
}

/** Simple manager backed by a flat list of active handles. */
function makeManager(handles: SubagentHandle[]): SubagentManager {
  return {
    list: () => handles.map(h => ({ id: h.id, status: h.status })),
    get:  (id: string) => handles.find(h => h.id === id),
  } as unknown as SubagentManager;
}

/**
 * Manager that supports both active handles AND completed entries stored in a
 * CompletedCache — mirrors the real SubagentManager.get() lookup.
 */
function makeManagerWithCompleted(
  active: SubagentHandle[] = [],
  completedEntries: { id: string; handle: SubagentHandle }[] = [],
): SubagentManager {
  const completedCache = new CompletedCache();
  for (const { id, handle } of completedEntries) {
    completedCache.add(id, handle, {
      id,
      status: 'succeeded',
    } as unknown as import('../../../agent/subagent/result.js').SubagentResult);
  }
  return {
    list: () => active.map(h => ({ id: h.id, status: h.status })),
    get: (id: string) => {
      const found = active.find(h => h.id === id);
      if (found) return found;
      return completedCache.get(id)?.handle;
    },
    completed: completedCache,
  } as unknown as SubagentManager;
}

/** A finite stream: yields one text chunk then ends. */
async function* finiteStream(): AsyncGenerator<OutputEvent> {
  yield { type: 'chunk', chunk: { type: 'content', content: 'hello from stream' } } as OutputEvent;
}

/**
 * Build a "polling" stream that yields chunks on each setImmediate tick.
 * tailOutputStream checks `signal.aborted` at the top of each `for await`
 * iteration — so once the signal fires, the loop breaks on the NEXT yield.
 * Using setImmediate between yields ensures the abort has time to propagate.
 *
 * The stream records when its iterator is closed so tests can verify that Esc
 * actually makes the consumer stop it, rather than ending the fixture first.
 */
function makePollingStream(): {
  streamFactory: () => AsyncIterable<OutputEvent>;
  closed: Promise<void>;
  yielded: () => number;
} {
  let resolveClosed: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let yielded = 0;

  async function* gen(): AsyncGenerator<OutputEvent> {
    try {
      while (true) {
        yield { type: 'chunk', chunk: { type: 'content', content: `tick-${yielded++}` } } as OutputEvent;
        // Yield the microtask queue so the event loop can fire the abort handler.
        await new Promise<void>(r => setImmediate(r));
      }
    } finally {
      resolveClosed();
    }
  }

  return {
    streamFactory: () => gen(),
    closed,
    yielded: () => yielded,
  };
}

// Convenience: await N setImmediate ticks.
function ticks(n: number): Promise<void> {
  return new Promise<void>(r => {
    let remaining = n;
    const next = (): void => {
      if (--remaining <= 0) r();
      else setImmediate(next);
    };
    setImmediate(next);
  });
}

// ---------------------------------------------------------------------------
// renderTaskViewHeader
// ---------------------------------------------------------------------------

describe('renderTaskViewHeader', () => {
  it('includes the subagent id', () => {
    const header = renderTaskViewHeader('abc-123', 'succeeded');
    expect(header).toContain('abc-123');
  });

  it('includes the agent type when provided', () => {
    const header = renderTaskViewHeader('abc-123', 'running', 'background');
    expect(header).toContain('background');
  });

  it('includes status badge for failed status', () => {
    const header = renderTaskViewHeader('abc-123', 'failed');
    // statusBadge renders '✗' for error status, not the raw string 'failed'
    expect(header).toContain('✗');
  });
});

// ---------------------------------------------------------------------------
// buildTaskFooterLine
// ---------------------------------------------------------------------------

describe('buildTaskFooterLine', () => {
  it('shows "running" footer when isRunning=true', () => {
    const line = buildTaskFooterLine(true);
    expect(line).toContain('running');
  });

  it('shows "complete" footer when isRunning=false', () => {
    const line = buildTaskFooterLine(false);
    expect(line).toContain('complete');
  });

  it('always includes Esc hint', () => {
    expect(buildTaskFooterLine(true)).toContain('Esc');
    expect(buildTaskFooterLine(false)).toContain('Esc');
  });
});

// ---------------------------------------------------------------------------
// exitTaskViewMode
// ---------------------------------------------------------------------------

describe('exitTaskViewMode', () => {
  it('clears viewingTaskId on ictx', () => {
    const { ctx } = makeCtx();
    const ictx    = makeICtx({ viewingTaskId: 'some-id' });
    exitTaskViewMode({ id: 'some-id', manager: makeManager([]), sessionLabel: 'lbl', ctx, ictx });
    expect(ictx.viewingTaskId).toBeUndefined();
  });

  it('calls repaintStatusLine', () => {
    const { ctx } = makeCtx();
    const ictx    = makeICtx();
    exitTaskViewMode({ id: 'x', manager: makeManager([]), sessionLabel: 'lbl', ctx, ictx });
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalledOnce();
  });

  it('emits a return notice line', () => {
    const { ctx, lines } = makeCtx();
    exitTaskViewMode({ id: 'x', manager: makeManager([]), sessionLabel: 'lbl', ctx });
    expect(lines.some(l => l.includes('Returned'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enterTaskViewMode — completed handle (memory path)
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — completed handle', () => {
  it('clears screen on entry', async () => {
    const h       = makeHandle('h1', 'succeeded');
    const manager = makeManagerWithCompleted([h]);
    const { ctx } = makeCtx();
    await enterTaskViewMode({ id: 'h1', manager, sessionLabel: 'lbl', ctx });
    expect(ctx.ui.clearScreen).toHaveBeenCalled();
  });

  it('renders header containing the subagent id', async () => {
    const h       = makeHandle('h-mem-1', 'succeeded');
    const manager = makeManagerWithCompleted([h]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'h-mem-1', manager, sessionLabel: 'lbl', ctx });
    const flat = lines.join('\n');
    expect(flat).toContain('h-mem-1');
  });

  it('renders "(no history yet)" when getHistory returns []', async () => {
    const h       = makeHandle('h-empty', 'succeeded');
    const manager = makeManagerWithCompleted([h]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'h-empty', manager, sessionLabel: 'lbl', ctx });
    expect(lines.some(l => l.includes('no history'))).toBe(true);
  });

  it('renders messages from history when present', async () => {
    const h = makeHandle('h-hist', 'succeeded');
    (h.session as unknown as { getHistory: ReturnType<typeof vi.fn> }).getHistory =
      vi.fn().mockReturnValue([
        { role: 'user',      content: 'hello user' },
        { role: 'assistant', content: 'hello assistant' },
      ]);
    const manager = makeManagerWithCompleted([h]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'h-hist', manager, sessionLabel: 'lbl', ctx });
    const flat = lines.join('\n');
    expect(flat).toContain('hello user');
    expect(flat).toContain('hello assistant');
  });

  it('shows completed footer (not running)', async () => {
    const h       = makeHandle('h-done', 'succeeded');
    const manager = makeManagerWithCompleted([h]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'h-done', manager, sessionLabel: 'lbl', ctx });
    expect(lines.some(l => l.includes('complete') && l.includes('Esc'))).toBe(true);
  });

  it('clears viewingTaskId on ictx after completed view', async () => {
    const h       = makeHandle('h-ictx', 'succeeded');
    const manager = makeManagerWithCompleted([h]);
    const { ctx } = makeCtx();
    const ictx = makeICtx();
    await enterTaskViewMode({ id: 'h-ictx', manager, sessionLabel: 'lbl', ctx, ictx });
    // After completion, viewingTaskId is cleared (completed path)
    expect(ictx.viewingTaskId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// enterTaskViewMode — disk fallback (no handle in memory)
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — disk fallback', () => {
  it('renders disk events when handle is not in memory', async () => {
    const manager = makeManagerWithCompleted([]); // no active or completed handles
    const { ctx, lines } = makeCtx();
    // sessionLabel that doesn't match any real file → empty replay
    await enterTaskViewMode({ id: 'ghost-id', manager, sessionLabel: 'no-such-session', ctx });
    const flat = lines.join('\n');
    // Should have header + "(no events recorded)" + footer separator
    expect(flat).toContain('ghost-id');
    expect(flat).toContain('no events');
  });

  it('shows completed footer for disk-only path', async () => {
    const manager = makeManagerWithCompleted([]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'disk-id', manager, sessionLabel: 'x', ctx });
    expect(lines.some(l => l.includes('complete') && l.includes('Esc'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. Natural completion
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — natural completion', () => {
  it('emits FOOTER_COMPLETE after the stream ends naturally', async () => {
    const handle  = makeRunningHandle('nat-1', finiteStream);
    const manager = makeManager([handle]);
    const { ctx, lines } = makeCtx();

    await enterTaskViewMode({ id: 'nat-1', manager, sessionLabel: 'lbl', ctx });

    const flat = lines.join('\n');
    expect(flat).toContain('complete');
    expect(flat).toContain('Esc');
  });

  it('clears viewingTaskId on ictx after natural completion', async () => {
    const handle  = makeRunningHandle('nat-2', finiteStream);
    const manager = makeManager([handle]);
    const { ctx } = makeCtx();
    const ictx = makeICtx({ viewingTaskId: 'nat-2' });

    await enterTaskViewMode({ id: 'nat-2', manager, sessionLabel: 'lbl', ctx, ictx });

    expect(ictx.viewingTaskId).toBeUndefined();
  });

  it('streams chunk text into output lines', async () => {
    const handle  = makeRunningHandle('nat-3', finiteStream);
    const manager = makeManager([handle]);
    const { ctx, lines } = makeCtx();

    await enterTaskViewMode({ id: 'nat-3', manager, sessionLabel: 'lbl', ctx });

    expect(lines.some(l => l.includes('hello from stream'))).toBe(true);
  });

  it('clears setSoftStopHandler (null) after stream ends', async () => {
    const handle  = makeRunningHandle('nat-4', finiteStream);
    const manager = makeManager([handle]);
    const { ctx, softStopSpy } = makeCtx();

    await enterTaskViewMode({ id: 'nat-4', manager, sessionLabel: 'lbl', ctx });

    // The last call to setSoftStopHandler must pass null to restore the default.
    const lastArg = softStopSpy.mock.calls.at(-1)?.[0];
    expect(lastArg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Esc abort
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — Esc abort', () => {
  it('aborts the stream and calls exitTaskViewMode when Esc fires', async () => {
    const { streamFactory, closed, yielded } = makePollingStream();
    const handle  = makeRunningHandle('esc-1', streamFactory);
    const manager = makeManager([handle]);
    const { ctx, fireSoftStop } = makeCtx();
    const ictx = makeICtx({ viewingTaskId: 'esc-1' });

    const viewPromise = enterTaskViewMode({ id: 'esc-1', manager, sessionLabel: 'lbl', ctx, ictx });

    // Let the tail loop start (generator yields its first chunk).
    await ticks(3);

    // Fire Esc — this calls abort.abort() internally AND exitTaskViewMode.
    fireSoftStop();

    await viewPromise;

    // The iterator must yield again after Esc so tailOutputStream observes the
    // abort, breaks its loop, and closes the otherwise-unbounded generator.
    await expect(closed).resolves.toBeUndefined();
    expect(yielded()).toBeGreaterThan(1);
    // exitTaskViewMode calls repaintStatusLine.
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalled();
  });

  it('does NOT emit FOOTER_COMPLETE when Esc fires', async () => {
    const { streamFactory } = makePollingStream();
    const handle  = makeRunningHandle('esc-2', streamFactory);
    const manager = makeManager([handle]);
    const { ctx, lines, fireSoftStop } = makeCtx();

    const viewPromise = enterTaskViewMode({ id: 'esc-2', manager, sessionLabel: 'lbl', ctx });
    await ticks(3);
    fireSoftStop();
    await viewPromise;

    // FOOTER_COMPLETE is only emitted by the non-aborted finally branch.
    // The running footer (before tail) says "running"; complete footer says "complete".
    const completeLine = lines.filter(l => l.includes('complete') && l.includes('Esc'));
    expect(completeLine.length).toBe(0);
  });

  it('clears viewingTaskId on ictx when Esc fires', async () => {
    const { streamFactory } = makePollingStream();
    const handle  = makeRunningHandle('esc-3', streamFactory);
    const manager = makeManager([handle]);
    const { ctx, fireSoftStop } = makeCtx();
    const ictx = makeICtx({ viewingTaskId: 'esc-3' });

    const viewPromise = enterTaskViewMode({ id: 'esc-3', manager, sessionLabel: 'lbl', ctx, ictx });
    await ticks(3);
    fireSoftStop();
    await viewPromise;

    expect(ictx.viewingTaskId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. setSoftStopHandler wired for running subagent
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — setSoftStopHandler wired', () => {
  it('calls setSoftStopHandler with a function for a running subagent', async () => {
    const handle  = makeRunningHandle('wire-1', finiteStream);
    const manager = makeManager([handle]);
    const { ctx, softStopSpy } = makeCtx();

    await enterTaskViewMode({ id: 'wire-1', manager, sessionLabel: 'lbl', ctx });

    // At least one call passes a function (the abort+exit closure).
    const callsWithFn = softStopSpy.mock.calls.filter(
      ([arg]: [unknown]) => typeof arg === 'function',
    );
    expect(callsWithFn.length).toBeGreaterThanOrEqual(1);
  });
});

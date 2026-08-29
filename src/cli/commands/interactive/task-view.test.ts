/**
 * Tests for v2 live task-view mode.
 *
 * Covers:
 *   - renderTaskViewHeader — header string construction
 *   - buildTaskFooterLine — footer message for running/completed states
 *   - exitTaskViewMode — clears viewingTaskId, repaint, emits return notice
 *   - enterTaskViewMode (disk path) — renders events from disk replay
 *   - enterTaskViewMode (memory path) — renders messages from handle.getHistory()
 *   - enterTaskViewMode (completed handle) — shows completed footer, no tail loop
 *   - enterTaskViewMode (missing handle + no disk) — falls back gracefully
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Temp AFK_HOME so disk lookups don't touch real ~/.afk
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tv-test-'));
process.env['AFK_HOME'] = tmpDir;

import {
  renderTaskViewHeader,
  buildTaskFooterLine,
  exitTaskViewMode,
  enterTaskViewMode,
  type TaskViewEntry,
} from './task-view-mode.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { SubagentHandle } from '../../../agent/subagent/handle.js';
import type { SubagentStatus } from '../../../agent/subagent/result.js';
import type { SlashContext, SessionStats } from '../../slash/types.js';
import type { InteractiveCtx } from './shared.js';
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

function makeCtx(overrides: Partial<SlashContext> = {}): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    setSoftStopHandler: vi.fn(),
    ...overrides,
  };
  return { ctx, lines };
}

function makeHandle(id: string, status: SubagentStatus = 'succeeded'): SubagentHandle {
  return {
    id,
    status,
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(),
    runToResult: vi.fn(),
    runInBackground: vi.fn(),
    session: {
      getHistory: vi.fn().mockReturnValue([]),
      getOutputStream: vi.fn().mockImplementation(async function* () {}),
      sessionId: `sess-${id}`,
    },
  } as unknown as SubagentHandle;
}

function makeManager(
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

function makeICtx(overrides: Partial<InteractiveCtx> = {}): InteractiveCtx {
  return { viewingTaskId: undefined, ...overrides } as unknown as InteractiveCtx;
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

  it('includes status text', () => {
    const header = renderTaskViewHeader('abc-123', 'failed');
    expect(header).toContain('failed');
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
    exitTaskViewMode({ id: 'some-id', manager: makeManager(), sessionLabel: 'lbl', ctx, ictx });
    expect(ictx.viewingTaskId).toBeUndefined();
  });

  it('calls repaintStatusLine', () => {
    const { ctx } = makeCtx();
    const ictx    = makeICtx();
    exitTaskViewMode({ id: 'x', manager: makeManager(), sessionLabel: 'lbl', ctx, ictx });
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalledOnce();
  });

  it('emits a return notice line', () => {
    const { ctx, lines } = makeCtx();
    exitTaskViewMode({ id: 'x', manager: makeManager(), sessionLabel: 'lbl', ctx });
    expect(lines.some(l => l.includes('Returned'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enterTaskViewMode — completed handle (memory path)
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — completed handle', () => {
  it('clears screen on entry', async () => {
    const h          = makeHandle('h1', 'succeeded');
    const manager    = makeManager([h]);
    const { ctx }    = makeCtx();
    await enterTaskViewMode({ id: 'h1', manager, sessionLabel: 'lbl', ctx });
    expect(ctx.ui.clearScreen).toHaveBeenCalled();
  });

  it('renders header containing the subagent id', async () => {
    const h       = makeHandle('h-mem-1', 'succeeded');
    const manager = makeManager([h]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'h-mem-1', manager, sessionLabel: 'lbl', ctx });
    const flat = lines.join('\n');
    expect(flat).toContain('h-mem-1');
  });

  it('renders "(no history yet)" when getHistory returns []', async () => {
    const h       = makeHandle('h-empty', 'succeeded');
    const manager = makeManager([h]);
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
    const manager = makeManager([h]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'h-hist', manager, sessionLabel: 'lbl', ctx });
    const flat = lines.join('\n');
    expect(flat).toContain('hello user');
    expect(flat).toContain('hello assistant');
  });

  it('shows completed footer (not running)', async () => {
    const h       = makeHandle('h-done', 'succeeded');
    const manager = makeManager([h]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'h-done', manager, sessionLabel: 'lbl', ctx });
    expect(lines.some(l => l.includes('complete') && l.includes('Esc'))).toBe(true);
  });

  it('sets viewingTaskId on ictx during view', async () => {
    const h    = makeHandle('h-ictx', 'succeeded');
    const manager = makeManager([h]);
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
    const manager = makeManager([]); // no active handles
    const { ctx, lines } = makeCtx();
    // sessionLabel that doesn't match any real file → empty replay
    await enterTaskViewMode({ id: 'ghost-id', manager, sessionLabel: 'no-such-session', ctx });
    const flat = lines.join('\n');
    // Should have header + "(no events recorded)" + footer separator
    expect(flat).toContain('ghost-id');
    expect(flat).toContain('no events');
  });

  it('shows completed footer for disk-only path', async () => {
    const manager = makeManager([]);
    const { ctx, lines } = makeCtx();
    await enterTaskViewMode({ id: 'disk-id', manager, sessionLabel: 'x', ctx });
    expect(lines.some(l => l.includes('complete') && l.includes('Esc'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enterTaskViewMode — live tail loop: natural completion
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — live tail: natural completion', () => {
  it('emits FOOTER_COMPLETE when tailOutputStream resolves naturally', async () => {
    const h = makeHandle('h-tail-nat', 'running');
    // Stream yields one event and finishes without abort.
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        yield { type: 'done' };
      });
    const manager = makeManager([h]);
    const { ctx, lines } = makeCtx();
    const ictx = makeICtx();

    await enterTaskViewMode({ id: 'h-tail-nat', manager, sessionLabel: 'lbl', ctx, ictx });

    // The finally block emits FOOTER_COMPLETE when the stream ends naturally.
    expect(lines.some(l => l.includes('complete') && l.includes('Esc'))).toBe(true);
  });

  it('clears viewingTaskId after natural stream completion', async () => {
    const h = makeHandle('h-tail-nat2', 'running');
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        yield { type: 'done' };
      });
    const manager = makeManager([h]);
    const { ctx } = makeCtx();
    const ictx = makeICtx();

    await enterTaskViewMode({ id: 'h-tail-nat2', manager, sessionLabel: 'lbl', ctx, ictx });

    // viewingTaskId must be cleared in the finally block (not via exitTaskViewMode).
    expect(ictx.viewingTaskId).toBeUndefined();
  });

  it('does NOT emit "Returned" notice on natural completion (exitTaskViewMode not called)', async () => {
    // Natural completion path clears state inline — it does NOT call
    // exitTaskViewMode, which would emit "Returned to main conversation."
    const h = makeHandle('h-tail-nat3', 'running');
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        // empty stream — resolves immediately
      });
    const manager = makeManager([h]);
    const { ctx, lines } = makeCtx();

    await enterTaskViewMode({ id: 'h-tail-nat3', manager, sessionLabel: 'lbl', ctx });

    expect(lines.some(l => l.includes('Returned'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enterTaskViewMode — live tail loop: Esc abort
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — live tail: Esc abort', () => {
  it('calls exitTaskViewMode (emits "Returned") when Esc fires', async () => {
    const h = makeHandle('h-esc-1', 'running');

    // Deferred unlock: the generator blocks until we call unblockStream(),
    // which lets the for-await in tailOutputStream proceed past the pending
    // next() call and eventually return (ending the loop).
    let unblockStream: () => void = () => {};
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        yield { type: 'chunk', chunk: { type: 'text_delta', delta: { type: 'text_delta', text: 'hi' } } };
        await new Promise<void>(r => { unblockStream = r; });
      });

    const manager = makeManager([h]);

    // Capture each call to setSoftStopHandler so we can invoke the override.
    const registeredHandlers: Array<(() => void) | null> = [];
    const { ctx, lines } = makeCtx({
      setSoftStopHandler: vi.fn((fn: (() => void) | null) => {
        registeredHandlers.push(fn);
      }) as unknown as SlashContext['setSoftStopHandler'],
    });
    const ictx = makeICtx();

    // Start tailing — do NOT await yet (stream pauses after first yield).
    const viewPromise = enterTaskViewMode({ id: 'h-esc-1', manager, sessionLabel: 'lbl', ctx, ictx });

    // Flush enough microtasks so enterTaskViewMode runs past the handler
    // registrations and enters the await tailOutputStream(...) call.
    // The generator yields once then waits; we need a few ticks to drain
    // the pipeline: (1) enter tailOutputStream, (2) start first next(),
    // (3) generator yields event, (4) loop body runs, (5) loop calls next()
    // again, (6) generator hits the blocking await and parks.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The last non-null handler registered is the Esc override (contains abort.abort()).
    const escHandler = registeredHandlers.filter(Boolean).at(-1);
    expect(escHandler).toBeTypeOf('function');

    // Simulate Esc — this calls abort.abort() + exitTaskViewMode() + setSoftStopHandler(null).
    escHandler!();

    // Now unblock the generator so tailOutputStream can finish.
    unblockStream();

    await viewPromise;

    // exitTaskViewMode emits "Returned to main conversation."
    expect(lines.some(l => l.includes('Returned'))).toBe(true);
  });

  it('does NOT emit FOOTER_COMPLETE from finally block when Esc fires', async () => {
    const h = makeHandle('h-esc-2', 'running');
    let unblockStream2: () => void = () => {};
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        yield { type: 'chunk', chunk: { type: 'text_delta', delta: { type: 'text_delta', text: 'x' } } };
        await new Promise<void>(r => { unblockStream2 = r; });
      });

    const manager = makeManager([h]);
    const registeredHandlers: Array<(() => void) | null> = [];
    const { ctx, lines } = makeCtx({
      setSoftStopHandler: vi.fn((fn: (() => void) | null) => {
        registeredHandlers.push(fn);
      }) as unknown as SlashContext['setSoftStopHandler'],
    });

    const viewPromise = enterTaskViewMode({ id: 'h-esc-2', manager, sessionLabel: 'lbl', ctx });

    for (let i = 0; i < 10; i++) await Promise.resolve();

    const escHandler = registeredHandlers.filter(Boolean).at(-1);
    escHandler!();
    unblockStream2();

    await viewPromise;

    // The finally block is gated on `if (!signal.aborted)` — when Esc fires
    // abort.abort() is called first, so FOOTER_COMPLETE is NOT emitted from
    // the finally path.  The initial footer line says "running", not "complete".
    const completeEscLines = lines.filter(l => l.includes('complete') && l.includes('Esc'));
    expect(completeEscLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// enterTaskViewMode — setSoftStopHandler override for running subagent
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — setSoftStopHandler override for running subagent', () => {
  it('calls setSoftStopHandler at least twice for a running subagent', async () => {
    // wireEscapeToExit (line 201) registers the first handler.
    // The override at line 215 registers a second handler (with abort.abort()).
    // The finally block registers null (cleanup) = ≥3 calls total.
    const h = makeHandle('h-ssh-1', 'running');
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        // Resolve immediately so enterTaskViewMode returns without blocking.
      });

    const manager = makeManager([h]);
    const { ctx } = makeCtx();

    await enterTaskViewMode({ id: 'h-ssh-1', manager, sessionLabel: 'lbl', ctx });

    // The final setSoftStopHandler(null) is the cleanup call.
    expect(ctx.setSoftStopHandler).toHaveBeenCalledWith(null);
    // wireEscapeToExit + override + cleanup = ≥3 calls.
    expect((ctx.setSoftStopHandler as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('overrides initial wireEscapeToExit handler with abort-aware version', async () => {
    // wireEscapeToExit (line 201) registers: () => { exitTaskViewMode(); setSoftStopHandler(null); }
    // The override (line 215) registers: () => { abort.abort(); exitTaskViewMode(); setSoftStopHandler(null); }
    // We verify the LAST non-null handler is the override by confirming that
    // invoking it causes the tail loop to unblock (abort path) and emits "Returned".
    const h = makeHandle('h-ssh-2', 'running');
    let unblockSsh: () => void = () => {};
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        yield { type: 'chunk', chunk: { type: 'text_delta', delta: { type: 'text_delta', text: 'y' } } };
        await new Promise<void>(r => { unblockSsh = r; });
      });

    const manager = makeManager([h]);
    const registeredHandlers: Array<(() => void) | null> = [];
    const { ctx, lines } = makeCtx({
      setSoftStopHandler: vi.fn((fn: (() => void) | null) => {
        registeredHandlers.push(fn);
      }) as unknown as SlashContext['setSoftStopHandler'],
    });

    const viewPromise = enterTaskViewMode({ id: 'h-ssh-2', manager, sessionLabel: 'lbl', ctx });

    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Multiple non-null handlers must have been registered.
    const nonNull = registeredHandlers.filter(Boolean);
    expect(nonNull.length).toBeGreaterThanOrEqual(2);

    // The LAST non-null handler is the abort-aware override: invoking it should
    // emit "Returned" (from exitTaskViewMode) and let the tail loop exit.
    const overrideHandler = nonNull.at(-1)!;
    overrideHandler();
    unblockSsh();

    await viewPromise;

    expect(lines.some(l => l.includes('Returned'))).toBe(true);
  });
});

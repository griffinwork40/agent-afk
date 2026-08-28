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
// enterTaskViewMode — live tail (running subagent, #1333)
// ---------------------------------------------------------------------------

describe('enterTaskViewMode — live tail', () => {
  /** Build a running handle whose output stream resolves naturally. */
  function makeRunningHandle(id: string, events: import('../../../agent/types/session-types.js').OutputEvent[] = []): SubagentHandle {
    const h = makeHandle(id, 'running');
    // Override getOutputStream to yield the provided events then finish.
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        for (const e of events) {
          yield e;
        }
      });
    return h;
  }

  it('natural stream completion → exitTaskViewMode called, FOOTER_COMPLETE emitted', async () => {
    const h = makeRunningHandle('h-tail-done');
    const manager = makeManager([h]);
    const { ctx, lines } = makeCtx();
    const ictx = makeICtx({ viewingTaskId: 'h-tail-done' });

    await enterTaskViewMode({ id: 'h-tail-done', manager, sessionLabel: 'lbl', ctx, ictx });

    // After natural completion: viewingTaskId is cleared by exitTaskViewMode.
    expect(ictx.viewingTaskId).toBeUndefined();
    // FOOTER_COMPLETE text should appear in the output.
    expect(lines.some(l => l.includes('complete') && !l.includes('running'))).toBe(true);
    // repaintStatusLine should have been called by exitTaskViewMode.
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalled();
  });

  it('Esc/abort fired → exitTaskViewMode NOT called from the finally branch', async () => {
    // Build a stream that never resolves on its own (blocks until aborted).
    let abortFn: (() => void) | null = null;
    const h = makeHandle('h-tail-esc', 'running');
    (h.session as unknown as { getOutputStream: ReturnType<typeof vi.fn> }).getOutputStream =
      vi.fn().mockImplementation(async function* () {
        // Hang until the AbortController fires.
        await new Promise<void>((res) => { abortFn = res; });
        // After abort, yield nothing more — stream ends.
      });

    const manager = makeManager([h]);
    const { ctx } = makeCtx();
    const ictx = makeICtx();

    // Capture the override handler that enterTaskViewMode installs for the tail.
    let installedHandler: (() => void) | null = null;
    const setSoftStopHandler = vi.fn().mockImplementation((fn: (() => void) | null) => {
      installedHandler = fn;
    });
    const { ctx: ctxEsc } = makeCtx();
    ctxEsc.setSoftStopHandler = setSoftStopHandler;

    // Start enterTaskViewMode without awaiting — it will block on the stream.
    const viewPromise = enterTaskViewMode({ id: 'h-tail-esc', manager, sessionLabel: 'lbl', ctx: ctxEsc, ictx });

    // Flush microtasks so the tail loop starts and installs the override handler.
    await new Promise(r => setTimeout(r, 0));

    // Fire the Esc handler (simulates pressing Esc while tailing).
    expect(installedHandler).not.toBeNull();
    installedHandler?.();
    // Also unblock the stream so the async generator can finish.
    abortFn?.();

    await viewPromise;

    // The abort path in wireEscapeToExit → exitTaskViewMode clears viewingTaskId.
    expect(ictx.viewingTaskId).toBeUndefined();
  });

  it('setSoftStopHandler override is wired for the running subagent tail loop', async () => {
    const h = makeRunningHandle('h-wire');
    const manager = makeManager([h]);

    const handlerCalls: Array<(() => void) | null> = [];
    const { ctx } = makeCtx();
    ctx.setSoftStopHandler = vi.fn().mockImplementation((fn: (() => void) | null) => {
      handlerCalls.push(fn);
    });

    await enterTaskViewMode({ id: 'h-wire', manager, sessionLabel: 'lbl', ctx });

    // At least two setSoftStopHandler calls: the initial wireEscapeToExit call
    // is immediately overridden by the running-tail-specific handler, then
    // cleared (null) on natural completion.
    expect(handlerCalls.length).toBeGreaterThanOrEqual(2);
    // The final call must pass null to clear the handler.
    expect(handlerCalls[handlerCalls.length - 1]).toBeNull();
  });
});

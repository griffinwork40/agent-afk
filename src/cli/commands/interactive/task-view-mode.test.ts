/**
 * Tests for the live-tail loop in enterTaskViewMode — issue #1333.
 *
 * Covers:
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

import { enterTaskViewMode } from './task-view-mode.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { SubagentHandle } from '../../../agent/subagent/handle.js';
import type { SlashContext, SessionStats } from '../../slash/types.js';
import type { InteractiveCtx } from './shared.js';
import type { OutputEvent } from '../../../agent/types/session-types.js';

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

function makeManager(handles: SubagentHandle[]): SubagentManager {
  return {
    list: () => handles.map(h => ({ id: h.id, status: h.status })),
    get:  (id: string) => handles.find(h => h.id === id),
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
 * The returned factory closes over `shouldStop` so tests can make the stream
 * terminate without an abort (for the "Esc stops the loop" assertion).
 */
function makePollingStream(): {
  streamFactory: () => AsyncIterable<OutputEvent>;
  stop: () => void;
} {
  let stopped = false;
  async function* gen(): AsyncGenerator<OutputEvent> {
    let i = 0;
    while (!stopped) {
      yield { type: 'chunk', chunk: { type: 'content', content: `tick-${i++}` } } as OutputEvent;
      // Yield the microtask queue so the event loop can fire the abort handler.
      await new Promise<void>(r => setImmediate(r));
    }
  }
  return {
    streamFactory: () => gen(),
    stop: () => { stopped = true; },
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
    const { streamFactory, stop } = makePollingStream();
    const handle  = makeRunningHandle('esc-1', streamFactory);
    const manager = makeManager([handle]);
    const { ctx, fireSoftStop } = makeCtx();
    const ictx = makeICtx({ viewingTaskId: 'esc-1' });

    const viewPromise = enterTaskViewMode({ id: 'esc-1', manager, sessionLabel: 'lbl', ctx, ictx });

    // Let the tail loop start (generator yields its first chunk).
    await ticks(3);

    // Fire Esc — this calls abort.abort() internally AND exitTaskViewMode.
    fireSoftStop();
    // Stop the generator too so it doesn't keep yielding after the test.
    stop();

    await viewPromise;

    // exitTaskViewMode calls repaintStatusLine.
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalled();
  });

  it('does NOT emit FOOTER_COMPLETE when Esc fires', async () => {
    const { streamFactory, stop } = makePollingStream();
    const handle  = makeRunningHandle('esc-2', streamFactory);
    const manager = makeManager([handle]);
    const { ctx, lines, fireSoftStop } = makeCtx();

    const viewPromise = enterTaskViewMode({ id: 'esc-2', manager, sessionLabel: 'lbl', ctx });
    await ticks(3);
    fireSoftStop();
    stop();
    await viewPromise;

    // FOOTER_COMPLETE is only emitted by the non-aborted finally branch.
    // The running footer (before tail) says "running"; complete footer says "complete".
    const completeLine = lines.filter(l => l.includes('complete') && l.includes('Esc'));
    expect(completeLine.length).toBe(0);
  });

  it('clears viewingTaskId on ictx when Esc fires', async () => {
    const { streamFactory, stop } = makePollingStream();
    const handle  = makeRunningHandle('esc-3', streamFactory);
    const manager = makeManager([handle]);
    const { ctx, fireSoftStop } = makeCtx();
    const ictx = makeICtx({ viewingTaskId: 'esc-3' });

    const viewPromise = enterTaskViewMode({ id: 'esc-3', manager, sessionLabel: 'lbl', ctx, ictx });
    await ticks(3);
    fireSoftStop();
    stop();
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

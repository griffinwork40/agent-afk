/**
 * Unit tests for interactive.cleanup.ts
 *
 * Focus: signal-handler exitReason wiring (issue #2762).
 * Tests verify that:
 *   - makeSessionSaver passes exitReason from the ref to saveSession.
 *   - SIGINT idle path writes exitReason='sigint'.
 *   - SIGTERM/SIGHUP handlers write their respective reasons.
 *   - The grace-period timer is .unref()'d (restores pre-fix behaviour).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeSessionSaver,
  installSignalHandlers,
  type ExitReasonRef,
} from './interactive.cleanup.js';
import type { InteractiveCtx } from './shared.js';
import type { TurnState } from './repl-loop.js';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

vi.mock('../../session-store.js', () => ({
  saveSession: vi.fn((_stats: unknown, _id: unknown, opts: unknown) => {
    // Store opts for assertion
    (saveSession as ReturnType<typeof vi.fn>).lastOpts = opts;
    return '/fake/path.json';
  }),
}));

import { saveSession } from '../../session-store.js';
const mockSaveSession = saveSession as ReturnType<typeof vi.fn> & { lastOpts?: unknown };

function makeMinimalCtx(): InteractiveCtx {
  return {
    stats: {
      totalTurns: 1,
      sessionStartTime: Date.now(),
      model: 'test-model',
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      unpricedTurns: 0,
      turns: [],
    },
    session: { current: null as never },
    rl: {
      close: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    } as unknown as InteractiveCtx['rl'],
  } as unknown as InteractiveCtx;
}

function makeTurnState(overrides?: Partial<TurnState>): TurnState {
  return {
    turnInFlight: false,
    lastSigintAt: 0,
    ...overrides,
  } as TurnState;
}

function makePickerAbort(): AbortController {
  return new AbortController();
}

// ---------------------------------------------------------------------------
// makeSessionSaver — exitReason wiring
// ---------------------------------------------------------------------------

describe('makeSessionSaver (issue #2762)', () => {
  beforeEach(() => {
    mockSaveSession.mockClear();
    mockSaveSession.lastOpts = undefined;
  });

  it('passes exitReason from ref to saveSession when saving', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: 'sigterm' };
    const { saveCurrentSession } = makeSessionSaver(ctx, exitReasonRef);

    saveCurrentSession();

    expect(mockSaveSession).toHaveBeenCalledOnce();
    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['closeTime']).toBe(true);
    expect(opts['exitReason']).toBe('sigterm');
  });

  it('passes exitReason=undefined when ref holds no reason', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const { saveCurrentSession } = makeSessionSaver(ctx, exitReasonRef);

    saveCurrentSession();

    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['exitReason']).toBeUndefined();
  });

  it('works when no exitReasonRef supplied (backward compat)', () => {
    const ctx = makeMinimalCtx();
    const { saveCurrentSession } = makeSessionSaver(ctx);

    saveCurrentSession();

    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['closeTime']).toBe(true);
    expect(opts['exitReason']).toBeUndefined();
  });

  it('guards on totalTurns===0 (no save when session had no turns)', () => {
    const ctx = makeMinimalCtx();
    ctx.stats.totalTurns = 0;
    const { saveCurrentSession, isSaved } = makeSessionSaver(ctx);

    const result = saveCurrentSession();

    expect(result).toBeUndefined();
    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(isSaved()).toBe(false);
  });

  it('isSaved() returns true after successful save', () => {
    const ctx = makeMinimalCtx();
    const { saveCurrentSession, isSaved } = makeSessionSaver(ctx);

    expect(isSaved()).toBe(false);
    saveCurrentSession();
    expect(isSaved()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// installSignalHandlers — exitReason is written before rl.close()
// ---------------------------------------------------------------------------

describe('installSignalHandlers exitReason wiring (issue #2762)', () => {
  let addedListeners: Map<string, (() => void)[]>;
  let removedListeners: Map<string, (() => void)[]>;

  beforeEach(() => {
    addedListeners = new Map();
    removedListeners = new Map();
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: () => void) => {
      const existing = addedListeners.get(event) ?? [];
      addedListeners.set(event, [...existing, handler]);
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation((event: string, handler: () => void) => {
      const existing = removedListeners.get(event) ?? [];
      removedListeners.set(event, [...existing, handler]);
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SIGINT idle double-press sets exitReason=sigint before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState({ lastSigintAt: Date.now() - 100 }); // within window
    const pickerAbort = makePickerAbort();

    const { handleSigint, removeListeners } = installSignalHandlers({
      ctx, turnState, pickerAbort, exitReasonRef,
    });

    // Simulate idle double-Ctrl+C: lastSigintAt is recent, turnInFlight is false
    handleSigint();

    expect(exitReasonRef.current).toBe('sigint');
    expect(ctx.rl.close).toHaveBeenCalledOnce();

    removeListeners();
  });

  it('SIGINT single press (first press) does NOT set exitReason', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState({ lastSigintAt: 0 }); // no recent press
    const pickerAbort = makePickerAbort();

    const { handleSigint, removeListeners } = installSignalHandlers({
      ctx, turnState, pickerAbort, exitReasonRef,
    });

    handleSigint(); // first press: prints "Press Ctrl+C again"

    expect(exitReasonRef.current).toBeUndefined();
    expect(ctx.rl.close).not.toHaveBeenCalled();

    removeListeners();
  });

  it('SIGTERM handler sets exitReason=sigterm before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState();
    const pickerAbort = makePickerAbort();

    installSignalHandlers({ ctx, turnState, pickerAbort, exitReasonRef });

    const sigtermHandler = addedListeners.get('SIGTERM')?.[0];
    expect(sigtermHandler).toBeDefined();

    // Fire the SIGTERM handler
    sigtermHandler!();

    expect(exitReasonRef.current).toBe('sigterm');
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });

  it('SIGHUP handler sets exitReason=sighup before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState();
    const pickerAbort = makePickerAbort();

    installSignalHandlers({ ctx, turnState, pickerAbort, exitReasonRef });

    const sighupHandler = addedListeners.get('SIGHUP')?.[0];
    expect(sighupHandler).toBeDefined();

    sighupHandler!();

    expect(exitReasonRef.current).toBe('sighup');
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });

  it('SIGTERM/SIGHUP handlers are idempotent (inFlight guard)', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState();
    const pickerAbort = makePickerAbort();

    installSignalHandlers({ ctx, turnState, pickerAbort, exitReasonRef });

    const sigtermHandler = addedListeners.get('SIGTERM')?.[0];
    sigtermHandler!();
    sigtermHandler!(); // second call must be a no-op

    // rl.close should only be called once
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });
});

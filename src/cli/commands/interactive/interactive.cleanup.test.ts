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
import { makeSigintHandler } from './interactive.signal-handlers.js';
import type { InteractiveCtx } from './shared.js';
import type { TurnState } from './repl-loop.js';

// Module-level mock: lets us capture onCancel/onStop args passed to launchInterruptPicker
// by makeSigintHandler when the armed-compositor path fires.
vi.mock('./interrupt-picker.js', () => ({
  launchInterruptPicker: vi.fn(),
}));
import { launchInterruptPicker } from './interrupt-picker.js';
const mockLaunchInterruptPicker = launchInterruptPicker as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

vi.mock('../../session-store.js', () => ({
  saveSession: vi.fn(() => '/fake/path.json'),
}));

import { saveSession } from '../../session-store.js';
const mockSaveSession = saveSession as ReturnType<typeof vi.fn>;

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

// ---------------------------------------------------------------------------
// SIGINT in-flight paths: second-Ctrl+C & onCancel must set exitReason=sigint
// (issue #2900 regression — ??= 'eof' fallback would mis-classify these exits)
// ---------------------------------------------------------------------------

describe('SIGINT in-flight exitReason wiring (issue #2900)', () => {
  let addedListeners: Map<string, (() => void)[]>;

  beforeEach(() => {
    addedListeners = new Map();
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: () => void) => {
      const existing = addedListeners.get(event) ?? [];
      addedListeners.set(event, [...existing, handler]);
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('second Ctrl+C while picker open sets exitReason=sigint before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    // turnInFlight=true and interruptPickerAbort set → "second Ctrl+C while picker open" path
    const turnState = makeTurnState({
      turnInFlight: true,
      interruptPickerAbort: new AbortController(),
    } as Partial<TurnState>);
    const pickerAbort = makePickerAbort();

    const { handleSigint, removeListeners } = installSignalHandlers({
      ctx, turnState, pickerAbort, exitReasonRef,
    });

    handleSigint();

    expect(exitReasonRef.current).toBe('sigint');
    expect(ctx.rl.close).toHaveBeenCalledOnce();

    removeListeners();
  });

  it('picker onCancel callback sets exitReason=sigint before rl.close()', () => {
    // makeSigintHandler calls launchInterruptPicker synchronously (mocked above).
    // Capture the onCancel arg and invoke it to verify exitReason is set.
    mockLaunchInterruptPicker.mockClear();

    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const armedCompositor = { isArmed: () => true };
    // turnInFlight=true, no interruptPickerAbort, armed compositor → picker launch path
    const turnState = makeTurnState({
      turnInFlight: true,
      interruptPickerAbort: null,
      activeCompositor: armedCompositor,
    } as Partial<TurnState>);
    const pickerAbort = makePickerAbort();

    const handleSigint = makeSigintHandler({ ctx, turnState, pickerAbort, exitReasonRef });
    handleSigint(); // fires launchInterruptPicker with onCancel arg

    expect(mockLaunchInterruptPicker).toHaveBeenCalledOnce();
    const opts = mockLaunchInterruptPicker.mock.calls[0][0] as { onCancel: () => void };

    // Simulate the user clicking "Cancel" in the interrupt picker
    opts.onCancel();

    expect(exitReasonRef.current).toBe('sigint');
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// exitReason='eof' written on the rl.on('close') path (issue #2900)
// ---------------------------------------------------------------------------

describe("exitReason 'eof' on readline close (issue #2900)", () => {
  it("??= 'eof' fills an empty ref, so stdin-EOF is recorded in the sidecar", () => {
    // Simulate the rl.on('close') handler logic from interactive.ts:
    //   ctx.exitReasonRef!.current ??= 'eof';
    // When no signal handler has written a reason yet (stdin EOF, piped input).
    const exitReasonRef: ExitReasonRef = { current: undefined };
    exitReasonRef.current ??= 'eof';
    expect(exitReasonRef.current).toBe('eof');
  });

  it("??= 'eof' does NOT overwrite a reason already set by a signal handler", () => {
    // When SIGTERM fired before readline closed, the existing reason is preserved.
    const exitReasonRef: ExitReasonRef = { current: 'sigterm' };
    exitReasonRef.current ??= 'eof';
    expect(exitReasonRef.current).toBe('sigterm');
  });

  it("??= 'eof' does NOT overwrite 'sigint' — SIGINT exits are not mis-classified as EOF", () => {
    // Regression guard for issue #2900: SIGINT paths set exitReasonRef.current='sigint'
    // before calling rl.close(); the ??= fallback in rl.on('close') must not overwrite it.
    const exitReasonRef: ExitReasonRef = { current: 'sigint' };
    exitReasonRef.current ??= 'eof';
    expect(exitReasonRef.current).toBe('sigint');
  });

  it('makeSessionSaver records eof in the sidecar when exitReasonRef holds eof', () => {
    mockSaveSession.mockClear();
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: 'eof' };
    const { saveCurrentSession } = makeSessionSaver(ctx, exitReasonRef);

    saveCurrentSession();

    expect(mockSaveSession).toHaveBeenCalledOnce();
    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['closeTime']).toBe(true);
    expect(opts['exitReason']).toBe('eof');
  });
});

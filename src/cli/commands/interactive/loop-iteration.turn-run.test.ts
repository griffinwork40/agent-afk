/**
 * Integration test for runOneTurn — asserts that PauseController.instance().check()
 * is called with the session's abortSignal at the top of every turn.
 *
 * Issue #4723: PR #4713 wired ctx.session.current.abortSignal into
 * PauseController.instance().check() but no integration test asserted the
 * forwarding. This file closes that gap.
 *
 * Strategy: mock PauseController so instance() returns a stub whose check()
 * is a vi.fn(). After calling runOneTurn, assert check() was called with the
 * exact AbortSignal that lives on ctx.session.current.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports so vi.mock hoisting applies
// ---------------------------------------------------------------------------

// Hoisted spy references shared with the mock factories.
const pauseCheckSpy = vi.hoisted(() => vi.fn<[AbortSignal | undefined], Promise<void>>().mockResolvedValue(undefined));
const pauseConsumeLastPauseDurationSpy = vi.hoisted(() => vi.fn<[], number | undefined>().mockReturnValue(undefined));

vi.mock('../../../agent/session/pause-controller.js', () => ({
  PauseController: {
    instance: () => ({
      check: pauseCheckSpy,
      consumeLastPauseDuration: pauseConsumeLastPauseDurationSpy,
    }),
  },
}));

vi.mock('./turn-handler.js', () => ({
  runTurn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./momentum-ticker.js', () => ({
  MomentumTicker: class {
    start() {}
    stop() {}
    update() {}
  },
}));

vi.mock('../../code-block-register.js', () => ({
  enableCodeBlockRegister: vi.fn(),
  resetCodeBlockRegister: vi.fn(),
}));

vi.mock('./loop-iteration.injections.js', () => ({
  markPresenceTurn: vi.fn(),
}));

vi.mock('../../session-store.js', () => ({
  saveSession: vi.fn(),
}));

vi.mock('../../palette.js', () => ({
  palette: { warning: (s: string) => s },
}));

vi.mock('./shared.js', () => ({
  formatStatusFields: vi.fn(() => ({})),
}));

vi.mock('./repl-loop-shared.js', () => ({
  buildPrompt: vi.fn(() => 'afk › '),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are declared
// ---------------------------------------------------------------------------

import { runOneTurn } from './loop-iteration.turn-run.js';
import type { InteractiveCtx } from './shared.js';
import type { TurnState } from './repl-loop-shared.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeCtx(abortSignal: AbortSignal): InteractiveCtx {
  return {
    session: {
      current: {
        sessionId: 'mock-session',
        abortSignal,
        waitForInitialization: vi.fn(async () => ({})),
      },
    },
    stats: {
      totalTurns: 0,
      model: 'sonnet',
      permissionMode: 'default',
      sessionId: 'mock-session',
    },
    statusLine: {
      rearm: vi.fn(),
      repaint: vi.fn(),
    },
    contextSampler: {
      onTurn: vi.fn(async () => {}),
      getRatio: () => undefined,
      refresh: vi.fn(async () => {}),
    },
    gitStatusSampler: {
      refresh: vi.fn(async () => {}),
      setOnUpdate: vi.fn(),
      getBranch: () => undefined,
      getPr: () => undefined,
    },
    completionWriter: { fn: vi.fn(), idleFn: vi.fn() },
    replRenderer: { writeLine: vi.fn(), setCompositor: vi.fn() },
    options: { thinkingUi: undefined },
  } as unknown as InteractiveCtx;
}

function makeTurnState(): TurnState {
  return {
    turnInFlight: false,
    lastSigintAt: 0,
    activeCompositor: null,
    notifyInterrupting: null,
    interruptPickerAbort: null,
  } as unknown as TurnState;
}

function makeFooter() {
  return {
    verdictLedger: { push: vi.fn(), render: () => null },
    loopStageBar: null,
    mascotBar: { onStage: vi.fn(), releaseBand: vi.fn() },
    healthRail: null,
    bgResultNotifier: { observeToolEvent: vi.fn() },
  };
}

function makeTranscript() {
  return {
    path: () => '/tmp/mock',
    appendUser: vi.fn(async () => {}),
    appendQueuedUser: vi.fn(async () => {}),
    appendTurn: vi.fn(async () => {}),
  };
}

function makeSurface() {
  return {
    getCompositor: vi.fn(() => null),
    setBackgroundHandler: vi.fn(),
    setTaskViewHandler: vi.fn(),
    setPausedState: vi.fn(),
    setPauseInterruptHandler: vi.fn(),
    toRunTurnRefs: vi.fn(() => ({})),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runOneTurn — PauseController.check() abort-signal forwarding (#4723)', () => {
  beforeEach(() => {
    pauseCheckSpy.mockClear();
    pauseConsumeLastPauseDurationSpy.mockClear();
    pauseCheckSpy.mockResolvedValue(undefined);
    pauseConsumeLastPauseDurationSpy.mockReturnValue(undefined);
  });

  it('calls PauseController.instance().check() with ctx.session.current.abortSignal', async () => {
    const abortSignal = makeAbortSignal();
    const ctx = makeCtx(abortSignal);

    await runOneTurn(
      'hello',
      [],
      ctx,
      makeTurnState(),
      makeFooter() as never,
      makeTranscript() as never,
      makeSurface() as never,
      vi.fn(),       // installSoftStop
      undefined,     // maxTurnsNum
      [false],       // autosaveState
      'hello',       // rawUserText
    );

    // check() must have been called at least once — at the top of the turn.
    expect(pauseCheckSpy).toHaveBeenCalled();

    // The first call must carry the session's abortSignal — this is the
    // wiring introduced by PR #4713.
    const [firstCallSignal] = pauseCheckSpy.mock.calls[0]!;
    expect(firstCallSignal).toBe(abortSignal);
  });

  it('passes a distinct signal per session — no cross-turn signal leakage', async () => {
    // Guard against accidental singleton leakage: two independent ctx objects
    // each carry their own AbortSignal; check() must receive the right one.
    const signalA = makeAbortSignal();
    const signalB = makeAbortSignal();

    // Turn A
    await runOneTurn(
      'turn A',
      [],
      makeCtx(signalA),
      makeTurnState(),
      makeFooter() as never,
      makeTranscript() as never,
      makeSurface() as never,
      vi.fn(),
      undefined,
      [false],
      'turn A',
    );
    const signalPassedForA = pauseCheckSpy.mock.calls[0]?.[0];

    pauseCheckSpy.mockClear();

    // Turn B
    await runOneTurn(
      'turn B',
      [],
      makeCtx(signalB),
      makeTurnState(),
      makeFooter() as never,
      makeTranscript() as never,
      makeSurface() as never,
      vi.fn(),
      undefined,
      [false],
      'turn B',
    );
    const signalPassedForB = pauseCheckSpy.mock.calls[0]?.[0];

    expect(signalPassedForA).toBe(signalA);
    expect(signalPassedForB).toBe(signalB);
    expect(signalPassedForA).not.toBe(signalPassedForB);
  });
});

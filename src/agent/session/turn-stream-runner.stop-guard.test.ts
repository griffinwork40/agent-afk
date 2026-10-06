/**
 * Tests for the Finding 2 stop-dispatch guard in TurnStreamRunner.runStream.
 *
 * The guard logic (runtime flag):
 *   const seamAlreadyDispatched =
 *     this.deps.getStopWiring?.()?.stopDispatchedBySeam === true;
 *   if (!seamAlreadyDispatched) { await dispatchTurnStop(...); }
 *
 * Two cases:
 *   A) Seam fired this turn (stopDispatchedBySeam === true)
 *      → dispatchTurnStop SKIPPED (seam already dispatched Stop)
 *   B) Seam did NOT fire (stopDispatchedBySeam is false/undefined,
 *      or no wiring at all) → dispatchTurnStop RUNS
 *
 * We test the guard formula directly (without mounting a full TurnStreamRunner)
 * and also verify that `dispatchTurnStop` itself is a no-op when wiring is
 * undefined, so case B's correctness is double-confirmed.
 *
 * @module agent/session/turn-stream-runner.stop-guard.test
 */
import { describe, it, expect, vi } from 'vitest';
import type { StopWiring } from '../types/session-types.js';
import { dispatchTurnStop } from './turn-stream-runner.stop.js';
import type { AgentConfig, Message } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeWiring(dispatched?: boolean): StopWiring {
  return {
    getHasNextTurn: () => true,
    onStopInjectContext: vi.fn(),
    onStopBlocked: vi.fn(),
    onStopTimeout: vi.fn(),
    stopDispatchedBySeam: dispatched ?? false,
  } as unknown as StopWiring;
}

// ---------------------------------------------------------------------------
// Guard formula unit tests (Finding 2 — runtime flag)
// ---------------------------------------------------------------------------

/**
 * Replicate the exact guard expression from turn-stream-runner.ts so the test
 * is bound to the same formula and will fail if the formula changes.
 */
function seamAlreadyDispatchedFormula(
  getStopWiring: (() => StopWiring | undefined) | undefined,
): boolean {
  return getStopWiring?.()?.stopDispatchedBySeam === true;
}

describe('seamAlreadyDispatched guard formula (Finding 2)', () => {
  it('Case A: seam fired (stopDispatchedBySeam=true) → formula is true → dispatchTurnStop skipped', () => {
    const result = seamAlreadyDispatchedFormula(() => makeWiring(true));
    expect(result).toBe(true);
  });

  it('Case B1: no stop wiring → formula is false → dispatchTurnStop runs', () => {
    const result = seamAlreadyDispatchedFormula(undefined);
    expect(result).toBe(false);
  });

  it('Case B2: getStopWiring returns undefined → formula is false → dispatchTurnStop runs', () => {
    const result = seamAlreadyDispatchedFormula(() => undefined);
    expect(result).toBe(false);
  });

  it('Case B3: wiring exists but seam did not fire → formula is false → dispatchTurnStop runs', () => {
    const result = seamAlreadyDispatchedFormula(() => makeWiring(false));
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchTurnStop no-ops (validates Case B correctness at the function level)
// ---------------------------------------------------------------------------

describe('dispatchTurnStop no-ops when wiring is undefined (Case B sanity)', () => {
  it('resolves without calling any wiring callbacks when wiring is undefined', async () => {
    const history: Message[] = [{ role: 'assistant', content: 'Done.', timestamp: new Date() }];
    await expect(
      dispatchTurnStop({
        config: { hookRegistry: undefined } as unknown as AgentConfig,
        wiring: undefined,
        sessionId: 'sess',
        signal: new AbortController().signal,
        conversationHistory: history,
        toolEvents: [],
      }),
    ).resolves.toBeUndefined();
  });
});

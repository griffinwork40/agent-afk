/**
 * Tests for the openai-compatible overload-pause tier (#2419).
 *
 * Mirrors the anthropic-direct counterpart
 * (`anthropic-direct/query/overload-pause-tier.test.ts`) but uses the
 * openai-compatible signal shape: an `{ type:'error' }` event with status 529
 * or 503 (exhausted stream retries on this wire).
 *
 * Invariants under test:
 *  - Interactive surfaces (cli/repl/telegram/web) pause and re-probe.
 *  - Daemon/cron fail fast (ceilingMs === 0): error event forwarded.
 *  - Abort always wins over a pause; returns null without error event.
 *  - Close during a pause returns null WITHOUT forwarding the error event
 *    (driveStream's close contract).
 *  - Ceiling exhaustion ends with a clean commit path: emits an
 *    `assistant.message` notice and returns a synthetic IterationResult
 *    carrying finishReason: OVERLOAD_EXHAUSTED (no tool dispatch) so
 *    turn-driver.ts calls finishTurn → turn.completed carries the sentinel.
 *  - `stream.retry` is emitted before each replay to clear stale paint.
 *  - `overload_pause` / `overload_resume` trace phases match the
 *    anthropic-direct tier's contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIError } from 'openai';
import type { ProviderEvent } from '../../../provider.js';
import {
  runIterationWithOverloadPause,
  isOverloadErrorEvent,
  OPENAI_COMPAT_OVERLOAD_EXHAUSTED_NOTICE,
  type OverloadPauseTierContext,
} from './overload-pause-tier.js';
import { OVERLOAD_EXHAUSTED } from '../../shared/overload-sentinel.js';
import type { IterationResult } from './stream-drive.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal IterationResult for a clean (non-tool) completion. */
const cleanResult: IterationResult = {
  state: {
    assistantText: 'hello',
    reasoningText: '',
    finishReason: 'stop',
    toolCallsByIndex: new Map(),
  },
  events: [],
  text: 'hello',
  needsToolDispatch: false,
};

/** Build an error event with the given HTTP status code. */
function overloadError(status: 529 | 503): ProviderEvent {
  const err = new Error(`http ${status}`) as Error & { status: number };
  err.status = status;
  return { type: 'error', error: err };
}

const err529 = overloadError(529);
const err503 = overloadError(503);

/** A normal error (400) that is NOT an overload error. */
function clientError(): ProviderEvent {
  const err = new Error('bad request') as Error & { status: number };
  err.status = 400;
  return { type: 'error', error: err };
}

/**
 * Build a factory for `makeIteration` that returns a fresh generator on each
 * call. Scripted: the i-th call returns the i-th events array (cycling on the
 * last one). Captures the return value of each generator for the return slot.
 */
function scriptIterations(
  ...attempts: { events: ProviderEvent[]; result: IterationResult | null }[]
): {
  makeIteration: () => AsyncGenerator<ProviderEvent, IterationResult | null>;
  callCount: () => number;
} {
  let i = 0;
  let count = 0;
  return {
    makeIteration() {
      const attempt = attempts[Math.min(i, attempts.length - 1)] ?? { events: [], result: null };
      i++;
      count++;
      return (async function* (): AsyncGenerator<ProviderEvent, IterationResult | null> {
        for (const e of attempt.events) yield e;
        return attempt.result;
      })();
    },
    callCount: () => count,
  };
}

/**
 * Drain the tier generator to completion, collecting yielded events and the
 * typed return value.
 */
async function drain(
  gen: AsyncGenerator<ProviderEvent, IterationResult | null>,
): Promise<{ events: ProviderEvent[]; result: IterationResult | null }> {
  const events: ProviderEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

function makeCtx(surface: string | undefined, ac = new AbortController()): OverloadPauseTierContext {
  return {
    surface,
    traceWriter: undefined,
    signal: ac.signal,
    isClosed: () => false,
    sessionId: 'sess-test',
  };
}

// ---------------------------------------------------------------------------
// isOverloadErrorEvent
// ---------------------------------------------------------------------------

describe('isOverloadErrorEvent', () => {
  it('matches 529', () => expect(isOverloadErrorEvent(err529)).toBe(true));
  it('matches 503', () => expect(isOverloadErrorEvent(err503)).toBe(true));
  it('does not match a 400', () => expect(isOverloadErrorEvent(clientError())).toBe(false));
  it('does not match delta.text', () =>
    expect(isOverloadErrorEvent({ type: 'delta.text', text: 'hi', sessionId: 's' })).toBe(false));
  it('does not match an error with no status', () =>
    expect(isOverloadErrorEvent({ type: 'error', error: new Error('generic') })).toBe(false));
  it('matches a status-less SDK mid-stream overload throw', () => {
    // openai's stream iterator: new APIError(undefined, data.error, undefined, headers)
    const err = new APIError(
      undefined,
      { message: 'Our servers are currently overloaded. Please try again later.' },
      undefined,
      new Headers(),
    );
    expect(isOverloadErrorEvent({ type: 'error', error: err })).toBe(true);
  });
  it('does not match a status-less unrelated SDK error', () => {
    const err = new APIError(undefined, { type: 'invalid_request_error', message: 'bad' }, undefined, new Headers());
    expect(isOverloadErrorEvent({ type: 'error', error: err })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-fast surfaces (daemon/cron)
// ---------------------------------------------------------------------------

describe('overload pause tier — fail-fast surfaces', () => {
  beforeEach(() => { delete process.env['AFK_OVERLOAD_PAUSE_MS']; });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  it('does not park a daemon surface — forwards the error event immediately', async () => {
    const { makeIteration, callCount } = scriptIterations({
      events: [err529],
      result: null,
    });

    const { events, result } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('daemon')),
    );

    expect(callCount()).toBe(1);
    expect(result).toBeNull();
    // Daemon fail-fast: error event must be forwarded so the turn seals.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    const e = events[0];
    if (e?.type === 'error') expect((e.error as { status?: number }).status).toBe(529);
  });

  it('does not park when surface is undefined (forked-child default)', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx(undefined)),
    );
    expect(callCount()).toBe(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('forwards a 503 error on daemon the same way as 529', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [err503], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('daemon')),
    );
    expect(callCount()).toBe(1);
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
  });

  it('passes a clean result through with no overload handling', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [], result: cleanResult });
    const { events, result } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('daemon')),
    );
    expect(callCount()).toBe(1);
    expect(events).toHaveLength(0);
    expect(result).toEqual(cleanResult);
  });

  it('honors AFK_OVERLOAD_PAUSE_MS=0 on an interactive surface', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '0';
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('cli')),
    );
    expect(callCount()).toBe(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('does not intercept a non-overload error on an interactive surface', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [clientError()], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('cli')),
    );
    expect(callCount()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Interactive pause + replay
// ---------------------------------------------------------------------------

describe('overload pause tier — interactive pause + replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  it('parks a cli session, re-probes, and returns the clean result on recovery', async () => {
    const { makeIteration, callCount } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
    // Advance past the probe interval (60-120s).
    await vi.advanceTimersByTimeAsync(130_000);
    const { events, result } = await promise;

    expect(callCount()).toBe(2);
    // The overload error was swallowed — caller sees no error.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(result).toEqual(cleanResult);
  });

  it('parks a repl surface the same way as cli', async () => {
    const { makeIteration, callCount } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('repl')));
    await vi.advanceTimersByTimeAsync(130_000);
    const { result } = await promise;
    expect(callCount()).toBe(2);
    expect(result).toEqual(cleanResult);
  });

  it('parks a telegram surface the same way as cli', async () => {
    const { makeIteration, callCount } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('telegram')));
    await vi.advanceTimersByTimeAsync(130_000);
    const { result } = await promise;
    expect(callCount()).toBe(2);
    expect(result).toEqual(cleanResult);
  });

  it.each([
    { label: 'shortest probe draws (60s)', random: 0, expectedCalls: 4 },
    { label: 'longest probe draws (~120s)', random: 0.999999, expectedCalls: 3 },
  ])(
    'ends with OVERLOAD_EXHAUSTED sentinel at the wall-clock ceiling ($label)',
    async ({ random, expectedCalls }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      process.env['AFK_OVERLOAD_PAUSE_MS'] = '150000'; // 2.5 min
      // Never recovers.
      const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
      const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
      await vi.advanceTimersByTimeAsync(600_000);
      const { events, result } = await promise;

      expect(callCount()).toBe(expectedCalls);
      // No raw error event forwarded -- the tier commits through the normal path.
      expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
      // The tier emits an assistant.message notice before returning.
      const notices = events.filter((e) => e.type === 'assistant.message');
      expect(notices).toHaveLength(1);
      const notice = notices[0];
      if (notice?.type === 'assistant.message') {
        expect(notice.text).toBe(OPENAI_COMPAT_OVERLOAD_EXHAUSTED_NOTICE);
      }
      // The return value is a synthetic IterationResult with OVERLOAD_EXHAUSTED.
      expect(result).not.toBeNull();
      expect(result?.needsToolDispatch).toBe(false);
      expect(result?.state.finishReason).toBe(OVERLOAD_EXHAUSTED);
    },
  );

  it('terminal event on ceiling exhaustion: finishReason is OVERLOAD_EXHAUSTED', async () => {
    // This is the blocking spec-compliance test. On ceiling exhaustion the tier
    // must return an IterationResult carrying OVERLOAD_EXHAUSTED so that
    // turn-driver.ts's call to finishTurn stamps the sentinel on turn.completed --
    // making the turn commit and keeping afk --resume functional.
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '1'; // instant ceiling
    const { makeIteration } = scriptIterations({ events: [err529], result: null });
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
    await vi.advanceTimersByTimeAsync(1_000);
    const { result, events } = await promise;

    expect(result).not.toBeNull();
    expect(result?.state.finishReason).toBe(OVERLOAD_EXHAUSTED);
    expect(result?.needsToolDispatch).toBe(false);
    // No raw error event -- the turn commits through the normal path.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    // The operator-facing notice is emitted.
    expect(events.some((e) => e.type === 'assistant.message')).toBe(true);
  });

  it('lets an abort during the pause win immediately (no replay)', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const ac = new AbortController();
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli', ac)));

    await vi.advanceTimersByTimeAsync(100); // tier enters pause
    ac.abort('interrupted');
    await vi.advanceTimersByTimeAsync(200_000);
    const { events, result } = await promise;

    expect(callCount()).toBe(1);
    expect(result).toBeNull();
    // Abort during the sleep exits without forwarding the error event.
    // turn-driver.ts synthesizes an interrupted terminal via finishTurn.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('returns null without forwarding error when the session closes during the pause', async () => {
    // Close matches driveStream's close contract: return null, no error event.
    // The turn-driver synthesizes the terminal (finishTurn) when it sees null
    // with signal.aborted||ctx.closed, so the session seals correctly.
    let closed = false;
    const ctx: OverloadPauseTierContext = {
      surface: 'cli',
      traceWriter: undefined,
      signal: new AbortController().signal,
      isClosed: () => closed,
      sessionId: 'sess-test',
    };
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));

    await vi.advanceTimersByTimeAsync(100);
    closed = true;
    await vi.advanceTimersByTimeAsync(200_000);
    const { events, result } = await promise;

    expect(callCount()).toBe(1);
    expect(result).toBeNull();
    // No error forwarded on close -- matches driveStream's close contract.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trace fidelity and replay hygiene
// ---------------------------------------------------------------------------

describe('overload pause tier -- trace fidelity and replay hygiene', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  function makeCapturingCtx(surface: string): {
    ctx: OverloadPauseTierContext;
    phases: { phase: string; outcome?: unknown; ceilingMs?: unknown }[];
  } {
    const phases: { phase: string; outcome?: unknown; ceilingMs?: unknown }[] = [];
    const ctx: OverloadPauseTierContext = {
      surface,
      signal: new AbortController().signal,
      isClosed: () => false,
      sessionId: 'sess-test',
      traceWriter: {
        write: (row: { kind: string; payload: Record<string, unknown> }) => {
          if (row.kind === 'session_phase') {
            const md = (row.payload['metadata'] ?? {}) as Record<string, unknown>;
            phases.push({
              phase: String(row.payload['phase']),
              outcome: md['outcome'],
              ceilingMs: md['ceilingMs'],
            });
          }
          return Promise.resolve();
        },
      } as OverloadPauseTierContext['traceWriter'],
    };
    return { ctx, phases };
  }

  it('emits overload_pause once and overload_resume (recovered) on a successful re-probe', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    const { makeIteration } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const { ctx, phases } = makeCapturingCtx('cli');
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));
    await vi.advanceTimersByTimeAsync(600_000);
    await promise;

    expect(phases.filter((p) => p.phase === 'overload_pause')).toHaveLength(1);
    const resumes = phases.filter((p) => p.phase === 'overload_resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.outcome).toBe('recovered');
  });

  it('marks a ceiling-reached outcome as ceiling-reached, not recovered', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '150000';
    const { makeIteration } = scriptIterations({ events: [err529], result: null });
    const { ctx, phases } = makeCapturingCtx('cli');
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));
    await vi.advanceTimersByTimeAsync(600_000);
    await promise;

    const resumes = phases.filter((p) => p.phase === 'overload_resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.outcome).toBe('ceiling-reached');
  });

  it('emits stream.retry before the replayed attempt to clear stale paint', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    const textDelta: ProviderEvent = { type: 'delta.text', text: 'recovered', sessionId: 's' };
    const { makeIteration } = scriptIterations(
      { events: [err529], result: null },
      { events: [textDelta], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
    await vi.advanceTimersByTimeAsync(600_000);
    const { events } = await promise;

    const retryIdx = events.findIndex((e) => e.type === 'stream.retry');
    expect(retryIdx).toBeGreaterThan(-1);
    const recoveredIdx = events.findIndex((e) => e.type === 'delta.text');
    expect(recoveredIdx).toBeGreaterThan(retryIdx);
  });

  it('clamps the probe sleep to the remaining ceiling (1ms ceiling)', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '1'; // 1ms -- far below one probe interval
    const { makeIteration } = scriptIterations({ events: [err529], result: null });
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
    // If unclamped, the probe sleep would park for 60+ seconds. The 1ms ceiling
    // ensures the sleep is clamped to 1ms, so the tier settles well within 1s.
    await vi.advanceTimersByTimeAsync(1_000);
    const { events, result } = await promise;

    // Ceiling exhausted -- tier returns OVERLOAD_EXHAUSTED sentinel, no raw error.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(result?.state.finishReason).toBe(OVERLOAD_EXHAUSTED);
  });

  it('does not emit a spurious pause when there is no overload (clean run)', async () => {
    const { makeIteration } = scriptIterations({ events: [], result: cleanResult });
    const { ctx, phases } = makeCapturingCtx('cli');
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));
    await promise;

    expect(phases.filter((p) => p.phase === 'overload_pause')).toHaveLength(0);
    expect(phases.filter((p) => p.phase === 'overload_resume')).toHaveLength(0);
  });
});

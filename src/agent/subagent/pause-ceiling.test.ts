/**
 * Unit tests for {@link PauseAwareCeiling} — the pause-aware wall-clock ceiling
 * for forked sub-agent turns — and its integration with {@link withTimeout}.
 *
 * Regression target: a `/forge` fork dispatched with the default 45-min budget
 * while the provider had parked the account died at exactly dispatch +
 * 2,700,000 ms — 81 seconds AFTER the pause reset — having spent 43m38s of its
 * budget parked and getting ~81s of actual working time. 1h49m of work was lost.
 * The idle watchdog correctly extended over that pause; the wall clock ignored
 * the same signal.
 *
 * Contract pinned here: the budget bounds the child's WORKING time —
 * `effective ceiling = timeoutMs + min(provider-parked time, cap)` — while
 * staying finite, and un-resettable by the child.
 *
 * Fake-timer convention mirrors `idle-watchdog.test.ts` (`vi.useFakeTimers()`):
 * arm → advance → assert fired (or not). Covers:
 *   - no pause event → ceiling fires at the normal deadline (behaviour unchanged)
 *   - the no-extender error message stays byte-for-byte identical
 *   - `paused` carrying resetsAt credits parked time back to the budget
 *   - `rate_limit` carrying retryAfterMs credits parked time back
 *   - credit is bounded by the provider's reported window (an unresumed park
 *     stops accruing at its stated end)
 *   - accumulated extension is capped by SUBAGENT_MAX_PAUSE_EXTENSION_MS, then fires
 *   - ordinary content / thinking / tool / message events NEVER extend (anti-gaming)
 *   - `resumed` banks the closed pause's credit and stops further accrual
 *   - a pause with no knowable window grants nothing
 *   - overlapping pause signals keep the furthest-out reported end
 *   - the TimeoutError message names the pause context when it fires under pause
 *   - an extender that throws never strands the wait
 *   - the real incident timeline now yields a full working budget
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { PauseAwareCeiling, SUBAGENT_MAX_PAUSE_EXTENSION_MS } from './pause-ceiling.js';
import { PAUSE_WINDOW_SLACK_MS } from './pause-window.js';
import { withTimeout, type TimeoutExtender } from '../timeout.js';
import { TimeoutError } from '../../utils/errors.js';
import type { OutputEvent } from '../types/session-types.js';

const BUDGET = 45 * 60_000; // SUBAGENT_DEFAULT_TIMEOUT_MS — the incident's budget

/**
 * Start a never-settling wait guarded by `ceiling`, returning a probe of whether
 * the ceiling has fired yet plus the captured error. The guarded promise never
 * resolves, so the ceiling is the only thing that can end it.
 */
function startGuarded(
  ceiling: TimeoutExtender,
  timeoutMs = BUDGET,
  label?: string,
): { fired: () => boolean; error: () => unknown; done: Promise<void> } {
  let settled = false;
  let captured: unknown;
  const done = withTimeout(new Promise<never>(() => {}), timeoutMs, {
    ...(label !== undefined && { label }),
    extender: ceiling,
  }).catch((err: unknown) => {
    settled = true;
    captured = err;
  });
  return { fired: () => settled, error: () => captured, done };
}

/** Ordinary child-authored progress events — must never extend the ceiling. */
const contentEvent: OutputEvent = { type: 'chunk', chunk: { type: 'content', content: 'hi' } };
const thinkingEvent: OutputEvent = {
  type: 'chunk',
  chunk: { type: 'thinking', thinking: 'hmm' },
};
const toolStartEvent: OutputEvent = {
  type: 'chunk',
  chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'bash', toolInput: 'sleep 600' },
};
const toolResultEvent: OutputEvent = {
  type: 'chunk',
  chunk: { type: 'tool_result', toolUseId: 't1', content: 'done' },
};

describe('PauseAwareCeiling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires at the normal deadline when no pause event arrives', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    expect(run.fired()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await run.done;
    expect(run.fired()).toBe(true);
    expect(run.error()).toBeInstanceOf(TimeoutError);
    expect(ceiling.totalGrantedMs).toBe(0);
  });

  it('leaves the error message byte-for-byte unchanged when no pause was observed', async () => {
    const withCeiling = startGuarded(new PauseAwareCeiling(1_000), 1_000, 'child-1');
    let plain: unknown;
    const withoutCeiling = withTimeout(new Promise<never>(() => {}), 1_000, {
      label: 'child-1',
    }).catch((err: unknown) => {
      plain = err;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([withCeiling.done, withoutCeiling]);

    expect((withCeiling.error() as Error).message).toBe('Operation timed out after 1000ms (child-1)');
    expect((plain as Error).message).toBe('Operation timed out after 1000ms (child-1)');
  });

  it('credits parked time back to the budget on a `paused` event carrying resetsAt', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    // Provider parks the account for 60 min — longer than the whole budget.
    const parkMs = 60 * 60_000;
    ceiling.onEvent({
      type: 'paused',
      reason: 'usage-limit',
      resetsAt: new Date(Date.now() + parkMs),
    });

    // The base budget elapses: pre-fix this is exactly where the child died.
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(run.fired()).toBe(false);
    expect(ceiling.totalGrantedMs).toBeGreaterThan(0);

    // Effective ceiling = budget + credited park (park window + slack), so the
    // remaining wait past the base deadline is the full credited span.
    const creditMs = parkMs + PAUSE_WINDOW_SLACK_MS;
    await vi.advanceTimersByTimeAsync(creditMs - 1);
    expect(run.fired()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await run.done;
    expect(run.fired()).toBe(true);
    expect(ceiling.totalGrantedMs).toBe(creditMs);
  });

  it('credits parked time back on a `rate_limit` event carrying retryAfterMs', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    const retryAfterMs = 50 * 60_000; // 50 min > the 45-min budget
    ceiling.onEvent({ type: 'rate_limit', retryAfterMs });

    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(run.fired()).toBe(false);

    const creditMs = retryAfterMs + PAUSE_WINDOW_SLACK_MS;
    await vi.advanceTimersByTimeAsync(creditMs);
    await run.done;
    expect(run.fired()).toBe(true);
    expect(ceiling.totalGrantedMs).toBe(creditMs);
  });

  it('bounds credit by the provider-reported window when a park never resumes', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    // A 10-min park that is never followed by `resumed`. The child is owed those
    // 10 minutes of working time — and NOT a millisecond more, even though the
    // stream stays silent long after the stated end.
    const parkMs = 10 * 60_000;
    ceiling.onEvent({
      type: 'paused',
      reason: 'usage-limit',
      resetsAt: new Date(Date.now() + parkMs),
    });

    const creditMs = parkMs + PAUSE_WINDOW_SLACK_MS;
    await vi.advanceTimersByTimeAsync(BUDGET + creditMs - 1);
    expect(run.fired()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await run.done;
    expect(run.fired()).toBe(true);
    // Credit stopped accruing at the reported end: strictly bounded.
    expect(ceiling.totalGrantedMs).toBe(creditMs);
  });

  it('caps accumulated extension at SUBAGENT_MAX_PAUSE_EXTENSION_MS and then fires', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    // A pathological/lying provider: re-reports a fresh 1h park every 10 min,
    // which would extend forever if the cap did not exist.
    const stepMs = 10 * 60_000;
    const totalSpanMs = BUDGET + SUBAGENT_MAX_PAUSE_EXTENSION_MS + 2 * 60 * 60_000;
    for (let elapsed = 0; elapsed < totalSpanMs && !run.fired(); elapsed += stepMs) {
      ceiling.onEvent({
        type: 'paused',
        reason: 'usage-limit',
        resetsAt: new Date(Date.now() + 60 * 60_000),
      });
      await vi.advanceTimersByTimeAsync(stepMs);
    }

    await run.done;
    // The bound held: finite lifetime despite unbounded pause signals.
    expect(run.fired()).toBe(true);
    expect(ceiling.totalGrantedMs).toBe(SUBAGENT_MAX_PAUSE_EXTENSION_MS);
    expect((run.error() as Error).message).toContain('EXHAUSTED');
  });

  it('never extends on child-generated content, thinking, tool, or message events', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    // A maximally chatty child: streams content and runs tools right up to the
    // deadline. None of this may buy it a single extra millisecond.
    for (let i = 0; i < 10; i++) {
      ceiling.onEvent(contentEvent);
      ceiling.onEvent(thinkingEvent);
      ceiling.onEvent(toolStartEvent);
      ceiling.onEvent(toolResultEvent);
      ceiling.onEvent({ type: 'stream_retry' });
      await vi.advanceTimersByTimeAsync(BUDGET / 10 - 1);
    }
    expect(run.fired()).toBe(false);
    expect(ceiling.totalGrantedMs).toBe(0);

    await vi.advanceTimersByTimeAsync(10);
    await run.done;
    expect(run.fired()).toBe(true);
    expect(ceiling.totalGrantedMs).toBe(0);
    // No pause was ever observed, so no pause context is attached.
    expect(ceiling.describe()).toBeUndefined();
  });

  it('banks a closed pause on `resumed` and stops accruing further credit', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    // Parked for 5 min, then the provider resumes.
    const parkedForMs = 5 * 60_000;
    ceiling.onEvent({
      type: 'paused',
      reason: 'usage-limit',
      resetsAt: new Date(Date.now() + 30 * 60_000),
    });
    await vi.advanceTimersByTimeAsync(parkedForMs);
    ceiling.onEvent({ type: 'resumed', hotSwapped: false });

    // Owed exactly the 5 min actually spent parked — not the 30 min advertised.
    await vi.advanceTimersByTimeAsync(BUDGET - parkedForMs);
    expect(run.fired()).toBe(false);
    await vi.advanceTimersByTimeAsync(parkedForMs - 1);
    expect(run.fired()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await run.done;
    expect(run.fired()).toBe(true);
    expect(ceiling.totalGrantedMs).toBe(parkedForMs);
  });

  it('does NOT credit working time when repeated `rate_limit`s never pair with `resumed`', async () => {
    // Regression: `resumed` is emitted ONLY on the OAuth park path
    // (`retry-layer.ts:415,512`) — a transient `rate_limit` never has one. An
    // earlier revision left such a pause open forever, so each later signal
    // widened its window by the elapsed gap and credited ordinary WORKING time
    // 1:1: a 5s retry-after seen every 10 min credited the full 10 min, quietly
    // inflating the budget toward `timeoutMs + cap`.
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    const retryAfterMs = 5_000;
    const gapMs = 10 * 60_000;
    let parkedMs = 0;
    // Four brief throttles spread across (and past) the budget.
    for (let i = 0; i < 4; i++) {
      ceiling.onEvent({ type: 'rate_limit', retryAfterMs });
      parkedMs += retryAfterMs + PAUSE_WINDOW_SLACK_MS;
      await vi.advanceTimersByTimeAsync(gapMs);
      // The child is demonstrably working between throttles.
      ceiling.onEvent(contentEvent);
    }

    // 40 min elapsed so far; cross the 45-min budget plus any credited park.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await run.done;
    expect(run.fired()).toBe(true);
    // Credit reflects only the ~4 brief reported windows (140s), NOT the 40 min
    // of wall time that elapsed while the child was working.
    expect(ceiling.totalGrantedMs).toBeLessThanOrEqual(parkedMs);
    expect(ceiling.totalGrantedMs).toBeLessThan(gapMs);
  });

  it('grants nothing for a pause with no knowable window', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling);

    // oauth-limit-no-ts: parked, but the provider did not say until when.
    ceiling.onEvent({ type: 'paused', reason: 'usage-limit' });
    // A rate_limit with no retry-after is equally unknowable.
    ceiling.onEvent({ type: 'rate_limit' });

    await vi.advanceTimersByTimeAsync(BUDGET);
    await run.done;
    expect(run.fired()).toBe(true);
    expect(ceiling.totalGrantedMs).toBe(0);
  });

  it('keeps the furthest-out window when pause signals overlap', () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    // A short transient 429 arriving during a long OAuth park must not shorten it.
    ceiling.onEvent({
      type: 'paused',
      reason: 'usage-limit',
      resetsAt: new Date(Date.now() + 90 * 60_000),
    });
    ceiling.onEvent({ type: 'rate_limit', retryAfterMs: 60_000 });

    // Advance past the short signal's window; the long park still governs.
    vi.advanceTimersByTime(BUDGET);
    expect(ceiling.onDeadline()).toBe(BUDGET);
  });

  it('names the pause context in the timeout error when it fires under pause', async () => {
    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling, BUDGET, 'forge-rework-2');

    const resetsAt = new Date(Date.now() + 60 * 60_000);
    ceiling.onEvent({ type: 'paused', reason: 'usage-limit', resetsAt });

    await vi.advanceTimersByTimeAsync(BUDGET + 60 * 60_000 + PAUSE_WINDOW_SLACK_MS);
    await run.done;
    expect(run.fired()).toBe(true);

    // The message must carry enough to diagnose the failure without the trace.
    const message = (run.error() as Error).message;
    expect(message).toContain('pause-aware ceiling');
    expect(message).toContain('forge-rework-2');
    expect(message).toContain(`base budget ${BUDGET}ms`);
    expect(message).toContain('pause extension granted');
    expect(message).toContain(resetsAt.toISOString());
    // The reported elapsed time reflects the FULL wait, not just the base budget.
    expect((run.error() as TimeoutError).timeoutMs).toBeGreaterThan(BUDGET);
  });

  it('fires normally when the extender throws (a faulty policy never strands the wait)', async () => {
    const boom: TimeoutExtender = {
      onDeadline() {
        throw new Error('extender boom');
      },
      describe() {
        throw new Error('describe boom');
      },
    };
    const run = startGuarded(boom, 1_000, 'child-x');

    await vi.advanceTimersByTimeAsync(1_000);
    await run.done;
    expect(run.fired()).toBe(true);
    expect((run.error() as Error).message).toBe('Operation timed out after 1000ms (child-x)');
  });

  it('survives the real incident: 45-min budget vs a ~43m38s parked span', async () => {
    // Forensics: dispatch 02:26:21.307Z, budget 2,700,000ms, provider parked
    // until 03:10:00.000Z (reported at 01:16:47Z with retryAfterMs 6792000).
    // Pre-fix the child died at 03:11:21.307Z — 81s AFTER the reset — having
    // worked for only those 81 seconds.
    const dispatchedAt = new Date('2026-07-31T02:26:21.307Z');
    const resetsAt = new Date('2026-07-31T03:10:00.000Z');
    vi.setSystemTime(dispatchedAt);

    const ceiling = new PauseAwareCeiling(BUDGET);
    const run = startGuarded(ceiling, BUDGET, 'forge-rework-2');

    ceiling.onEvent({ type: 'paused', reason: 'usage-limit', resetsAt });

    // Advance to the pre-fix death instant: 03:11:21.307Z.
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(run.fired()).toBe(false); // would have been `true` before this change
    expect(new Date().toISOString()).toBe('2026-07-31T03:11:21.307Z');

    // The park ended at 03:10:00Z, so the parked span (+slack) is credited back:
    // the child now gets a genuine 45 minutes of WORKING time past the reset.
    const parkedMs = resetsAt.getTime() - dispatchedAt.getTime() + PAUSE_WINDOW_SLACK_MS;
    expect(ceiling.totalGrantedMs).toBe(parkedMs);
    await vi.advanceTimersByTimeAsync(parkedMs - 1);
    expect(run.fired()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await run.done;
    expect(run.fired()).toBe(true);
    // Finite and predictable: never beyond budget + cap.
    expect(ceiling.totalGrantedMs).toBeLessThanOrEqual(SUBAGENT_MAX_PAUSE_EXTENSION_MS);
  });
});

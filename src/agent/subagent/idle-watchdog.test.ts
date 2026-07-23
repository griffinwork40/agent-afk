/**
 * Unit tests for {@link IdleWatchdog} — the progress-aware idle watchdog for
 * forked sub-agent turns.
 *
 * Fake-timer convention mirrors `subagent.test.ts` (`vi.useFakeTimers()`):
 * arm → advance → assert the controller aborted (or did not). Covers:
 *   - fires after the idle window with no events (aborts with IdleWatchdogError)
 *   - an ordinary OutputEvent resets the clock (never fires while progressing)
 *   - a tool in flight SUSPENDS the clock (a long silent tool is not idle);
 *     a parallel batch stays suspended until the last result; re-arms after
 *   - lastEventType is "tool_result" when it fires after a tool completes
 *   - `paused` (OAuth) extends the deadline to resetsAt + slack, then collapses
 *   - `rate_limit` with retryAfterMs extends by retryAfterMs + slack
 *   - `resumed` collapses back to a normal idle window
 *   - `dispose()` cancels the timer (idempotent)
 *   - `idleTimeoutMs = 0` (and negatives) fully disable the watchdog
 *   - the fire callback carries idleTimeoutMs / elapsed / lastEventType
 *   - a callback that throws never suppresses the abort
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  IdleWatchdog,
  IDLE_WATCHDOG_PAUSE_SLACK_MS,
} from './idle-watchdog.js';
import { IdleWatchdogError } from '../../utils/errors.js';
import type { OutputEvent } from '../types/session-types.js';

const IDLE = 8 * 60_000; // 8 min — the production default

// A minimal `chunk` OutputEvent used as an ordinary progress signal.
const progressEvent: OutputEvent = {
  type: 'chunk',
  chunk: { type: 'content', content: 'hi' },
};

// Tool lifecycle brackets: a `tool_use_detail` chunk marks a tool starting
// (yielded before dispatch); a `tool_result` chunk marks it finishing (yielded
// after). Between them the provider stream is silent for the tool's duration.
const toolStart = (toolUseId = 't1'): OutputEvent => ({
  type: 'chunk',
  chunk: { type: 'tool_use_detail', toolUseId, toolName: 'bash', toolInput: 'sleep 540' },
});
const toolResult = (toolUseId = 't1'): OutputEvent => ({
  type: 'chunk',
  chunk: { type: 'tool_result', toolUseId, content: 'done' },
});

describe('IdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after the idle window when no events arrive', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-1');

    // Just short of the window: not yet fired.
    vi.advanceTimersByTime(IDLE - 1);
    expect(controller.signal.aborted).toBe(false);

    // Crossing the window fires.
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(IdleWatchdogError);
    expect((controller.signal.reason as IdleWatchdogError).timeoutMs).toBe(IDLE);

    wd.dispose();
  });

  it('resets the idle clock on an ordinary OutputEvent (does not fire while progressing)', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-2');

    // Advance most of the window, then a real event resets the clock.
    vi.advanceTimersByTime(IDLE - 1_000);
    wd.onEvent(progressEvent);

    // The original deadline would have fired by now; the reset prevents it.
    vi.advanceTimersByTime(2_000);
    expect(controller.signal.aborted).toBe(false);

    // A full fresh window of silence from the last event does fire.
    vi.advanceTimersByTime(IDLE);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('never fires while events keep arriving within the window', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-3');

    // 10 rounds, each well within the window.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(IDLE - 5_000);
      wd.onEvent(progressEvent);
      expect(controller.signal.aborted).toBe(false);
    }

    wd.dispose();
  });

  it('suspends the idle clock while a tool is in flight (does not fire on a long silent tool)', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-tool-1');

    // Tool starts, then runs SILENTLY far past the idle window (e.g. a 9-min
    // `bash`/test command). The bounded wait must not be counted as idle.
    wd.onEvent(toolStart());
    vi.advanceTimersByTime(IDLE * 3);
    expect(controller.signal.aborted).toBe(false);

    // The tool finishes; a fresh idle window is armed from completion.
    wd.onEvent(toolResult());
    vi.advanceTimersByTime(IDLE - 1);
    expect(controller.signal.aborted).toBe(false);

    // Silence AFTER the tool returns is real idle → fires.
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(IdleWatchdogError);

    wd.dispose();
  });

  it('stays suspended until the LAST tool of a parallel batch completes', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-tool-2');

    // Two tools dispatched in one parallel wave (both starts before dispatch).
    wd.onEvent(toolStart('a'));
    wd.onEvent(toolStart('b'));
    vi.advanceTimersByTime(IDLE * 2);
    expect(controller.signal.aborted).toBe(false);

    // First result arrives — sibling `b` is still running, so stay suspended.
    wd.onEvent(toolResult('a'));
    vi.advanceTimersByTime(IDLE * 2);
    expect(controller.signal.aborted).toBe(false);

    // Last result arrives — now a normal idle window is armed.
    wd.onEvent(toolResult('b'));
    vi.advanceTimersByTime(IDLE - 1);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('re-arms normally after a tool completes, then across a following tool', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-tool-3');

    // Progress, then a long tool, then progress, then another long tool — a
    // realistic turn. None of it should fire while the child is doing work.
    wd.onEvent(progressEvent);
    vi.advanceTimersByTime(IDLE - 1_000);
    wd.onEvent(toolStart('x'));
    vi.advanceTimersByTime(IDLE * 5); // long silent tool
    wd.onEvent(toolResult('x'));
    vi.advanceTimersByTime(IDLE - 1_000);
    wd.onEvent(progressEvent);
    vi.advanceTimersByTime(IDLE - 1_000);
    wd.onEvent(toolStart('y'));
    vi.advanceTimersByTime(IDLE * 5); // another long silent tool
    expect(controller.signal.aborted).toBe(false);

    // Only sustained silence after the final tool returns fires.
    wd.onEvent(toolResult('y'));
    vi.advanceTimersByTime(IDLE);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('reports lastEventType "tool_result" when it fires after a tool completes', () => {
    const controller = new AbortController();
    const onFire = vi.fn();
    const wd = new IdleWatchdog(controller, IDLE, 'child-tool-4', onFire);

    wd.onEvent(toolStart());
    vi.advanceTimersByTime(IDLE * 2); // suspended, no fire
    wd.onEvent(toolResult());
    vi.advanceTimersByTime(IDLE);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect((onFire.mock.calls[0]![0] as { lastEventType: string }).lastEventType).toBe(
      'tool_result',
    );
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('extends the deadline to resetsAt + slack on an OAuth `paused` event', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-4');

    // Park for 30 min — far beyond a normal idle window.
    const parkMs = 30 * 60_000;
    const resetsAt = new Date(Date.now() + parkMs);
    wd.onEvent({ type: 'paused', reason: 'usage-limit', resetsAt });

    // A normal idle window elapses: must NOT fire — the turn is legitimately parked.
    vi.advanceTimersByTime(IDLE + 1_000);
    expect(controller.signal.aborted).toBe(false);

    // Just short of resetsAt + slack: still parked.
    vi.advanceTimersByTime(parkMs - (IDLE + 1_000) + IDLE_WATCHDOG_PAUSE_SLACK_MS - 1);
    expect(controller.signal.aborted).toBe(false);

    // Crossing resetsAt + slack with no resume/progress fires.
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('uses a normal idle window for a `paused` event with no resetsAt', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-5');

    // oauth-limit-no-ts: provider did not say when it will resume.
    wd.onEvent({ type: 'paused', reason: 'usage-limit' });

    vi.advanceTimersByTime(IDLE - 1);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('extends by retryAfterMs + slack on a `rate_limit` event carrying retryAfterMs', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-6');

    const retryAfterMs = 90_000; // longer than a normal idle window? no — but test the extension math
    wd.onEvent({ type: 'rate_limit', retryAfterMs });

    // Just short of retryAfterMs + slack: not fired.
    vi.advanceTimersByTime(retryAfterMs + IDLE_WATCHDOG_PAUSE_SLACK_MS - 1);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('treats a `rate_limit` without retryAfterMs as ordinary progress (normal re-arm)', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-7');

    vi.advanceTimersByTime(IDLE - 1_000);
    wd.onEvent({ type: 'rate_limit' }); // no retryAfterMs → plain re-arm

    // Original deadline would have fired; the re-arm prevents it.
    vi.advanceTimersByTime(2_000);
    expect(controller.signal.aborted).toBe(false);
    // A fresh full window of silence fires.
    vi.advanceTimersByTime(IDLE);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('collapses back to a normal idle window on `resumed`', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-8');

    // Park far out…
    const resetsAt = new Date(Date.now() + 60 * 60_000);
    wd.onEvent({ type: 'paused', reason: 'usage-limit', resetsAt });

    // …then resume: the window collapses back to a normal idle bound.
    wd.onEvent({ type: 'resumed', hotSwapped: false });

    vi.advanceTimersByTime(IDLE - 1);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('dispose() cancels the timer and is idempotent', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-9');

    wd.dispose();
    wd.dispose(); // idempotent — no throw

    vi.advanceTimersByTime(IDLE * 2);
    expect(controller.signal.aborted).toBe(false);
  });

  it('onEvent after dispose is a no-op (never re-arms)', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-10');

    wd.dispose();
    wd.onEvent(progressEvent);

    vi.advanceTimersByTime(IDLE * 2);
    expect(controller.signal.aborted).toBe(false);
  });

  it('is fully disabled when idleTimeoutMs is 0 (never fires)', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, 0, 'child-11');

    wd.onEvent(progressEvent);
    vi.advanceTimersByTime(60 * 60_000); // an hour of silence
    expect(controller.signal.aborted).toBe(false);

    wd.dispose();
  });

  it('is disabled for a negative / non-finite idleTimeoutMs', () => {
    const c1 = new AbortController();
    const wd1 = new IdleWatchdog(c1, -1, 'child-neg');
    const c2 = new AbortController();
    const wd2 = new IdleWatchdog(c2, Number.NaN, 'child-nan');

    vi.advanceTimersByTime(60 * 60_000);
    expect(c1.signal.aborted).toBe(false);
    expect(c2.signal.aborted).toBe(false);

    wd1.dispose();
    wd2.dispose();
  });

  it('invokes onFire with idleTimeoutMs / elapsed / lastEventType before aborting', () => {
    const controller = new AbortController();
    const onFire = vi.fn();
    const wd = new IdleWatchdog(controller, IDLE, 'child-12', onFire);

    // A progress event 3s in sets lastEventType; then a full idle window elapses.
    vi.advanceTimersByTime(3_000);
    wd.onEvent(progressEvent);
    vi.advanceTimersByTime(IDLE);

    expect(onFire).toHaveBeenCalledTimes(1);
    const info = onFire.mock.calls[0]![0] as {
      idleTimeoutMs: number;
      elapsedSinceLastProgressMs: number;
      lastEventType: string;
    };
    expect(info.idleTimeoutMs).toBe(IDLE);
    expect(info.lastEventType).toBe('chunk');
    // Elapsed is measured from the last arm (the progress event); ~IDLE.
    expect(info.elapsedSinceLastProgressMs).toBeGreaterThanOrEqual(IDLE);
    expect(controller.signal.aborted).toBe(true);

    wd.dispose();
  });

  it('reports lastEventType "none" when it fires before any event', () => {
    const controller = new AbortController();
    const onFire = vi.fn();
    const wd = new IdleWatchdog(controller, IDLE, 'child-13', onFire);

    vi.advanceTimersByTime(IDLE);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect((onFire.mock.calls[0]![0] as { lastEventType: string }).lastEventType).toBe('none');

    wd.dispose();
  });

  it('still aborts when the onFire callback throws (observability is best-effort)', () => {
    const controller = new AbortController();
    const wd = new IdleWatchdog(controller, IDLE, 'child-14', () => {
      throw new Error('trace-emit boom');
    });

    expect(() => vi.advanceTimersByTime(IDLE)).not.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(IdleWatchdogError);

    wd.dispose();
  });

  it('fires at most once (does not re-abort after firing)', () => {
    const controller = new AbortController();
    const onFire = vi.fn();
    const wd = new IdleWatchdog(controller, IDLE, 'child-15', onFire);

    vi.advanceTimersByTime(IDLE);
    expect(onFire).toHaveBeenCalledTimes(1);

    // Any further time / events must not fire again.
    wd.onEvent(progressEvent);
    vi.advanceTimersByTime(IDLE * 2);
    expect(onFire).toHaveBeenCalledTimes(1);

    wd.dispose();
  });
});

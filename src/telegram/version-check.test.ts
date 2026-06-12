/**
 * Tests for the Telegram daemon's version-drift watchdog.
 *
 * Covers both the drift detector (checkVersionDrift) and the exit/defer/
 * force-exit decision (decideVersionDriftAction) — the latter is the bounded
 * escape hatch for PR #106's mid-turn deferral (stuck-busy livelock guard).
 */

import { describe, it, expect } from 'vitest';
import {
  checkVersionDrift,
  decideVersionDriftAction,
  MAX_DRIFT_DEFERRALS,
} from './version-check.js';

describe('checkVersionDrift', () => {
  it('reports no drift when versions match', () => {
    expect(checkVersionDrift('3.104.3', '3.104.3')).toEqual({ drift: false });
  });

  it('reports drift with a message when versions differ', () => {
    const result = checkVersionDrift('3.104.2', '3.104.3');
    expect(result.drift).toBe(true);
    expect(result.message).toContain('3.104.2');
    expect(result.message).toContain('3.104.3');
  });

  it('treats unknown / empty versions as no drift (avoids spurious exits)', () => {
    expect(checkVersionDrift('unknown', '3.104.3')).toEqual({ drift: false });
    expect(checkVersionDrift('3.104.3', 'unknown')).toEqual({ drift: false });
    expect(checkVersionDrift('', '3.104.3')).toEqual({ drift: false });
    expect(checkVersionDrift('3.104.3', '')).toEqual({ drift: false });
  });
});

describe('decideVersionDriftAction', () => {
  const drift = checkVersionDrift('3.104.2', '3.104.3');
  const noDrift = checkVersionDrift('3.104.3', '3.104.3');

  it('returns "none" and resets the counter when there is no drift', () => {
    const decision = decideVersionDriftAction({ drift: noDrift, busyCount: 3, deferrals: 7 });
    expect(decision.action).toBe('none');
    expect(decision.deferrals).toBe(0);
    expect(decision.message).toBeUndefined();
  });

  it('exits cleanly when drift is present and no session is busy', () => {
    const decision = decideVersionDriftAction({ drift, busyCount: 0, deferrals: 0 });
    expect(decision.action).toBe('exit');
    expect(decision.deferrals).toBe(0);
    expect(decision.message).toBe(drift.message);
  });

  it('resets the deferral counter once the busy sessions drain (drift, busy=0)', () => {
    // Came in with prior deferrals, but now nothing is busy → clean exit + reset.
    const decision = decideVersionDriftAction({ drift, busyCount: 0, deferrals: 5 });
    expect(decision.action).toBe('exit');
    expect(decision.deferrals).toBe(0);
  });

  it('defers (not exits) while a session is mid-turn, below the cap', () => {
    const decision = decideVersionDriftAction({ drift, busyCount: 2, deferrals: 0 });
    expect(decision.action).toBe('defer');
    expect(decision.deferrals).toBe(1);
    expect(decision.message).toContain('deferred (1/');
    expect(decision.message).toContain('2 active session');
  });

  it('increments the deferral counter on each consecutive busy tick', () => {
    const first = decideVersionDriftAction({ drift, busyCount: 1, deferrals: 0 });
    expect(first.action).toBe('defer');
    expect(first.deferrals).toBe(1);

    const second = decideVersionDriftAction({ drift, busyCount: 1, deferrals: first.deferrals });
    expect(second.action).toBe('defer');
    expect(second.deferrals).toBe(2);
  });

  it('force-exits once the deferral count reaches the cap (livelock escape)', () => {
    const decision = decideVersionDriftAction({
      drift,
      busyCount: 1,
      deferrals: MAX_DRIFT_DEFERRALS,
    });
    expect(decision.action).toBe('force-exit');
    expect(decision.message).toContain('forcing upgrade');
    expect(decision.message).toContain('interrupted');
  });

  it('honors a custom maxDeferrals: defers up to the cap, then force-exits', () => {
    const maxDeferrals = 2;
    // Tick 1: 0 → defer (1/2)
    const t1 = decideVersionDriftAction({ drift, busyCount: 1, deferrals: 0, maxDeferrals });
    expect(t1.action).toBe('defer');
    expect(t1.deferrals).toBe(1);
    expect(t1.message).toContain('(1/2)');

    // Tick 2: 1 → defer (2/2)
    const t2 = decideVersionDriftAction({ drift, busyCount: 1, deferrals: t1.deferrals, maxDeferrals });
    expect(t2.action).toBe('defer');
    expect(t2.deferrals).toBe(2);
    expect(t2.message).toContain('(2/2)');

    // Tick 3: 2 ≥ cap → force-exit
    const t3 = decideVersionDriftAction({ drift, busyCount: 1, deferrals: t2.deferrals, maxDeferrals });
    expect(t3.action).toBe('force-exit');
    expect(t3.message).toContain('after 2 deferral(s)');
  });

  it('a single busy session is enough to defer; idle/closed drained → clean exit next tick', () => {
    // Busy → defer.
    const busyTick = decideVersionDriftAction({ drift, busyCount: 1, deferrals: 3 });
    expect(busyTick.action).toBe('defer');
    expect(busyTick.deferrals).toBe(4);

    // Session goes idle before hitting the cap → clean exit, counter reset.
    const drainedTick = decideVersionDriftAction({ drift, busyCount: 0, deferrals: busyTick.deferrals });
    expect(drainedTick.action).toBe('exit');
    expect(drainedTick.deferrals).toBe(0);
  });

  it('MAX_DRIFT_DEFERRALS is a positive, bounded grace window', () => {
    // Sanity guard: a 0 or negative default would force-exit immediately and
    // resurrect the very mid-turn kill PR #106 fixed.
    expect(MAX_DRIFT_DEFERRALS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_DRIFT_DEFERRALS)).toBe(true);
  });
});

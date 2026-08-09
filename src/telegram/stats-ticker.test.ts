/**
 * Tests for the Telegram daemon's periodic stats + version-drift tick.
 *
 * version-check.test.ts covers the pure decision; this covers the LOOP around
 * it — which previously lived in a setInterval closure inside src/telegram.ts's
 * main(), so the deferral counter feedback and the unreadable-package.json skip
 * path had no coverage at all. The counter is the livelock escape hatch from
 * PR #106: get its carry-over wrong and the daemon either upgrades mid-turn or
 * never upgrades.
 */

import { describe, expect, it, vi } from 'vitest';
import { runStatsTick, STATS_TICK_MS } from './stats-ticker.js';
import { MAX_DRIFT_DEFERRALS } from './version-check.js';
import { UNKNOWN_VERSION } from './daemon-version.js';

function fakeBot(busy = 0) {
  return {
    getStats: () => ({ activeSessions: 2, totalChats: 7 }),
    getBusySessionCount: () => busy,
  };
}

function tick(overrides: Parameters<typeof runStatsTick>[0]) {
  return runStatsTick(overrides);
}

const silent = { log: () => {}, warn: () => {}, exit: () => {} };

describe('runStatsTick', () => {
  it('logs the session stats line every tick', () => {
    const log = vi.fn();
    tick({
      bot: fakeBot(),
      spawnedVersion: '1.0.0',
      deferrals: 0,
      readVersion: () => '1.0.0',
      ...silent,
      log,
    });
    expect(log.mock.calls[0]?.[0]).toContain('2 active sessions, 7 total chats');
  });

  it('does nothing when the disk version matches', () => {
    const exit = vi.fn();
    const out = tick({
      bot: fakeBot(),
      spawnedVersion: '1.0.0',
      deferrals: 0,
      readVersion: () => '1.0.0',
      ...silent,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(out).toBe(0);
  });

  it('exits cleanly on drift when no session is mid-turn', () => {
    const exit = vi.fn();
    tick({
      bot: fakeBot(0),
      spawnedVersion: '1.0.0',
      deferrals: 0,
      readVersion: () => '1.0.1',
      ...silent,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('defers instead of exiting while a session is mid-turn', () => {
    const exit = vi.fn();
    const out = tick({
      bot: fakeBot(1),
      spawnedVersion: '1.0.0',
      deferrals: 0,
      readVersion: () => '1.0.1',
      ...silent,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(out).toBe(1);
  });

  it('carries the deferral count forward across ticks and force-exits at the cap', () => {
    const exit = vi.fn();
    let deferrals = 0;
    // Drive real consecutive ticks rather than asserting a single decision, so
    // a broken carry-over (resetting each tick) fails here.
    for (let i = 0; i < MAX_DRIFT_DEFERRALS; i++) {
      deferrals = tick({
        bot: fakeBot(1),
        spawnedVersion: '1.0.0',
        deferrals,
        readVersion: () => '1.0.1',
        ...silent,
        exit,
      });
    }
    expect(exit).not.toHaveBeenCalled();
    expect(deferrals).toBe(MAX_DRIFT_DEFERRALS);

    tick({
      bot: fakeBot(1),
      spawnedVersion: '1.0.0',
      deferrals,
      readVersion: () => '1.0.1',
      ...silent,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('resets the deferral count when drift clears', () => {
    const out = tick({
      bot: fakeBot(1),
      spawnedVersion: '1.0.0',
      deferrals: 5,
      readVersion: () => '1.0.0',
      ...silent,
    });
    expect(out).toBe(0);
  });

  it('preserves the deferral count when package.json is unreadable', () => {
    // Invariant under test: a transient read failure must NOT reset progress
    // toward the livelock escape hatch.
    const warn = vi.fn();
    const exit = vi.fn();
    const out = tick({
      bot: fakeBot(1),
      spawnedVersion: '1.0.0',
      deferrals: 5,
      readVersion: () => UNKNOWN_VERSION,
      ...silent,
      warn,
      exit,
    });
    expect(out).toBe(5);
    expect(exit).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain('Could not re-read package.json');
  });

  it('never exits when the spawned version is unknown', () => {
    const exit = vi.fn();
    tick({
      bot: fakeBot(0),
      spawnedVersion: UNKNOWN_VERSION,
      deferrals: 0,
      readVersion: () => '9.9.9',
      ...silent,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('survives a throwing bot without exiting', () => {
    const warn = vi.fn();
    const exit = vi.fn();
    const out = tick({
      bot: {
        getStats: () => ({ activeSessions: 0, totalChats: 0 }),
        getBusySessionCount: () => { throw new Error('boom'); },
      },
      spawnedVersion: '1.0.0',
      deferrals: 3,
      readVersion: () => '1.0.1',
      ...silent,
      warn,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(out).toBe(3);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the documented 5-minute tick period', () => {
    // MAX_DRIFT_DEFERRALS x STATS_TICK_MS is the ~1h grace window the
    // version-check docblock promises; drifting either breaks that contract.
    expect(STATS_TICK_MS).toBe(300000);
    expect((MAX_DRIFT_DEFERRALS * STATS_TICK_MS) / 3_600_000).toBe(1);
  });
});

/**
 * Tests for LiveMascot — the reacting goblin as a right-edge decoration on the
 * loop-stage rail (issue #336).
 *
 * The load-bearing behaviour is no longer geometry: this class reserves no
 * rows, holds no stream, and writes nothing, so what has to be pinned is
 * (a) total inertness unless opted in — an unset flag must leave the host row
 * byte-identical, (b) the state machine and the alert dwell, (c) the ticker
 * lifecycle, because a timer that outlives `stop()` would keep poking a stopped
 * painter forever, and (d) the sprite's width, which is the host row's right-edge
 * budget.
 *
 * The row-arithmetic side of the feature lives with its owner, in
 * `loop-stage.test.ts` ("LoopStageBar — right-edge decoration").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import stringWidth from 'string-width';
import chalk from 'chalk';
import { LiveMascot } from './mascot-live.js';
import { MINI_MASCOT_WIDTH } from '../../mascot-mini.js';

const prevEnv = { ...process.env };

beforeEach(() => {
  process.env['AFK_GOBLIN_MASCOT'] = '1';
  delete process.env['AFK_PLAIN_OUTPUT'];
  delete process.env['AFK_BANNER_PLAIN'];
  chalk.level = 3;
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...prevEnv };
  chalk.level = 3;
});

/** Strip ANSI for width / glyph assertions. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

function mascot(frameMs = 100) {
  const repaint = vi.fn();
  return { repaint, m: new LiveMascot({ requestRepaint: repaint, frameMs }) };
}

describe('LiveMascot opt-in gates', () => {
  it('is inert without AFK_GOBLIN_MASCOT (no decoration, no repaint requests)', () => {
    delete process.env['AFK_GOBLIN_MASCOT'];
    const { repaint, m } = mascot();
    m.start();
    m.onStage('acting');
    expect(m.decoration()).toBe('');
    expect(repaint).not.toHaveBeenCalled();
  });

  it('is inert under AFK_PLAIN_OUTPUT even when opted in', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const { repaint, m } = mascot();
    m.start();
    m.onStage('acting');
    expect(m.decoration()).toBe('');
    expect(repaint).not.toHaveBeenCalled();
  });

  it('is inert under AFK_BANNER_PLAIN=1 (pixel art suppressed everywhere)', () => {
    process.env['AFK_BANNER_PLAIN'] = '1';
    const { repaint, m } = mascot();
    m.start();
    m.onStage('acting');
    expect(m.decoration()).toBe('');
    expect(repaint).not.toHaveBeenCalled();
  });

  it('accepts AFK_GOBLIN_MASCOT=true as well as =1', () => {
    process.env['AFK_GOBLIN_MASCOT'] = 'true';
    const { m } = mascot();
    m.start();
    expect(m.decoration()).not.toBe('');
    m.stop();
  });

  it('runs no timer while inert (an un-opted-in session pays nothing)', () => {
    vi.useFakeTimers();
    delete process.env['AFK_GOBLIN_MASCOT'];
    const { repaint, m } = mascot();
    m.start();
    m.onStage('acting');
    vi.advanceTimersByTime(5000);
    expect(repaint).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('LiveMascot decoration', () => {
  it('is present at rest — the goblin sits there when the agent is idle', () => {
    const { m } = mascot();
    m.start();
    expect(strip(m.decoration())).not.toBe('');
    m.stop();
  });

  it('is exactly MINI_MASCOT_WIDTH display columns in every state', () => {
    const { m } = mascot();
    m.start();
    for (const stage of ['observing', 'acting', 'updating'] as const) {
      m.onStage(stage);
      expect(stringWidth(strip(m.decoration()))).toBe(MINI_MASCOT_WIDTH);
    }
    m.onStage('acting', { toolErrored: true });
    expect(stringWidth(strip(m.decoration()))).toBe(MINI_MASCOT_WIDTH);
    m.stop();
  });

  it('is a single row — a two-row sprite would not fit the host row', () => {
    const { m } = mascot();
    m.start();
    m.onStage('acting');
    expect(m.decoration()).not.toContain('\n');
    m.stop();
  });

  it('falls back to `` after stop(), so the host row returns to bare', () => {
    const { m } = mascot();
    m.start();
    m.onStage('acting');
    expect(m.decoration()).not.toBe('');
    m.stop();
    expect(m.decoration()).toBe('');
  });

  it('asks the host to repaint once on start() and once on stop()', () => {
    const { repaint, m } = mascot();
    m.start();
    expect(repaint).toHaveBeenCalledTimes(1);
    m.stop();
    expect(repaint).toHaveBeenCalledTimes(2);
  });

  it('start()/stop() are idempotent', () => {
    const { repaint, m } = mascot();
    m.start();
    m.start();
    expect(repaint).toHaveBeenCalledTimes(1);
    m.stop();
    m.stop();
    expect(repaint).toHaveBeenCalledTimes(2);
  });
});

describe('LiveMascot animation', () => {
  it('advances frames on a timer while working and stops when idle', () => {
    vi.useFakeTimers();
    const { repaint, m } = mascot(100);
    m.start();

    m.onStage('acting');
    const ticksAfterStateChange = repaint.mock.calls.length;
    vi.advanceTimersByTime(350);
    expect(repaint.mock.calls.length).toBeGreaterThan(ticksAfterStateChange);

    m.onStage('updating'); // back to rest
    const atRest = repaint.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(repaint.mock.calls.length).toBe(atRest);
    m.stop();
  });

  it('runs no timer at rest — a resting REPL pays no ticks', () => {
    vi.useFakeTimers();
    const { m } = mascot(100);
    m.start();
    expect(vi.getTimerCount()).toBe(0);
    m.onStage('acting');
    expect(vi.getTimerCount()).toBe(1);
    m.onStage('observing');
    expect(vi.getTimerCount()).toBe(0);
    m.stop();
  });

  it('releases the ticker on stop() so it cannot outlive its repaint target', () => {
    vi.useFakeTimers();
    const { repaint, m } = mascot(100);
    m.start();
    m.onStage('acting');
    m.stop();
    const after = repaint.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(repaint.mock.calls.length).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cycles the sprite through more than one rendered frame while working', () => {
    vi.useFakeTimers();
    const { m } = mascot(100);
    m.start();
    m.onStage('acting');
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add(strip(m.decoration()));
      vi.advanceTimersByTime(100);
    }
    expect(seen.size).toBeGreaterThan(1);
    m.stop();
  });

  it('resets to the first frame on every state change (no half-played cycle)', () => {
    vi.useFakeTimers();
    const { m } = mascot(100);
    m.start();
    const resting = m.decoration();
    m.onStage('acting');
    vi.advanceTimersByTime(500);
    m.onStage('observing');
    expect(m.decoration()).toBe(resting);
    m.stop();
  });
});

describe('LiveMascot.onStage', () => {
  it('maps acting → working and every other stage → rest', () => {
    const { m } = mascot();
    m.start();
    const resting = m.decoration();

    m.onStage('acting');
    expect(m.decoration()).not.toBe('');
    // Rest is a single still frame, so every non-acting stage renders it.
    for (const stage of ['observing', 'modeling', 'choosing', 'updating'] as const) {
      m.onStage('acting');
      m.onStage(stage);
      expect(m.decoration(), stage).toBe(resting);
    }
    m.stop();
  });

  it('flashes alert on an errored tool result, then falls back to the live stage', () => {
    vi.useFakeTimers();
    const { m } = mascot(100);
    m.start();
    const resting = m.decoration();

    m.onStage('updating', { toolErrored: true });
    // Alarm red is only in the alert frames (pinned in mascot-mini.test.ts).
    expect(m.decoration()).toMatch(/200;60;40/);

    vi.advanceTimersByTime(1600); // past ALERT_DWELL_MS
    expect(m.decoration()).toBe(resting);
    m.stop();
  });

  it('holds the alert when the errored tool leaves the agent still acting', () => {
    // A failure inside a parallel wave leaves other tools pending, so the stage
    // stays 'acting'. The alert must own the sprite for its dwell anyway, and
    // then fall back to working rather than to rest.
    vi.useFakeTimers();
    const { m } = mascot(100);
    m.start();
    m.onStage('acting');
    m.onStage('acting', { toolErrored: true });
    expect(m.decoration()).toMatch(/200;60;40/);

    // Stage traffic during the dwell does not steal the sprite back.
    m.onStage('acting');
    expect(m.decoration()).toMatch(/200;60;40/);

    vi.advanceTimersByTime(1600);
    expect(m.decoration()).not.toMatch(/200;60;40/);
    m.stop();
  });

  it('ignores stage traffic before start() and after stop()', () => {
    const { repaint, m } = mascot();
    m.onStage('acting');
    expect(m.decoration()).toBe('');
    expect(repaint).not.toHaveBeenCalled();

    m.start();
    m.stop();
    repaint.mockClear();
    m.onStage('acting', { toolErrored: true });
    expect(m.decoration()).toBe('');
    expect(repaint).not.toHaveBeenCalled();
  });

  it('drops the alert dwell timer on stop() (no repaint after teardown)', () => {
    vi.useFakeTimers();
    const { repaint, m } = mascot(100);
    m.start();
    m.onStage('acting', { toolErrored: true });
    m.stop();
    const after = repaint.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(repaint.mock.calls.length).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });
});

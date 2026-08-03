/**
 * Tests for LiveMascot — the reacting goblin's state machine and frame clock
 * (issue #336).
 *
 * Geometry is deliberately NOT this class's job: it reserves no rows, holds no
 * stream, and writes nothing, so what has to be pinned here is (a) total
 * inertness unless opted in — an unset flag must produce no frame and no
 * repaint request at all, (b) the state machine and the alert dwell, (c) the
 * ticker lifecycle, because a timer that outlives `stop()` would keep poking a
 * released band forever, and (d) the frame's shape (rows × columns), which is
 * the band's reservation and right-edge budget.
 *
 * The row-arithmetic side of the feature lives with its owner, in
 * `mascot-band.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import stringWidth from 'string-width';
import chalk from 'chalk';
import { LiveMascot } from './mascot-live.js';
import { MINI_MASCOT_WIDTH, MINI_MASCOT_HEIGHT } from '../../mascot-mini.js';

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

/**
 * The mascot's current frame as one comparable string — `''` while inert. Rows
 * are joined rather than asserted individually wherever a test cares about
 * "which face", not "what shape".
 */
function frame(m: LiveMascot): string {
  return m.lines().join('\n');
}

function mascot(frameMs = 100) {
  const repaint = vi.fn();
  return { repaint, m: new LiveMascot({ requestRepaint: repaint, frameMs }) };
}

describe('LiveMascot opt-in gates', () => {
  it('is inert without AFK_GOBLIN_MASCOT (no frame, no repaint requests)', () => {
    delete process.env['AFK_GOBLIN_MASCOT'];
    const { repaint, m } = mascot();
    m.start();
    m.onStage('acting');
    expect(frame(m)).toBe('');
    expect(repaint).not.toHaveBeenCalled();
  });

  it('is inert under AFK_PLAIN_OUTPUT even when opted in', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const { repaint, m } = mascot();
    m.start();
    m.onStage('acting');
    expect(frame(m)).toBe('');
    expect(repaint).not.toHaveBeenCalled();
  });

  it('is inert under AFK_BANNER_PLAIN=1 (pixel art suppressed everywhere)', () => {
    process.env['AFK_BANNER_PLAIN'] = '1';
    const { repaint, m } = mascot();
    m.start();
    m.onStage('acting');
    expect(frame(m)).toBe('');
    expect(repaint).not.toHaveBeenCalled();
  });

  it('accepts AFK_GOBLIN_MASCOT=true as well as =1', () => {
    process.env['AFK_GOBLIN_MASCOT'] = 'true';
    const { m } = mascot();
    m.start();
    expect(frame(m)).not.toBe('');
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

describe('LiveMascot frames', () => {
  it('is present at rest — the goblin sits there when the agent is idle', () => {
    const { m } = mascot();
    m.start();
    expect(strip(frame(m))).not.toBe('');
    m.stop();
  });

  it('every row is exactly MINI_MASCOT_WIDTH display columns in every state', () => {
    // The band right-aligns against a fixed width; a wide row would overrun the
    // margin column and arm DECAWM's pending wrap.
    const { m } = mascot();
    m.start();
    const check = (label: string) => {
      for (const [i, row] of m.lines().entries()) {
        expect(stringWidth(strip(row)), `${label} row ${i}`).toBe(MINI_MASCOT_WIDTH);
      }
    };
    for (const stage of ['observing', 'acting', 'updating'] as const) {
      m.onStage(stage);
      check(stage);
    }
    m.onStage('acting', { toolErrored: true });
    check('alert');
    m.stop();
  });

  it('is exactly MINI_MASCOT_HEIGHT rows, and no row contains a newline', () => {
    // The band reserves this many rows and clears exactly this many; a frame of
    // any other height would either orphan a row or paint outside the band.
    const { m } = mascot();
    m.start();
    for (const stage of ['observing', 'acting'] as const) {
      m.onStage(stage);
      expect(m.lines()).toHaveLength(MINI_MASCOT_HEIGHT);
      for (const row of m.lines()) expect(row).not.toContain('\n');
    }
    m.stop();
  });

  it('falls back to [] after stop(), so the band paints blank rows', () => {
    const { m } = mascot();
    m.start();
    m.onStage('acting');
    expect(m.lines()).toHaveLength(MINI_MASCOT_HEIGHT);
    m.stop();
    expect(m.lines()).toEqual([]);
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
      seen.add(strip(frame(m)));
      vi.advanceTimersByTime(100);
    }
    expect(seen.size).toBeGreaterThan(1);
    m.stop();
  });

  it('resets to the first frame on every state change (no half-played cycle)', () => {
    vi.useFakeTimers();
    const { m } = mascot(100);
    m.start();
    const resting = frame(m);
    m.onStage('acting');
    vi.advanceTimersByTime(500);
    m.onStage('observing');
    expect(frame(m)).toBe(resting);
    m.stop();
  });
});

describe('LiveMascot.onStage', () => {
  it('maps acting → working and every other stage → rest', () => {
    const { m } = mascot();
    m.start();
    const resting = frame(m);

    m.onStage('acting');
    expect(frame(m)).not.toBe('');
    // Rest is a single still frame, so every non-acting stage renders it.
    for (const stage of ['observing', 'modeling', 'choosing', 'updating'] as const) {
      m.onStage('acting');
      m.onStage(stage);
      expect(frame(m), stage).toBe(resting);
    }
    m.stop();
  });

  it('flashes alert on an errored tool result, then falls back to the live stage', () => {
    vi.useFakeTimers();
    const { m } = mascot(100);
    m.start();
    const resting = frame(m);

    m.onStage('updating', { toolErrored: true });
    // Alarm red is only in the alert frames (pinned in mascot-mini.test.ts).
    expect(frame(m)).toMatch(/200;60;40/);

    vi.advanceTimersByTime(1600); // past ALERT_DWELL_MS
    expect(frame(m)).toBe(resting);
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
    expect(frame(m)).toMatch(/200;60;40/);

    // Stage traffic during the dwell does not steal the sprite back.
    m.onStage('acting');
    expect(frame(m)).toMatch(/200;60;40/);

    vi.advanceTimersByTime(1600);
    expect(frame(m)).not.toMatch(/200;60;40/);
    m.stop();
  });

  it('ignores stage traffic before start() and after stop()', () => {
    const { repaint, m } = mascot();
    m.onStage('acting');
    expect(frame(m)).toBe('');
    expect(repaint).not.toHaveBeenCalled();

    m.start();
    m.stop();
    repaint.mockClear();
    m.onStage('acting', { toolErrored: true });
    expect(frame(m)).toBe('');
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

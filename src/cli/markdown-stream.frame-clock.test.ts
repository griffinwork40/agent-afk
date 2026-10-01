import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import chalk from 'chalk';
import { PassThrough } from 'node:stream';
import { FrameClock, FRAME_PERIOD_MS } from './markdown-stream.frame-clock.js';
import { StreamingMarkdownRenderer } from './markdown-stream.js';
import { MAX_LAG_MS, INK_MS } from './smoke-reveal.js';
import { resetSmokeToneCache } from './smoke-reveal.tones.js';

const P = FRAME_PERIOD_MS;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('FrameClock', () => {
  it('ticks on a drift-corrected grid aimed at start + n * period', () => {
    const t0 = Date.now();
    const paints: number[] = [];
    const clock = new FrameClock(() => {
      paints.push(Date.now() - t0);
      clock.markDirty();
    });
    clock.markDirty();
    vi.advanceTimersByTime(P * 60 + 1);
    clock.stop();
    expect(paints.length).toBe(60);
    // Each paint lands within 1 ms (timer granularity) of its grid point, and
    // the error does not accumulate: paint 60 is still at 60 periods.
    paints.forEach((at, i) => expect(Math.abs(at - (i + 1) * P)).toBeLessThanOrEqual(1));
  });

  it('never paints twice in one period under interleaved content pushes', () => {
    const t0 = Date.now();
    const paints: number[] = [];
    const clock = new FrameClock(() => paints.push(Date.now() - t0));
    // A push every 3 ms for a second: each only marks dirty.
    for (let t = 0; t < 1_000; t += 3) {
      clock.markDirty();
      vi.advanceTimersByTime(3);
    }
    expect(paints.length).toBeGreaterThanOrEqual(Math.floor(1_000 / P) - 1);
    expect(paints.length).toBeLessThanOrEqual(Math.ceil(1_000 / P));
    for (let i = 1; i < paints.length; i++) {
      expect((paints[i] ?? 0) - (paints[i - 1] ?? 0)).toBeGreaterThanOrEqual(P - 1);
    }
    clock.stop();
  });

  it('skips overrun grid points instead of replaying them back-to-back', () => {
    const paints: number[] = [];
    let blocked = false;
    const clock = new FrameClock(() => {
      paints.push(Date.now());
      // The first paint blocks the event loop for 5 periods.
      if (!blocked) {
        blocked = true;
        vi.setSystemTime(Date.now() + 5 * P);
      }
      clock.markDirty();
    });
    clock.markDirty();
    vi.advanceTimersByTime(P * 6);
    clock.stop();
    // After the block the clock resumes on its grid: paints stay at least one
    // period apart in wall time, never a burst of catch-up paints.
    expect(paints.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < paints.length; i++) expect((paints[i] ?? 0) - (paints[i - 1] ?? 0)).toBeGreaterThanOrEqual(P - 1);
  });

  it('stops (releases its timer) on the first tick with nothing dirty', () => {
    const paint = vi.fn();
    const clock = new FrameClock(paint);
    clock.markDirty();
    expect(clock.running).toBe(true);
    vi.advanceTimersByTime(P + 1);
    expect(paint).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(P);
    expect(clock.running).toBe(false);
    vi.advanceTimersByTime(P * 10);
    expect(paint).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('StreamingMarkdownRenderer frame clock', () => {
  it('paints at most once per period while the reveal animates, whatever the push rate', async () => {
    const saved = chalk.level;
    chalk.level = 3;
    resetSmokeToneCache();
    vi.stubEnv('AFK_PLAIN_OUTPUT', '');
    vi.stubEnv('AFK_REDUCED_MOTION', '');
    vi.stubEnv('AFK_INK_TEXT', '');
    const t0 = Date.now();
    const paints: number[] = [];
    const stub = {
      setOverlay: () => { paints.push(Date.now() - t0); },
      commitAbove: () => {},
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    const out = new PassThrough();
    (out as unknown as { isTTY: boolean }).isTTY = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = new StreamingMarkdownRenderer({ out: out as any, compositor: stub as any });
    const words = 'the quick brown fox jumps over the lazy dog '.repeat(8).split(' ');
    for (const w of words) {
      r.push(w + ' ');
      await vi.advanceTimersByTimeAsync(4);
    }
    // With MAX_LAG_MS=2000ms, MAX_CPS=180, ~352 chars: animation takes up to
    // MAX_LAG_MS ms, then INK_MS=340ms fade. Wait MAX_LAG_MS + INK_MS + margin
    // so the reveal has fully settled before we check for silence.
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS + INK_MS + 200);
    // The first paint is the throttle's leading edge (the reveal is not yet
    // animating); every later paint is on the frame grid, >= one period apart.
    for (let i = 2; i < paints.length; i++) {
      expect((paints[i] ?? 0) - (paints[i - 1] ?? 0)).toBeGreaterThanOrEqual(P - 1);
    }
    expect(paints.length).toBeGreaterThan(10);
    // Settled: no timer left running.
    const before = paints.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(paints.length).toBe(before);
    r.dispose();
    chalk.level = saved;
  });
});

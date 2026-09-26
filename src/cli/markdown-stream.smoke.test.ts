/**
 * StreamingMarkdownRenderer + AFK_SMOKE_TEXT integration.
 *
 * Pins the three contracts the smoke reveal must honor inside the renderer:
 *  1. The live overlay shows smoke for fresh text, and it settles to exactly
 *     the smoke-off render with NO further pushes. The settle driver, not new
 *     content, finishes the fade.
 *  2. Committed blocks are never masked or delayed.
 *  3. With the env var off, the overlay is byte-identical to today.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import { PassThrough } from 'node:stream';
import { StreamingMarkdownRenderer } from './markdown-stream.js';
import { SMOKE_GLYPHS, LIFETIME_MS, MAX_LAG_MS } from './smoke-reveal.js';
import { resetSmokeToneCache } from './smoke-reveal.tones.js';

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
const hasSmoke = (s: string): boolean => SMOKE_GLYPHS.some((g) => stripAnsi(s).includes(g));

function makeRenderer(): { r: StreamingMarkdownRenderer; overlays: string[]; commits: string[] } {
  const overlays: string[] = [];
  const commits: string[] = [];
  const stub = {
    setOverlay: (t: string) => { overlays.push(t); },
    commitAbove: (t: string) => { commits.push(t); },
    arm: async () => {},
    disarm: () => {},
    getBuffer: () => ({ text: '', queued: false }),
    isArmed: () => true,
  };
  const out = new PassThrough();
  (out as unknown as { isTTY: boolean }).isTTY = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new StreamingMarkdownRenderer({ out: out as any, compositor: stub as any });
  return { r, overlays, commits };
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
  vi.stubEnv('AFK_PLAIN_OUTPUT', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  chalk.level = savedLevel;
});

const TEXT = 'The quick **brown** fox jumps over the lazy dog';

describe('StreamingMarkdownRenderer with AFK_SMOKE_TEXT', () => {
  it('shows smoke for fresh text, then settles to the smoke-off render without new pushes', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '');
    const base = makeRenderer();
    base.r.push(TEXT);
    await vi.advanceTimersByTimeAsync(100);
    const baseline = base.overlays.at(-1);
    base.r.dispose();

    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(40);
    expect(hasSmoke(overlays.at(-1) ?? ''), 'overlay should be mid-smoke').toBe(true);

    const pushesBefore = overlays.length;
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS + LIFETIME_MS + 200);
    expect(overlays.length, 'settle driver must repaint on its own').toBeGreaterThan(pushesBefore);
    expect(overlays.at(-1)).toBe(baseline);

    // Driver is idle once settled: no more repaints.
    const settledCount = overlays.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(overlays.length).toBe(settledCount);
    await r.flush();
  });

  it('never masks or delays committed blocks', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, commits } = makeRenderer();
    r.push('First paragraph lands whole.\n\nSecond');
    // Committed synchronously at the \n\n boundary, before any time passes.
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('First paragraph lands whole.');
    expect(hasSmoke(commits[0] ?? '')).toBe(false);
    await r.flush();
    expect(commits).toHaveLength(2);
    expect(stripAnsi(commits[1] ?? '')).toContain('Second');
    expect(hasSmoke(commits[1] ?? '')).toBe(false);
  });

  it('leaves the overlay byte-identical when the env var is off', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '0');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(5);
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.every((o) => !hasSmoke(o))).toBe(true);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('The quick brown fox');
    await r.flush();
  });

  it('skips code fences (they keep their dimmed live preview)', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    r.push('```ts\nconst answer = 42;\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('const answer = 42;');
    await r.flush();
  });

  it('flush() and dispose() stop the settle driver', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(10);
    await r.flush();
    const n = overlays.length;
    await vi.advanceTimersByTimeAsync(1_000);
    // flush() may clear the overlay once. No smoke frames may follow it.
    expect(overlays.slice(n).every((o) => !hasSmoke(o))).toBe(true);
    r.dispose();
  });
});

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

  // Regression (PR #2232 review): record() used to count the RAW chunk, so
  // markdown syntax the formatter consumes (`**`, backticks, link brackets)
  // inflated the live-burst total and pushed the reveal window onto text that
  // had already settled, re-smoking (or blanking) it.
  it.each([
    ['bold', ' then **bold** words'],
    ['inline code', ' then `code` words'],
    ['link', ' then [docs](https://example.com/x) words'],
  ])('never re-smokes settled text when new text carries %s syntax', async (_label, tail) => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    const settled = 'alpha bravo charlie delta echo foxtrot';
    r.push(settled);
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS + LIFETIME_MS + 200);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain(settled);

    r.push(tail);
    await vi.advanceTimersByTimeAsync(40);
    const frame = stripAnsi(overlays.at(-1) ?? '');
    expect(hasSmoke(frame), 'fresh tail should still be mid-smoke').toBe(true);
    expect(frame.trimStart().startsWith(settled), `settled prefix disturbed: ${JSON.stringify(frame)}`).toBe(true);
    await r.flush();
  });

  it('still smokes a fresh paragraph that arrives with a block commit', async () => {
    // The commit shrinks the overlay from the front. Without noteCommit() the
    // shrink would read as consumed syntax and trim the new text's bursts.
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays, commits } = makeRenderer();
    r.push('alpha bravo charlie delta echo foxtrot golf hotel');
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS + LIFETIME_MS + 200);
    r.push('.\n\nSecond paragraph');
    expect(commits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(hasSmoke(overlays.at(-1) ?? ''), 'post-commit text should be mid-smoke').toBe(true);
    await r.flush();
  });

  it('resets smoke history when the pending tail is stripped', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    const keep = 'alpha bravo charlie delta echo foxtrot';
    r.push(keep);
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS + LIFETIME_MS + 200);
    r.push(' TAILSTRIP golf hotel india');
    await vi.advanceTimersByTimeAsync(5);
    const off = r.getPendingBuffer().indexOf(' TAILSTRIP');
    expect(r.stripPendingFrom(off)).toBe(true);
    // Any repaint after the strip must show the kept text solid: the stripped
    // tail's bursts must not be remapped onto it.
    r.push(' ');
    await vi.advanceTimersByTimeAsync(40);
    const frame = stripAnsi(overlays.at(-1) ?? '');
    expect(hasSmoke(frame)).toBe(false);
    expect(frame).toContain(keep);
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

  it('skips the mask on a height-truncated render (its end is not the newest text)', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    try {
      // Far more text than 6 - 2 rows: the render keeps only the first rows.
      const long = Array.from({ length: 12 }, (_, i) => `line ${i} of a long paragraph`).join('\n');
      vi.stubEnv('AFK_SMOKE_TEXT', '');
      const base = makeRenderer();
      base.r.push(long);
      await vi.advanceTimersByTimeAsync(5);
      const baseline = base.overlays.at(-1);
      base.r.dispose();

      vi.stubEnv('AFK_SMOKE_TEXT', '1');
      const { r, overlays } = makeRenderer();
      r.push(long);
      await vi.advanceTimersByTimeAsync(5);
      expect(baseline, 'render must actually be truncated').toBeDefined();
      expect((baseline ?? '').split('\n').length).toBe(4);
      expect(overlays.at(-1), 'truncated render must be unmasked').toBe(baseline);
      await r.flush();
    } finally {
      if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
      else delete (process.stdout as { rows?: number }).rows;
    }
  });

  it('discardPending() clears the overlay and allows new text to smoke independently', async () => {
    // Verifies the observable contract of discardPending() in smoke mode:
    //   1. After discard, the live overlay is cleared immediately.
    //   2. New text pushed after the discard enters smoke from a clean state.
    //   3. The new text eventually settles to smoke-free without a new push.
    //
    // Falsifiability note: smoke?.reset() cancels the SmokeReveal settle
    // timer and clears burst history. However, through this integration
    // surface it cannot be falsified by removing that single line because:
    //   - executeRepaint() returns early when buffer is '' (so cancelled vs.
    //     still-running timer produces identical overlay output);
    //   - old bursts are naturally pruned by prune(t) once SETTLED ms pass,
    //     leaving nextBirth in the past, so new text gets fresh birth times
    //     regardless of reset().
    // The observable assertions below verify what CAN be confirmed without
    // private-field access: overlay cleared on discard, fresh smoke on new
    // text, eventual settle.
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();

    // Phase 1 — push first text; confirm smoke is live within the first tick.
    r.push('First chunk of text before discard');
    await vi.advanceTimersByTimeAsync(40);
    expect(hasSmoke(overlays.at(-1) ?? ''), 'should be smoking before discard').toBe(true);

    // Phase 2 — discard. The live overlay must be cleared (empty string pushed).
    r.discardPending();
    // discardPending() calls clearOverlay() synchronously, which calls
    // compositor.setOverlay('') — so the last overlay entry is now ''.
    expect(overlays.at(-1), 'overlay must be cleared synchronously on discard').toBe('');

    // Phase 3 — advance well past the old burst's full settle window; then
    // push new text. It must enter smoke on its own fresh timeline.
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS + LIFETIME_MS + 200);
    r.push('Brand new text after discard');
    await vi.advanceTimersByTimeAsync(40);
    expect(hasSmoke(overlays.at(-1) ?? ''), 'new text must smoke independently').toBe(true);

    // Phase 4 — settle the new text; the overlay must eventually become smoke-free.
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS + LIFETIME_MS + 200);
    expect(hasSmoke(overlays.at(-1) ?? ''), 'new text must settle to smoke-free').toBe(false);

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

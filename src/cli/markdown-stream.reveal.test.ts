/**
 * StreamingMarkdownRenderer + text reveal integration (AFK_INK_TEXT default,
 * AFK_SMOKE_TEXT heading accent).
 *
 * Pins the contracts the reveal must honor inside the renderer:
 *  1. Pacing: pushed text is revealed at a steady rate into cells that are
 *     already laid out, then the overlay settles to exactly the reveal-off
 *     render with NO further pushes.
 *  2. Prose uses the calm ink fade. Smoke particles only ever appear on
 *     heading lines, and only with AFK_SMOKE_TEXT=1.
 *  3. The reveal paces styling, never text: every pushed character is laid
 *     out at once, and blocks commit unmasked and identical to reveal-off. A
 *     completed block's COMMIT may be deferred (bounded) until it has faded
 *     in, while later text keeps flowing; the smoke accent may also hold the
 *     text after a heading. Every commit/inspect path drains both first, so
 *     ordering against tool rows is preserved.
 *  4. With the reveal off, text appears the instant it is pushed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import { PassThrough } from 'node:stream';
import { StreamingMarkdownRenderer } from './markdown-stream.js';
import { COMMIT_DEFER_MAX_MS, REVEAL_SETTLE_MAX_MS } from './markdown-stream.commit-defer.js';
import { SMOKE_GLYPHS, MAX_LAG_MS, INK_MS } from './smoke-reveal.js';
import { resetSmokeToneCache } from './smoke-reveal.tones.js';

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
const hasSmoke = (s: string): boolean => SMOKE_GLYPHS.some((g) => stripAnsi(s).includes(g));
/** A letter mid-ink-fade carries an RGB blend or the faint attribute. */
const hasInk = (s: string): boolean => /\u001b\[0(?:;\d+)*;(?:2|38;[\d;]+)m[^\s\u001b]/.test(s);
/** Long enough for any paced text in these tests to release and settle. */
const SETTLE_MS = 3_000;

function makeRenderer(opts: { reducedMotion?: boolean } = {}): { r: StreamingMarkdownRenderer; overlays: string[]; commits: string[] } {
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
  const r = new StreamingMarkdownRenderer({ out: out as any, compositor: stub as any, ...opts });
  return { r, overlays, commits };
}

/** flush() waits on the pacer's timers, so drive the fake clock while it runs. */
async function flushNow(r: StreamingMarkdownRenderer): Promise<void> {
  const done = r.flush();
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  await done;
}

/** The last overlay painted with the reveal fully off, for byte comparison. */
async function baselineFor(text: string): Promise<string | undefined> {
  const prevSmoke = process.env['AFK_SMOKE_TEXT'] ?? '';
  vi.stubEnv('AFK_INK_TEXT', '0');
  vi.stubEnv('AFK_SMOKE_TEXT', '');
  const base = makeRenderer();
  base.r.push(text);
  await vi.advanceTimersByTimeAsync(100);
  const last = base.overlays.at(-1);
  base.r.dispose();
  vi.stubEnv('AFK_INK_TEXT', '');
  vi.stubEnv('AFK_SMOKE_TEXT', prevSmoke);
  return last;
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
  vi.stubEnv('AFK_PLAIN_OUTPUT', '');
  // A developer's own AFK_REDUCED_MOTION=1 must not turn these tests off.
  vi.stubEnv('AFK_REDUCED_MOTION', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  chalk.level = savedLevel;
});

const TEXT = 'The quick **brown** fox jumps over the lazy dog and keeps running past the old stone barn';

describe('StreamingMarkdownRenderer text reveal: default style', () => {
  it('smokes prose by default (AFK_SMOKE_TEXT unset) and fades it as ink with AFK_SMOKE_TEXT=0', async () => {
    const smoky = makeRenderer();
    smoky.r.push(TEXT);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(33);
    expect(smoky.overlays.some(hasSmoke), 'default prose condenses out of smoke').toBe(true);
    await flushNow(smoky.r);
    vi.stubEnv('AFK_SMOKE_TEXT', '0');
    const inky = makeRenderer();
    inky.r.push(TEXT);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(33);
    expect(inky.overlays.some(hasSmoke)).toBe(false);
    expect(inky.overlays.some(hasInk)).toBe(true);
    await flushNow(inky.r);
  });
});

describe('StreamingMarkdownRenderer text reveal: ink (AFK_SMOKE_TEXT=0)', () => {
  // The ink fade is the opt-out style now; pin it so these contracts keep testing ink.
  beforeEach(() => { vi.stubEnv('AFK_SMOKE_TEXT', '0'); });

  it('paces a burst in, fades fresh letters, then settles to the reveal-off render on its own', async () => {
    const baseline = await baselineFor(TEXT);
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    // Smooth velocity (no deadline spike): the front starts from rest and
    // accelerates toward MAX_CPS over TAU_MS. For this text the markdown
    // formatter strips 4 `**` characters that SmokeReveal records as raw
    // syntax (reconcile trims them later). With TARGET_LAG_MS=400ms the
    // visible window opens later than the old 80ms (calibrated to 170ms lag);
    // MAX_LAG_MS/8 = 250ms is past the syntax offset while still well before
    // the end of the burst.
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS / 8); // 250ms: well past syntax offset
    const first = stripAnsi(overlays.at(-1) ?? '');
    expect(first, 'an early frame shows the start of the burst').toContain('The');
    expect(first, 'but not the whole burst at once').not.toContain('barn');

    await vi.advanceTimersByTimeAsync(100);
    expect(hasInk(overlays.at(-1) ?? ''), 'fresh letters are mid-fade').toBe(true);
    expect(overlays.some(hasSmoke), 'prose never draws smoke particles').toBe(false);

    const before = overlays.length;
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(overlays.length, 'the settle driver repaints on its own').toBeGreaterThan(before);
    expect(overlays.at(-1)).toBe(baseline);

    const settledCount = overlays.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(overlays.length, 'idle once settled').toBe(settledCount);
    await flushNow(r);
  });

  it('flushes an overflowing burst intact and stops its animation timers', async () => {
    const { r, overlays, commits } = makeRenderer();
    const big = 'x'.repeat(2000);
    r.push(big);
    await vi.advanceTimersByTimeAsync(20);
    await flushNow(r);
    expect(commits.map(stripAnsi).join('').replace(/\s/g, '')).toBe(big);
    const frames = overlays.length;
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(overlays.length).toBe(frames);
    r.dispose();
  });

  it('keeps prose ink-only with AFK_SMOKE_TEXT=0', async () => {
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(33);
    expect(overlays.some(hasSmoke)).toBe(false);
    expect(overlays.some(hasInk)).toBe(true);
    await flushNow(r);
  });

  // Regression (PR #2232 review): record() counts RAW text, so syntax the
  // formatter consumes must not push the reveal window onto settled text.
  it.each([
    ['bold', ' then **bold** words'],
    ['inline code', ' then `code` words'],
    ['link', ' then [docs](https://example.com/x) words'],
  ])('never re-reveals settled text when new text carries %s syntax', async (_label, tail) => {
    const { r, overlays } = makeRenderer();
    const settled = 'alpha bravo charlie delta echo foxtrot';
    r.push(settled);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain(settled);

    r.push(tail);
    await vi.advanceTimersByTimeAsync(40);
    const raw = overlays.at(-1) ?? '';
    expect(hasInk(raw), 'fresh tail should be mid-fade').toBe(true);
    const settledEnd = raw.indexOf('foxtrot') + 'foxtrot'.length;
    expect(settledEnd, 'settled prefix is painted verbatim, unstyled').toBeGreaterThan(7);
    expect(raw.slice(0, settledEnd)).not.toContain('\u001b');
    await flushNow(r);
  });

  it('defers a paragraph commit until it has faded in, while the next text keeps flowing', async () => {
    const { r, overlays, commits } = makeRenderer();
    r.push('First paragraph lands whole.\n\nSecond');
    // Deferred at the \n\n boundary: committing now would snap it solid mid-fade.
    expect(commits).toHaveLength(0);
    let flowing = false;
    for (let i = 0; i < 60 && !flowing; i++) {
      await vi.advanceTimersByTimeAsync(16);
      flowing = commits.length === 0 && stripAnsi(overlays.at(-1) ?? '').includes('Sec');
    }
    expect(flowing, 'the next block reveals while the first is still pending').toBe(true);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('First paragraph lands whole.');
    expect(commits[0]).not.toMatch(/\u001b\[0(?:;\d+)*;2m/);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('Second');
    await flushNow(r);
    expect(commits).toHaveLength(2);
    expect(stripAnsi(commits[1] ?? '')).toContain('Second');
  });

  it('still reveals a fresh paragraph that arrives with a block commit', async () => {
    const { r, overlays } = makeRenderer();
    r.push('alpha bravo charlie delta echo foxtrot golf hotel');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    r.push('.\n\nSecond paragraph');
    // Into the fresh paragraph's own fade (its predecessor's commit is deferred, not the text).
    let saw = false;
    for (let i = 0; i < 20 && !saw; i++) {
      await vi.advanceTimersByTimeAsync(33);
      const o = overlays.at(-1) ?? '';
      saw = stripAnsi(o).includes('Sec') && hasInk(o);
    }
    expect(saw, 'post-commit text should be mid-fade').toBe(true);
    await flushNow(r);
  });

  it('lays out every pushed character at once: unrevealed cells are blank, not missing', async () => {
    const baseline = await baselineFor(TEXT);
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    const first = overlays.at(-1) ?? '';
    // Same rows and the same column count per row as the reveal-off render.
    // Reserved cells are spaces, so compare raw widths; a whitespace-only
    // trailing line (indent before the final RESET) counts as empty.
    const shape = (s: string): number[] => stripAnsi(s).replace(/\n {3}$/, '\n').split('\n').map((l) => l.length);
    expect(shape(first)).toEqual(shape(baseline ?? ''));
    await flushNow(r);
  });

  it('commits a burst of paragraphs one by one, each once it has faded in', async () => {
    const { r, commits } = makeRenderer();
    const p1 = 'a'.repeat(80);
    const p2 = 'b'.repeat(80);
    r.push(p1 + '\n\n' + p2 + '\n\nTail');
    expect(commits).toHaveLength(0);
    // The front never stops at a boundary, so P2 fades in right behind P1.
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(commits.map((c) => stripAnsi(c).replace(/\s/g, ''))).toEqual([p1, p2]);
    await flushNow(r);
  });

  it('bounds a deferred commit by COMMIT_DEFER_MAX_MS even if the block is still fading', async () => {
    const { r, commits, overlays } = makeRenderer();
    // A full-capacity paragraph (MAX_LAG_MS * MAX_CPS = 360 chars): the front
    // eases out as its backlog drains, so the last letters are still inking in
    // past COMMIT_DEFER_MAX_MS (natural settle is ~2.7 s). The bound must force
    // the commit anyway rather than waiting for the fade.
    const p1 = 'a'.repeat(360);
    r.push(p1 + '\n\nTail');
    await vi.advanceTimersByTimeAsync(COMMIT_DEFER_MAX_MS - 50);
    expect(commits).toHaveLength(0);
    expect(hasInk(overlays.at(-1) ?? ''), 'still fading just before the bound').toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(commits.map((c) => stripAnsi(c).replace(/\s/g, ''))).toEqual([p1]);
    await flushNow(r);
  });

  it('commitPending() and discardPending() drain deferred blocks first, in order', async () => {
    const { r, commits } = makeRenderer();
    r.push('Done block one.\n\nIn progress');
    expect(commits).toHaveLength(0);
    r.commitPending();
    expect(commits.map((c) => stripAnsi(c).trim())).toEqual(['Done block one.', 'In progress']);
    const d = makeRenderer();
    d.r.push('Kept block.\n\nDiscarded tail');
    d.r.discardPending();
    expect(d.commits.map((c) => stripAnsi(c).trim()), 'completed blocks stay append-only').toEqual(['Kept block.']);
    await flushNow(r);
    await flushNow(d.r);
  });

  it('never defers a code fence block', async () => {
    const { r, commits } = makeRenderer();
    r.push('```\nconst answer = 42;\n```\n\nAfter');
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('const answer = 42;');
    await flushNow(r);
  });

  it('after a clean stream end: strips the terminal block in place and lets the tail settle', async () => {
    const { r, commits } = makeRenderer();
    const text = 'The last paragraph of the story.\n\n**Done**\n- wrote it';
    r.push(text);
    r.noteStreamDone();
    expect(r.getPendingBuffer(), 'the deferred block is still pending').toBe(text);
    expect(commits).toHaveLength(0);
    expect(r.stripPendingFrom(text.indexOf('**Done**'))).toBe(true);
    expect(commits, 'stripping commits nothing').toHaveLength(0);
    const done = r.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(commits, 'flush waits for the tail to finish fading').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(REVEAL_SETTLE_MAX_MS);
    await done;
    expect(commits.map((c) => stripAnsi(c).trim())).toEqual(['The last paragraph of the story.']);
  });

  it('without a clean stream end, flush commits at once (interrupts never wait)', async () => {
    const { r, commits } = makeRenderer();
    r.push('Interrupted paragraph.\n\nMore');
    const done = r.flush();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(commits.map((c) => stripAnsi(c).trim())).toEqual(['Interrupted paragraph.', 'More']);
  });

  it('commitPending() commits every pushed character', async () => {
    const { r, commits } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    r.commitPending();
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('barn');
    await flushNow(r);
  });

  it('getPendingBuffer() and hasEmitted() see queued text', async () => {
    const { r } = makeRenderer();
    r.push(TEXT);
    expect(r.hasEmitted()).toBe(true);
    expect(r.getPendingBuffer()).toBe(TEXT);
    await flushNow(r);
  });

  it('resets reveal history when the pending tail is stripped', async () => {
    const { r, overlays } = makeRenderer();
    const keep = 'alpha bravo charlie delta echo foxtrot';
    r.push(keep);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    r.push(' TAILSTRIP golf hotel india');
    await vi.advanceTimersByTimeAsync(5);
    const off = r.getPendingBuffer().indexOf(' TAILSTRIP');
    expect(r.stripPendingFrom(off)).toBe(true);
    r.push(' ');
    await vi.advanceTimersByTimeAsync(40);
    const frame = overlays.at(-1) ?? '';
    expect(stripAnsi(frame)).toContain(keep);
    expect(stripAnsi(frame)).not.toContain('TAILSTRIP');
    expect(hasInk(frame)).toBe(false);
    await flushNow(r);
  });

  it('discardPending() clears the overlay and discarded text never paints again', async () => {
    const { r, overlays } = makeRenderer();
    r.push('DISCARDME ' + 'lorem ipsum dolor sit amet '.repeat(6));
    await vi.advanceTimersByTimeAsync(0);
    r.discardPending();
    expect(overlays.at(-1)).toBe('');
    const n = overlays.length;
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(overlays.slice(n).some((o) => stripAnsi(o).includes('lorem'))).toBe(false);
    r.push('Brand new text after discard');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('Brand new text after discard');
    await flushNow(r);
  });

  it('flush() lets the tail flow out and commits all of it', async () => {
    const { r, commits } = makeRenderer();
    r.push(TEXT);
    await flushNow(r);
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('barn');
  });

  it('flush() and dispose() stop the settle driver', async () => {
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(10);
    await flushNow(r);
    const n = overlays.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(overlays.slice(n).every((o) => !hasInk(o))).toBe(true);
    r.dispose();
  });

  it('shows text the instant it arrives with AFK_INK_TEXT=0', async () => {
    vi.stubEnv('AFK_INK_TEXT', '0');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(5);
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.every((o) => !hasInk(o) && !hasSmoke(o))).toBe(true);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('barn');
    await r.flush();
  });

  it('skips code fences (they keep their dimmed live preview)', async () => {
    const { r, overlays } = makeRenderer();
    r.push('```ts\nconst answer = 42;\n');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('const answer = 42;');
    await flushNow(r);
  });

  it('skips the mask on a height-truncated render (its end is not the newest text)', async () => {
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    try {
      const long = Array.from({ length: 12 }, (_, i) => `line ${i} of a long paragraph`).join('\n');
      const baseline = await baselineFor(long);
      const { r, overlays } = makeRenderer();
      r.push(long);
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      expect((baseline ?? '').split('\n').length, 'render must actually be truncated').toBe(4);
      expect(overlays.at(-1), 'truncated render must be unmasked').toBe(baseline);
      await flushNow(r);
    } finally {
      if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
      else delete (process.stdout as { rows?: number }).rows;
    }
  });

  it('stays off under AFK_REDUCED_MOTION=1', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    vi.stubEnv('AFK_REDUCED_MOTION', '1');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(5);
    expect(overlays.every((o) => !hasInk(o) && !hasSmoke(o))).toBe(true);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('barn');
    await r.flush();
  });

  it('lets an explicit reducedMotion option override the environment either way', async () => {
    vi.stubEnv('AFK_REDUCED_MOTION', '1');
    const moving = makeRenderer({ reducedMotion: false });
    moving.r.push(TEXT);
    // Smooth velocity opens the visible window after enough acceleration time.
    // 80ms was calibrated for the old 170ms lag; with TARGET_LAG_MS=400ms the
    // window opens later. MAX_LAG_MS/8 = 250ms is reliably past the syntax offset.
    await vi.advanceTimersByTimeAsync(MAX_LAG_MS / 8); // 250ms
    expect(moving.overlays.some(hasInk)).toBe(true);
    await flushNow(moving.r);

    vi.stubEnv('AFK_REDUCED_MOTION', '');
    const still = makeRenderer({ reducedMotion: true });
    still.r.push(TEXT);
    await vi.advanceTimersByTimeAsync(40);
    expect(still.overlays.every((o) => !hasInk(o))).toBe(true);
    await still.r.flush();
  });
});

describe('StreamingMarkdownRenderer text reveal: smoke accent (AFK_SMOKE_TEXT=1)', () => {
  it('condenses a heading out of smoke before the body, and the body smokes too', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    r.push('## The Lighthouse Keeper\nFor forty years the light kept burning.');
    const frames: string[] = [];
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(33);
      frames.push(overlays.at(-1) ?? '');
    }
    const headingSmoke = frames.some((f) => hasSmoke(f) && !stripAnsi(f).includes('forty'));
    expect(headingSmoke, 'the heading smokes before the body arrives').toBe(true);
    const bodySmoke = frames.some((f) => stripAnsi(f).split('\n').some((l) => /forty|burning/.test(l) && hasSmoke(l)));
    expect(bodySmoke, 'smoke is the prose style, not just a heading accent').toBe(true);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    const settled = stripAnsi(overlays.at(-1) ?? '');
    expect(hasSmoke(settled)).toBe(false);
    expect(settled).toContain('The Lighthouse Keeper');
    expect(settled).toContain('For forty years the light kept burning.');
    await flushNow(r);
  });

  it('holds a heading block until it has condensed, then commits it (smoke accent only)', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays, commits } = makeRenderer();
    r.push('## Short Title\n\nBody follows here.');
    expect(commits, 'the heading is not cut off mid-smoke').toHaveLength(0);
    expect(stripAnsi(overlays.at(-1) ?? '')).not.toContain('Body');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('Short Title');
    expect(hasSmoke(commits[0] ?? '')).toBe(false);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('Body follows here.');
    await flushNow(r);
  });

  it('completes a held overflowing heading without an arrival deadline', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, commits } = makeRenderer();
    const title = 'x'.repeat(200);
    r.push('## ' + title + '\n\nBody');
    expect(commits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '').replace(/\s/g, '')).toBe(title);
    expect(hasSmoke(commits[0] ?? '')).toBe(false);
    await flushNow(r);
  });

  it('releases a held heading synchronously before commitPending, preserving order', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, commits } = makeRenderer();
    r.push('## Title\n\nAfter the title.');
    expect(r.hasEmitted()).toBe(true);
    // Released synchronously; the heading's commit is then deferred (still condensing).
    expect(r.getPendingBuffer()).toBe('## Title\n\nAfter the title.');
    expect(commits).toHaveLength(0);
    r.commitPending();
    expect(commits.map((c) => stripAnsi(c).trim())).toEqual(['Title', 'After the title.']);
    await flushNow(r);
  });

  it('without the accent a heading is deferred only like any paragraph', async () => {
    const { r, commits } = makeRenderer();
    r.push('## Title\n\nBody');
    expect(commits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(commits.map((c) => stripAnsi(c).trim())).toEqual(['Title']);
    await flushNow(r);
  });

  it('does not smoke headings with AFK_SMOKE_TEXT=0', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '0');
    const { r, overlays } = makeRenderer();
    r.push('## Plain heading\nbody');
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(33);
    expect(overlays.some(hasSmoke)).toBe(false);
    await flushNow(r);
  });
});

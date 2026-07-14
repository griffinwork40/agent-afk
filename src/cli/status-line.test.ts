/**
 * Tests for src/cli/status-line.ts
 *
 * Uses a writable-stream mock with a synthetic `rows` + `isTTY` shape so the
 * ANSI codes can be asserted without touching a real terminal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatusLine } from './status-line.js';

interface MockStream {
  writes: string[];
  write(chunk: string): boolean;
  rows: number;
  columns: number;
  isTTY: boolean;
}

function mockStream(opts: { isTTY?: boolean; rows?: number } = {}): MockStream {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    rows: opts.rows ?? 24,
    columns: 80,
    isTTY: opts.isTTY ?? true,
  };
}

function lastJoined(s: MockStream): string {
  return s.writes.join('');
}

const BROAD_ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

describe('StatusLine', () => {
  let stream: MockStream;

  beforeEach(() => {
    stream = mockStream({ isTTY: true, rows: 24 });
  });

  it('start() emits scroll-region ANSI codes while preserving cursor position', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream });
    status.start();
    const out = lastJoined(stream);
    expect(out).toContain('\x1b[s');
    // Scroll region: ESC[1;23r (rows-1 = 23)
    expect(out).toContain('\x1b[1;23r');
    expect(out).toContain('\x1b[u');
  });

  it('start() is a no-op on non-TTY streams', () => {
    const nonTty = mockStream({ isTTY: false });
    const status = new StatusLine({ stream: nonTty as unknown as NodeJS.WriteStream });
    status.start();
    expect(nonTty.writes).toHaveLength(0);
  });

  it('repaint() writes cursor save/restore + clear-line + status text', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', cost: 0.42, tokens: 1200, contextPct: 0.15 });
    const out = lastJoined(stream);
    expect(out).toContain('\x1b[s');       // save cursor
    expect(out).toContain('\x1b[24;1H');   // move to bottom row
    expect(out).toContain('\x1b[2K');      // clear line
    expect(out).toContain('\x1b[u');       // restore cursor
    expect(out).toContain('sonnet');
    expect(out).toContain('15%');          // percent is still in the bar widget
    expect(out).toContain('$0.42');
  });

  it('repaint() is throttled below throttleMs', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 1000,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet' });
    const firstLen = stream.writes.length;
    status.repaint({ model: 'sonnet' });
    // Throttled: no new writes this cycle.
    expect(stream.writes.length).toBe(firstLen);
  });

  it('repaint() does not throw on non-TTY streams', () => {
    const nonTty = mockStream({ isTTY: false });
    const status = new StatusLine({ stream: nonTty as unknown as NodeJS.WriteStream });
    status.start();
    expect(() => status.repaint({ model: 'sonnet' })).not.toThrow();
    expect(nonTty.writes).toHaveLength(0);
  });

  it('stop() resets scroll region, clears the status row, and restores the cursor', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream });
    status.start();
    stream.writes.length = 0;
    status.stop();
    const out = lastJoined(stream);
    expect(out).toContain('\x1b[s');
    expect(out).toContain('\x1b[24;1H');   // move to bottom row
    expect(out).toContain('\x1b[2K');      // clear line
    expect(out).toContain('\x1b[r');       // reset scroll region
    expect(out).toContain('\x1b[u');
  });

  it('start() is idempotent', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream });
    status.start();
    const firstLen = stream.writes.length;
    status.start();
    expect(stream.writes.length).toBe(firstLen);
  });
});

describe('StatusLine.withFullScrollRegion', () => {
  let stream: MockStream;

  beforeEach(() => {
    stream = mockStream({ isTTY: true, rows: 24 });
  });

  it('resets DECSTBM, runs fn, re-establishes the scroll region, and re-paints status', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    // Prime lastFields so the trailing flush() actually emits a repaint.
    status.repaint({ model: 'sonnet' });
    stream.writes.length = 0;

    const inner = vi.fn(() => {
      stream.write('hello\n');
      return 'result';
    });
    const ret = status.withFullScrollRegion(inner);
    expect(ret).toBe('result');
    expect(inner).toHaveBeenCalledTimes(1);

    const ordered = stream.writes;
    // Ordering invariant (VT100 contract): DECSTBM reset MUST emit before
    // inner write, and DECSTBM re-establishment MUST emit after. Without
    // this, the inner `\n` still triggers a sub-region scroll and we lose
    // the very content the wrapper is meant to protect.
    const resetIdx = ordered.findIndex((s) => s === '\x1b[r');
    const innerIdx = ordered.findIndex((s) => s === 'hello\n');
    const reArmIdx = ordered.findIndex((s) => s === '\x1b[1;23r');
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(innerIdx).toBeGreaterThan(resetIdx);
    expect(reArmIdx).toBeGreaterThan(innerIdx);
    // Trailing flush() re-paints status at the bottom row.
    expect(lastJoined(stream)).toContain('\x1b[24;1H');
    expect(lastJoined(stream)).toContain('sonnet');
  });

  it('re-establishes DECSTBM even if fn() throws', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;

    expect(() => {
      status.withFullScrollRegion(() => {
        throw new Error('boom');
      });
    }).toThrow('boom');

    // Even on throw, the finally block must re-arm DECSTBM. Otherwise the
    // scroll region stays at full screen and the status row no longer
    // sticks.
    const joined = lastJoined(stream);
    expect(joined).toContain('\x1b[r');     // reset (entry)
    expect(joined).toContain('\x1b[1;23r'); // re-establishment (finally)
  });

  it('is a no-op pass-through when status line is not started', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream });
    // Note: no status.start() — DECSTBM is not active, so no protection needed.
    stream.writes.length = 0;
    const ret = status.withFullScrollRegion(() => {
      stream.write('hello\n');
      return 42;
    });
    expect(ret).toBe(42);
    // Only the inner write is emitted; no DECSTBM manipulation.
    expect(stream.writes).toEqual(['hello\n']);
  });

  it('is a no-op pass-through on non-TTY streams', () => {
    const nonTty = mockStream({ isTTY: false });
    const status = new StatusLine({ stream: nonTty as unknown as NodeJS.WriteStream });
    status.start(); // no-op on non-TTY, but still safe to call
    nonTty.writes.length = 0;
    const ret = status.withFullScrollRegion(() => {
      nonTty.write('hello\n');
      return 'ok';
    });
    expect(ret).toBe('ok');
    expect(nonTty.writes).toEqual(['hello\n']);
  });

  // Regression: 9d516e7 wrapped commitAbove() in withFullScrollRegion but
  // forgot that CSI r (DECSTBM, with or without args) homes the cursor to
  // (1,1) per DEC VT spec. The result: every agent-turn commitAbove painted
  // its scrollback line from (1,1), clobbering the banner — and the next
  // log-update repaint started from (1,1) too, doubling the damage. Every
  // other DECSTBM site in this file already brackets the emit with
  // `\x1b[s` / `\x1b[u`; this method must too.
  it('brackets each DECSTBM emit with cursor save/restore so fn() resumes from the caller cursor', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    // Prime lastFields so flush() actually emits the trailing status repaint.
    status.repaint({ model: 'sonnet' });
    stream.writes.length = 0;

    status.withFullScrollRegion(() => {
      stream.write('hello\n');
    });

    const ordered = stream.writes;
    const idxOf = (needle: string): number => ordered.indexOf(needle);

    // First toggle: save → reset → restore, all before the inner write.
    const saveBeforeResetIdx = idxOf('\x1b[s');
    const resetIdx = idxOf('\x1b[r');
    expect(saveBeforeResetIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(saveBeforeResetIdx);
    // The restore that pairs with the reset is the next `\x1b[u` after it.
    const restoreAfterResetIdx = ordered.findIndex(
      (s, i) => i > resetIdx && s === '\x1b[u',
    );
    expect(restoreAfterResetIdx).toBeGreaterThan(resetIdx);

    // Inner write lands AFTER the first restore (so cursor is at caller pos,
    // not at the (1,1) home left by `\x1b[r`).
    const innerIdx = idxOf('hello\n');
    expect(innerIdx).toBeGreaterThan(restoreAfterResetIdx);

    // Second toggle: save → re-arm → restore, all after the inner write and
    // before the trailing status flush.
    const saveBeforeReArmIdx = ordered.findIndex(
      (s, i) => i > innerIdx && s === '\x1b[s',
    );
    const reArmIdx = idxOf('\x1b[1;23r');
    expect(saveBeforeReArmIdx).toBeGreaterThan(innerIdx);
    expect(reArmIdx).toBeGreaterThan(saveBeforeReArmIdx);
    const restoreAfterReArmIdx = ordered.findIndex(
      (s, i) => i > reArmIdx && s === '\x1b[u',
    );
    expect(restoreAfterReArmIdx).toBeGreaterThan(reArmIdx);

    // Sanity: the status flush still fires after the re-arm's restore.
    expect(lastJoined(stream)).toContain('\x1b[24;1H');
  });

  it('preserves cursor save/restore bracketing even if fn() throws', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;

    expect(() => {
      status.withFullScrollRegion(() => {
        throw new Error('boom');
      });
    }).toThrow('boom');

    const ordered = stream.writes;
    // The entry-side save → reset → restore must still emit BEFORE fn()
    // throws (and therefore appears in the recorded write stream).
    const firstSaveIdx = ordered.indexOf('\x1b[s');
    const firstResetIdx = ordered.indexOf('\x1b[r');
    expect(firstSaveIdx).toBeGreaterThanOrEqual(0);
    expect(firstResetIdx).toBeGreaterThan(firstSaveIdx);
    const firstRestoreIdx = ordered.findIndex(
      (s, i) => i > firstResetIdx && s === '\x1b[u',
    );
    expect(firstRestoreIdx).toBeGreaterThan(firstResetIdx);

    // The finally block must STILL bracket its re-arm with save/restore so
    // the caller's cursor isn't stranded at (1,1) after a thrown fn().
    const reArmIdx = ordered.indexOf('\x1b[1;23r');
    expect(reArmIdx).toBeGreaterThan(firstRestoreIdx);
    const saveBeforeReArmIdx = ordered.findIndex(
      (s, i) => i < reArmIdx && i > firstRestoreIdx && s === '\x1b[s',
    );
    expect(saveBeforeReArmIdx).toBeGreaterThan(firstRestoreIdx);
    expect(saveBeforeReArmIdx).toBeLessThan(reArmIdx);
    const restoreAfterReArmIdx = ordered.findIndex(
      (s, i) => i > reArmIdx && s === '\x1b[u',
    );
    expect(restoreAfterReArmIdx).toBeGreaterThan(reArmIdx);
  });
});

describe('StatusLine resize handling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-anchors DECSTBM after stdout resize (debounced)', () => {
    vi.useFakeTimers();
    const stream = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    stream.rows = 30;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    const out = lastJoined(stream);
    expect(out).toContain('\x1b[1;29r');
    status.stop();
  });

  it('truncates status text to columns - 2', () => {
    const stream = mockStream({ isTTY: true, rows: 24 });
    stream.columns = 24;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    const longModel = 'a'.repeat(40);
    status.repaint({ model: longModel, cost: 0.01, tokens: 100 });
    const out = lastJoined(stream);
    const stripped = out.replace(/\x1B\[[0-9;]*m/g, '');
    expect(stripped).toContain('…');
    expect(stripped).not.toContain('a'.repeat(30));
    status.stop();
  });

  it('truncates colored text without leaving partial escape sequences', () => {
    const stream = mockStream({ isTTY: true, rows: 24 });
    stream.columns = 8;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', permissionMode: 'plan' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('…');
    expect(out).not.toContain('\x1b');
    status.stop();
  });

  it('stop() unsubscribes from resize bus', () => {
    vi.useFakeTimers();
    const stream = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    status.stop();
    const lenAfterStop = stream.writes.length;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    expect(stream.writes.length).toBe(lenAfterStop);
  });

  it('clears the previously painted row before repainting on a taller resize', () => {
    vi.useFakeTimers();
    const stream = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    status.repaint({ model: 'sonnet' });
    stream.writes.length = 0;
    stream.rows = 30;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    const out = lastJoined(stream);
    expect(out).toContain('\x1b[24;1H');
    expect(out).toContain('\x1b[2K');
    expect(out).toContain('\x1b[30;1H');
    status.stop();
  });

  it('clears the PRE-resize row, not a mid-window repaint row, when a repaint lands between resize and debounce', () => {
    // Race that preResizePaintedRow guards: a repaint() (e.g. a streaming token)
    // arrives in the 150ms debounce window AFTER SIGWINCH but BEFORE the
    // debounced onResize(). The mid-window repaint mutates lastPaintedRow to the
    // NEW row; without the immediate-channel snapshot, onResize() would read that
    // new row, decide old===new, and skip the stale-row clear — leaving a ghost.
    vi.useFakeTimers();
    const stream = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    // Paint at rows=24 → lastPaintedRow = 24.
    status.repaint({ model: 'sonnet' });
    stream.writes.length = 0;

    // SIGWINCH → grow to 30. The IMMEDIATE channel snapshots preResizePaintedRow=24
    // and nulls lastPaintedRow, synchronously, before the debounced onResize().
    stream.rows = 30;
    process.stdout.emit('resize');

    // Mid-window repaint lands before the debounce: paints at row 30 and sets
    // lastPaintedRow = 30 (the value that would corrupt the old-row reference).
    status.repaint({ model: 'opus' });

    // Flush the debounced channel → onResize() fires.
    vi.advanceTimersByTime(150);

    const out = lastJoined(stream);
    // onResize() must clear the TRUE pre-resize row (24), NOT the mid-window row.
    expect(out).toContain('\x1b[24;1H');
    expect(out).toContain('\x1b[2K');
    // New scroll region for the 30-row terminal is armed.
    expect(out).toContain('\x1b[1;29r');
    status.stop();
  });

  it('stop() during debounce window clears the pre-SIGWINCH row, not the new-geometry row', () => {
    // Race: SIGWINCH fires (preResizePaintedRow=24, lastPaintedRow=null), then a
    // mid-window repaint() seeds lastPaintedRow=30. stop() must erase row 24
    // (preResizePaintedRow), NOT row 30 (lastPaintedRow after the mid-window repaint).
    vi.useFakeTimers();
    const stream = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    status.repaint({ model: 'sonnet' }); // lastPaintedRow=24

    // SIGWINCH: preResizePaintedRow=24, lastPaintedRow=null.
    stream.rows = 30;
    process.stdout.emit('resize');

    // Mid-window repaint seeds lastPaintedRow=30.
    status.repaint({ model: 'sonnet' });

    stream.writes.length = 0;
    status.stop();
    const out = lastJoined(stream);

    // Must erase the true pre-SIGWINCH row (24).
    expect(out).toContain('\x1b[24;1H');
    // Must NOT erase the new-geometry row (30) — sharp: fails on buggy code.
    expect(out).not.toContain('\x1b[30;1H');
  });

  it('does not emit an invalid 1;0 scroll region when the terminal has one row', () => {
    const stream = mockStream({ isTTY: true, rows: 1 });
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    expect(lastJoined(stream)).not.toContain('\x1b[1;0r');
  });
});

describe('StatusLine with context bar widget', () => {
  let stream: MockStream;

  beforeEach(() => {
    stream = mockStream({ isTTY: true, rows: 24 });
  });

  it('repaint() with only contextPct set renders a bar widget with brackets', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      contextPct: 0.5,
      contextLimit: 200000,
      contextUsedTokens: 100000,
      contextSparkline: undefined,
    });
    const out = lastJoined(stream);
    const stripped = out.replace(BROAD_ANSI_RE, '');
    // Should contain the bar brackets
    expect(stripped).toContain('[');
    expect(stripped).toContain(']');
    // Should contain the percent
    expect(stripped).toContain('50%');
    status.stop();
  });

  it('repaint() with contextPct, contextUsedTokens, contextLimit renders full bar form', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      contextPct: 0.5,
      contextLimit: 200000,
      contextUsedTokens: 100000,
      contextSparkline: undefined,
    });
    const out = lastJoined(stream);
    const stripped = out.replace(BROAD_ANSI_RE, '');
    // Should contain slash separator for used/limit when width is sufficient
    expect(stripped).toContain('50%');
    status.stop();
  });

  it('repaint() with contextSparkline prepends sparkline to the bar', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      contextPct: 0.5,
      contextLimit: 200000,
      contextUsedTokens: 100000,
      contextSparkline: '▁▂▄▅▆',
    });
    const out = lastJoined(stream);
    const stripped = out.replace(BROAD_ANSI_RE, '');
    // Should contain the sparkline characters
    expect(stripped).toContain('▁▂▄▅▆');
    // Should contain the bar
    expect(stripped).toContain('[');
    expect(stripped).toContain(']');
    status.stop();
  });

  it('repaint() without contextPct fields falls back to old behavior', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cost: 0.42,
      tokens: 1200,
    });
    const out = lastJoined(stream);
    const stripped = out.replace(BROAD_ANSI_RE, '');
    expect(stripped).toContain('sonnet');
    expect(stripped).toContain('$0.42');
    expect(stripped).not.toContain('ctx');
    status.stop();
  });
});

describe('StatusLine with cwd field', () => {
  let stream: MockStream;

  beforeEach(() => {
    stream = mockStream({ isTTY: true, rows: 24 });
  });

  it('renders cwd when provided', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', cwd: '/tmp/some-project' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('/tmp/some-project');
    expect(out).toContain('sonnet');
    status.stop();
  });

  it('omits the cwd segment when cwd is undefined', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).not.toContain('/');
    expect(out).toContain('sonnet');
    status.stop();
  });

  it('places cwd before model so right-edge truncation preserves it', () => {
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', cwd: '/tmp/foo' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    const cwdIdx = out.indexOf('/tmp/foo');
    const modelIdx = out.indexOf('sonnet');
    expect(cwdIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThan(cwdIdx);
    status.stop();
  });
});

describe('StatusLine with git branch + PR field', () => {
  let stream: MockStream;

  beforeEach(() => {
    stream = mockStream({ isTTY: true, rows: 24 });
  });

  it('renders the branch with the ⎇ glyph when provided', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', branch: 'feat/x' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('⎇');
    expect(out).toContain('feat/x');
    expect(out).toContain('sonnet');
    status.stop();
  });

  it('appends the PR number as #<n> when provided alongside a branch', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', branch: 'feat/x', pr: 123 });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('feat/x');
    expect(out).toContain('#123');
    status.stop();
  });

  it('omits the git segment entirely when no branch is set', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).not.toContain('⎇');
    expect(out).toContain('sonnet');
    status.stop();
  });

  it('does not render a PR number without a branch (pr is only meaningful with branch)', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', pr: 123 });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).not.toContain('#123');
    expect(out).not.toContain('⎇');
    expect(out).toContain('sonnet');
    status.stop();
  });

  it('places the branch after cwd and before the model', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', cwd: '/tmp/proj', branch: 'feat/x' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    const cwdIdx = out.indexOf('proj');
    const branchIdx = out.indexOf('feat/x');
    const modelIdx = out.indexOf('sonnet');
    expect(cwdIdx).toBeGreaterThanOrEqual(0);
    expect(branchIdx).toBeGreaterThan(cwdIdx);
    expect(modelIdx).toBeGreaterThan(branchIdx);
    status.stop();
  });

  it('truncates an over-long branch name (cap 30 cols)', () => {
    stream.columns = 200; // wide enough that the line itself never truncates
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    const longBranch = 'feat/' + 'a'.repeat(60);
    status.repaint({ model: 'sonnet', branch: longBranch });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('…');
    expect(out).not.toContain('a'.repeat(40));
    status.stop();
  });

  it('keeps the branch but drops tokens/cost on a narrow terminal (branch drops last)', () => {
    stream.columns = 30;
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', branch: 'feat/x', cost: 0.05, tokens: 1200 });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('feat/x'); // branch (lowest drop priority) survives
    expect(out).not.toContain('tok'); // tokens (drop-first) gone
    status.stop();
  });

  it('drops the branch before the model on a very narrow terminal', () => {
    stream.columns = 12;
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', branch: 'feat/x' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('sonnet'); // model never drops
    expect(out).not.toContain('feat/x');
    status.stop();
  });
});

describe('StatusLine narrow-terminal priority drop', () => {
  let stream: MockStream;

  beforeEach(() => {
    stream = mockStream({ isTTY: true, rows: 24 });
  });

  it('wide terminal (80 cols): all fields present (cwd, model, cost, tokens)', () => {
    stream.columns = 80;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/tmp/project',
      cost: 0.05,
      tokens: 1200,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('/tmp/project');
    expect(out).toContain('sonnet');
    expect(out).toContain('$0.05');
    expect(out).toContain('tok');
    status.stop();
  });

  it('narrow terminal (34 cols): tokens drop out first, cost and model remain', () => {
    stream.columns = 34;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/tmp/project',
      cost: 0.05,
      tokens: 1200,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('sonnet');
    expect(out).toContain('$0.05');
    expect(out).not.toContain('tok');
    status.stop();
  });

  it('narrower terminal (24 cols): tokens AND cost drop, model survives', () => {
    stream.columns = 24;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/tmp/project',
      cost: 0.05,
      tokens: 1200,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('sonnet');
    expect(out).not.toContain('$0.05');
    expect(out).not.toContain('tok');
    status.stop();
  });

  it('very narrow terminal (12 cols): only model survives (truncated)', () => {
    stream.columns = 12;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/tmp/project',
      cost: 0.05,
      tokens: 1200,
      contextPct: 0.5,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    // With 12 cols, cwd budget is ~4 chars, model is 6 chars.
    // After dropping all droppables, we're left with cwd + model and truncate.
    // The result should not have cost, tokens, or context.
    expect(out).not.toContain('$');
    expect(out).not.toContain('tok');
    expect(out).not.toContain('%');
    status.stop();
  });

  it('drops tokens before cost', () => {
    // At 30 cols, tokens should drop before cost
    stream.columns = 30;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/tmp',
      cost: 0.05,
      tokens: 1200,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).not.toContain('tok');
    expect(out).toContain('$0.05');
    status.stop();
  });

  it('drops context bar last among droppables', () => {
    // Verify the drop order by checking that at a width where we must drop something,
    // tokens drops first, then cost, then context bar.
    // Start with a width where all droppables are present.
    stream.columns = 60;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cost: 0.05,
      tokens: 1200,
      contextPct: 0.5,
      contextLimit: 200000,
      contextUsedTokens: 100000,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    // At 60 cols, all should be present
    expect(out).toContain('$0.05');
    expect(out).toContain('tok');
    expect(out).toContain('[');
    status.stop();
  });

  it('never drops cwd or model', () => {
    stream.columns = 16;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/x',
      cost: 0.05,
      tokens: 1200,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    // At least some part of model should survive
    expect(out).toContain('sonnet');
    // Cost and tokens should be gone
    expect(out).not.toContain('$');
    expect(out).not.toContain('tok');
    status.stop();
  });

  it('with plan mode: never drops plan indicator', () => {
    stream.columns = 30;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/tmp',
      cost: 0.05,
      tokens: 1200,
      permissionMode: 'plan',
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('● plan');
    expect(out).not.toContain('tok');
    status.stop();
  });

  it('with AFK mode: never drops the AFK indicator', () => {
    stream.columns = 30;
    const status = new StatusLine({
      stream: stream as unknown as NodeJS.WriteStream,
      throttleMs: 0,
    });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/tmp',
      cost: 0.05,
      tokens: 1200,
      permissionMode: 'autonomous',
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('◐ AFK');
    expect(out).not.toContain('tok');
    status.stop();
  });
});

describe('StatusLine cwd/branch worktree dedupe', () => {
  let stream: MockStream;

  beforeEach(() => {
    stream = mockStream({ isTTY: true, rows: 24 });
  });

  it('renders one merged ⎇ segment when branch matches the cwd basename (afk worktree pattern)', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-47b3ec',
      branch: 'afk/20260705-142358-47b3ec',
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    // The branch spelling appears (once, via the merged ⎇ segment)…
    expect(out).toContain('⎇ afk/20260705-142358-47b3ec');
    // …and the cwd spelling (slash → dash) does not: the cwd part was omitted.
    expect(out).not.toContain('afk-20260705-142358-47b3ec');
    // The shared slug renders exactly once across the whole line.
    const slug = '20260705-142358-47b3ec';
    expect(out.indexOf(slug)).toBe(out.lastIndexOf(slug));
    status.stop();
  });

  it('sheds the merged location segment before truncating the model on a narrow terminal', () => {
    // Regression guard for the dedupe model-truncation bug: the merged segment
    // is drop-last among droppables (droppablePriority 1), NOT never-drop. If
    // it were never-drop it would stack with the never-drop model, blow maxW at
    // this width, and the final blind truncation would shear the model 'sonnet'
    // off the right edge — violating formatLine's "never drop: model" invariant.
    // So at this pathological width the location sheds and the MODEL survives.
    stream.columns = 32;
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-47b3ec',
      branch: 'afk/20260705-142358-47b3ec',
      cost: 0.05,
      tokens: 1200,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    // The model — the never-drop identity — is preserved…
    expect(out).toContain('sonnet');
    // …at this width the merged location segment had to shed to make room, so
    // the full worktree identity does not survive (it drops, like the plain
    // branch does in the else-branch at the same width).
    expect(out).not.toContain('afk/20260705-142358-47b3ec');
    // Lowest-priority droppables (tokens) still shed first.
    expect(out).not.toContain('tok');
    status.stop();
  });

  it('preserves the #PR suffix inside the merged segment', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-47b3ec',
      branch: 'afk/20260705-142358-47b3ec',
      pr: 7,
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('⎇ afk/20260705-142358-47b3ec #7');
    status.stop();
  });

  it('renders cwd and branch separately when they do not match', () => {
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', cwd: '/tmp/proj', branch: 'feat/x' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    expect(out).toContain('proj');
    expect(out).toContain('⎇ feat/x');
    status.stop();
  });

  it('does NOT merge on a name coincidence outside .afk-worktrees (positive worktree signal required)', () => {
    // cwd basename `redesign` equals the branch, but the parent dir is `/tmp`,
    // not `.afk-worktrees` — this is a plain checkout, not a managed worktree.
    // The cwd ("where am I?") must NOT be suppressed on a name coincidence
    // alone; a positive worktree signal (parent dir) is required to dedupe.
    stream.columns = 100;
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({ model: 'sonnet', cwd: '/tmp/redesign', branch: 'redesign' });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    // Both the cwd and the branch segment render, so the coincident identity
    // appears twice — it was NOT collapsed into one merged segment (contrast
    // the afk-worktree dedupe cases, where the shared slug renders exactly once).
    expect(out).toContain('⎇ redesign');
    expect(out.indexOf('redesign')).not.toBe(out.lastIndexOf('redesign'));
    status.stop();
  });

  it('does NOT merge when the shared identity exceeds the 30-col cap — keeps cwd as a second signal', () => {
    // A genuine managed-worktree path (parent IS .afk-worktrees) whose identity
    // is >30 cols. Merging would truncate the branch to 30 cols and drop the
    // cwd, leaving an ambiguous truncated string as the SOLE location signal —
    // strictly worse than the un-deduped line. So dedupe falls back and keeps
    // the cwd leaf as a second signal. Wide terminal so the cwd leaf (which
    // formatCwd always preserves) isn't itself right-edge truncated.
    stream.columns = 200;
    const status = new StatusLine({ stream: stream as unknown as NodeJS.WriteStream, throttleMs: 0 });
    status.start();
    stream.writes.length = 0;
    status.repaint({
      model: 'sonnet',
      cwd: '/Users/x/proj/.afk-worktrees/afk-20260705-142358-verylongsuffix-xy',
      branch: 'afk/20260705-142358-verylongsuffix-xy',
    });
    const out = lastJoined(stream).replace(BROAD_ANSI_RE, '');
    // The cwd leaf (dash-form) is preserved — under the merge path it would be
    // hidden entirely, so its presence proves the >30-col fallback fired.
    expect(out).toContain('afk-20260705-142358-verylongsuffix-xy');
    // The branch segment still renders…
    expect(out).toContain('⎇');
    // …but capped at 30 cols, so the full slash-form branch does not appear.
    expect(out).not.toContain('afk/20260705-142358-verylongsuffix-xy');
    status.stop();
  });
});

describe('StatusLine — AFK_PLAIN_OUTPUT full render opt-out', () => {
  // Regression: --plain must make a TTY session behave like a non-TTY surface
  // for the status line too. Before the fix, `enabled` was `force || isTTY`,
  // so a --plain TTY (isTTY still true) armed a DECSTBM scroll region and
  // painted a cursor-positioned status row concurrent with the renderer's raw
  // stdout writes — the exact corruption class the flag exists to escape.
  // Streams here are real-TTY-shaped stand-ins so the assertion exercises the
  // `stream.isTTY` read path, not a `force`/non-TTY shortcut.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('start()/repaint()/setExtraRows()/stop() emit nothing on a real-TTY stream when AFK_PLAIN_OUTPUT=1', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
    const tty = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({ stream: tty as unknown as NodeJS.WriteStream });
    status.start();
    status.repaint({ model: 'sonnet' });
    status.setExtraRows(2);
    status.stop();
    expect(tty.writes).toHaveLength(0);
  });

  it('still arms the scroll region on a TTY when AFK_PLAIN_OUTPUT is unset (no behavior change)', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);
    const tty = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({ stream: tty as unknown as NodeJS.WriteStream });
    status.start();
    // DECSTBM scroll region ESC[1;23r proves the status stack is live.
    expect(lastJoined(tty)).toContain('\x1b[1;23r');
    status.stop();
  });

  it('does not suppress for unrecognized values (e.g. "0")', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', '0');
    const tty = mockStream({ isTTY: true, rows: 24 });
    const status = new StatusLine({ stream: tty as unknown as NodeJS.WriteStream });
    status.start();
    expect(lastJoined(tty)).toContain('\x1b[1;23r');
    status.stop();
  });

  it('force:true still wins over AFK_PLAIN_OUTPUT (explicit test override)', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
    const nonTty = mockStream({ isTTY: false, rows: 24 });
    const status = new StatusLine({
      stream: nonTty as unknown as NodeJS.WriteStream,
      force: true,
    });
    status.start();
    expect(lastJoined(nonTty)).toContain('\x1b[1;23r');
    status.stop();
  });
});

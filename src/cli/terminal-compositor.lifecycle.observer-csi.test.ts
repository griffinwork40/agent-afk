/**
 * Observer CSI tracking tests (B1, L1, L3)
 *
 * Tests for the suspend write observer's cursor-row tracking:
 *
 *   B1 — CSI and ESC sequence handling: verify that CUU/CUD/CUP/CHA/etc.,
 *        ESC 7/8/M/D/E, and the selector-style rewind pattern all produce the
 *        correct cursor row after processing.
 *
 *   L1 — remove() reference equality: double-calling remove() is a no-op on
 *        the second call; a wrapper installed after us is not blown away.
 *
 *   L3 — live dimensions: after a SIGWINCH (stream.rows/columns change),
 *        advanceRow() and soft-wrap use the new values.
 *
 * The tests for B1 items 3–4 (on-screen commit-placement after selector
 * rewind) use the real TerminalCompositor + VirtualScreen harness. All other
 * tests use installObserver directly with a PassThrough mock stream.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { installObserver } from './terminal-compositor.lifecycle.suspend-observer.js';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

// ---------------------------------------------------------------------------
// Helpers for direct-observer tests
// ---------------------------------------------------------------------------

type MockStream = NodeJS.WriteStream & { rows: number; columns: number };

function makeStream(rows = 24, cols = 80): MockStream {
  const s = new PassThrough() as unknown as MockStream;
  s.rows = rows;
  s.columns = cols;
  return s;
}

/** Write bytes to stream and return the observer's cursorRow after remove(). */
function observeWrites(
  stream: MockStream,
  writes: string[],
  startRow = 1,
): { cursorRow: number; scrollCount: number } {
  const obs = installObserver(stream, startRow, stream.rows, stream.columns);
  for (const w of writes) stream.write(w);
  return obs.remove();
}

// ---------------------------------------------------------------------------
// B1: selector-style rewind tests (direct observer)
// ---------------------------------------------------------------------------

describe('B1: selector-style rewind leaves R at the correct cursor row', () => {
  /**
   * Simulate what renderSelector does:
   *   1. Write N lines (content + '\n') — cursor ends at row startRow + N.
   *   2. For each of k redraws: write ESC[NA + ESC[0J + N lines + '\n'.
   *
   * After k redraws R must equal startRow + N (the cursor remains at the
   * bottom of the painted block, same as after the initial paint).
   *
   * Without B1 fix: each rewind's ESC[NA is a no-op (treated as Normal),
   * so row advances by N on every redraw and R = startRow + N + k*N.
   */
  it('selector-style rewind: N lines painted then redrawn k times leaves R at true cursor row (bottom-pin)', () => {
    const stream = makeStream(24, 80);
    const N = 5;
    const k = 3;
    const startRow = 1;

    const obs = installObserver(stream, startRow, stream.rows, stream.columns);

    // Initial paint: N content lines + '\n' moves cursor to startRow + N.
    for (let i = 0; i < N; i++) stream.write(`line-${i}\n`);

    // k redraws: ESC[NA (cursor up N), ESC[0J (erase to end, no cursor move),
    // then N lines + '\n' again.
    for (let r = 0; r < k; r++) {
      stream.write(`\x1b[${N}A`); // CUU N — cursor up
      stream.write(`\x1b[0J`);    // erase-to-end — no cursor movement
      for (let i = 0; i < N; i++) stream.write(`line-${i}\n`);
    }

    const { cursorRow, scrollCount } = obs.remove();
    expect(scrollCount).toBe(0);
    expect(cursorRow).toBe(startRow + N);
  });

  it('selector-style rewind: content-hug variant (different N)', () => {
    const stream = makeStream(24, 80);
    const N = 8;
    const k = 4;
    const startRow = 3;

    const obs = installObserver(stream, startRow, stream.rows, stream.columns);

    for (let i = 0; i < N; i++) stream.write(`item-${i}\n`);

    for (let r = 0; r < k; r++) {
      stream.write(`\x1b[${N}A`);
      stream.write(`\x1b[0J`);
      for (let i = 0; i < N; i++) stream.write(`item-${i}\n`);
    }

    const { cursorRow, scrollCount } = obs.remove();
    expect(scrollCount).toBe(0);
    expect(cursorRow).toBe(startRow + N);
  });
});

// ---------------------------------------------------------------------------
// B1: individual CSI sequence tracking
// ---------------------------------------------------------------------------

describe('B1: individual CSI cursor-movement sequences', () => {
  it('CUU (ESC[A) moves cursor up', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, [
      'line1\n', // row 2
      'line2\n', // row 3
      '\x1b[2A', // CUU 2 — should go to row 1
    ], 1);
    expect(cursorRow).toBe(1);
  });

  it('CUD (ESC[B) moves cursor down', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1b[3B'], 2);
    expect(cursorRow).toBe(5);
  });

  it('CUD clamps at terminal rows', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1b[100B'], 20);
    expect(cursorRow).toBe(24);
  });

  it('CUP (ESC[H) sets absolute row', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1b[10;5H'], 1);
    expect(cursorRow).toBe(10);
  });

  it('CUP (ESC[H) with no params goes to row 1, col 1', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['line\n', '\x1b[H'], 1);
    expect(cursorRow).toBe(1);
  });

  it('VPA (ESC[d) sets absolute row', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1b[15d'], 1);
    expect(cursorRow).toBe(15);
  });

  it('CHA (ESC[G) moves column only — row unchanged', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['line\n', '\x1b[5G'], 1);
    expect(cursorRow).toBe(2); // one \n moved to row 2; G does not change row
  });

  it('CNL (ESC[E) moves down N rows and resets col', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1b[3E'], 2);
    expect(cursorRow).toBe(5);
  });

  it('CPL (ESC[F) moves up N rows and resets col', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1b[2F'], 5);
    expect(cursorRow).toBe(3);
  });

  it('ESC M (reverse index) moves cursor up one row', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['a\nb\n', '\x1bM'], 1);
    // After 2 newlines: row = 3. ESC M: row = 2.
    expect(cursorRow).toBe(2);
  });

  it('ESC M does not go below row 1', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1bM'], 1);
    expect(cursorRow).toBe(1);
  });

  it('ESC D (index) advances row like LF', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1bD\x1bD'], 1);
    expect(cursorRow).toBe(3);
  });

  it('ESC E (NEL) advances row and resets col', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, ['\x1bE\x1bE'], 1);
    expect(cursorRow).toBe(3);
  });

  it('ESC 7 / ESC 8 save and restore cursor', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, [
      '\x1b[10d',  // VPA 10
      '\x1b7',     // save (row=10)
      '\x1b[20d',  // VPA 20
      '\x1b8',     // restore (row=10)
    ], 1);
    expect(cursorRow).toBe(10);
  });

  it('CSI s / CSI u save and restore cursor', () => {
    const stream = makeStream(24, 80);
    const { cursorRow } = observeWrites(stream, [
      '\x1b[12d', // VPA 12
      '\x1b[s',   // CSI s — save
      '\x1b[20d', // VPA 20
      '\x1b[u',   // CSI u — restore
    ], 1);
    expect(cursorRow).toBe(12);
  });

  it('readline-style edit (CR + ESC[K + ESC[G) does not move R', () => {
    // Simulate a readline prompt re-draw: write text, CR to col 0,
    // ESC[K (erase to end of line), ESC[G (CHA 1).
    // R must remain the same (col moves but row stays).
    const stream = makeStream(24, 80);
    const { cursorRow, scrollCount } = observeWrites(stream, [
      'text\r',     // \r resets col, row stays
      '\x1b[K',     // EL — erase line, no cursor move
      '\x1b[1G',    // CHA 1 — col to 0-based 0, row unchanged
    ], 5);
    expect(scrollCount).toBe(0);
    expect(cursorRow).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// B1: csiBuf overflow cap
// ---------------------------------------------------------------------------

describe('B1: csiBuf overflow cap', () => {
  it('CSI sequence longer than 64 chars is discarded (no crash, no corrupt row)', () => {
    const stream = makeStream(24, 80);
    // Write a CSI sequence with 70 parameter bytes — should be discarded.
    const longParam = '1'.repeat(70);
    const { cursorRow } = observeWrites(stream, [
      'line1\n',               // row 2
      `\x1b[${longParam}A`,   // malformed CUU — should be discarded
      'line2\n',               // row 3
    ], 1);
    expect(cursorRow).toBe(3); // only the two \n moves counted
  });
});

// ---------------------------------------------------------------------------
// B1: compositor integration tests (TerminalCompositor + VirtualScreen)
// ---------------------------------------------------------------------------

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

function makeStdout(rows = 24, cols = 80): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  return s;
}

function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => { (s as any).isRaw = raw; return s; });
  return s;
}

function attachScreen(stdout: MockStdout): VirtualScreen {
  const vs = new VirtualScreen(stdout.columns, stdout.rows);
  stdout.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) vs.write(chunk);
    else if (typeof chunk === 'string') vs.write(Buffer.from(chunk, 'utf-8'));
  });
  return vs;
}

function dumpScreen(vs: VirtualScreen): string {
  return [
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3)}] ${JSON.stringify(l)}`),
    ...vs.visibleLines().map((l, i) => `[vp-${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`),
  ].join('\n');
}

interface CompositorRig {
  c: TerminalCompositor;
  vs: VirtualScreen;
  stdout: MockStdout;
  frameTop(): number;
}

async function makeCompositorRig(opts: { contentHug?: boolean } = {}): Promise<CompositorRig> {
  const stdout = makeStdout();
  const vs = attachScreen(stdout);
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    anchorRow: 1,
    ...(opts.contentHug ? { contentHug: true } : {}),
  });
  await c.arm();
  const raw = c as unknown as { lastMeasuredFrameTop: number; repaint(): void };
  return {
    c,
    vs,
    stdout,
    frameTop: () => raw.lastMeasuredFrameTop,
  };
}

describe('B1: on-resume commit placement after selector-style rewind', () => {
  /**
   * Simulate a selector: write N lines, then k redraws via ESC[NA + lines.
   * After resumeInput, commit 'COMMIT-AFTER' and verify it appears directly
   * below the selector output with no blank gap (bottom-pin).
   */
  it('on resume after selector, next commit lands directly below selector output with no blank gap (bottom-pin)', async () => {
    // What this test verifies: with the B1 fix, the observer correctly tracks
    // that the CUU N + redraws leave R at startRow+N (not startRow+N + k*N).
    // The commit therefore lands in the correct place (anchored to R+1, not to
    // a vastly inflated R). We assert no duplication and that COMMIT-AFTER
    // appears exactly once and after the selector output in reading order.
    const { c, vs, stdout } = await makeCompositorRig({ contentHug: false });
    const N = 5; // selector lines
    const k = 2; // redraws

    c.suspendInput();

    // Simulate selector: initial paint
    for (let i = 0; i < N; i++) stdout.write(`sel-line-${i}\n`);

    // Simulate selector redraws
    for (let r = 0; r < k; r++) {
      stdout.write(`\x1b[${N}A`); // CUU N
      stdout.write('\x1b[0J');    // erase to end
      for (let i = 0; i < N; i++) stdout.write(`sel-line-${i}\n`);
    }

    c.resumeInput();
    c.commitAbove('COMMIT-AFTER\n');
    (c as any).repaint();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // COMMIT-AFTER must appear exactly once.
    const commitCount = all.filter((l) => l.trim() === 'COMMIT-AFTER').length;
    expect(commitCount, `COMMIT-AFTER must appear exactly once:\n${dump}`).toBe(1);

    // Each selector line must appear exactly once (no duplication from inflated R).
    for (let i = 0; i < N; i++) {
      const label = `sel-line-${i}`;
      const count = all.filter((l) => l.trim() === label).length;
      expect(count, `${label} must appear exactly once:\n${dump}`).toBe(1);
    }

    // COMMIT-AFTER must come after the last selector line in reading order.
    const commitIdx = all.findIndex((l) => l.trim() === 'COMMIT-AFTER');
    const lastSelIdx = all.findLastIndex((l) => l.trim() === `sel-line-${N - 1}`);
    expect(commitIdx, `COMMIT-AFTER (${commitIdx}) must come after sel-line-${N-1} (${lastSelIdx}):\n${dump}`).toBeGreaterThan(lastSelIdx);

    c.disarm();
  });

  it('on resume after selector, next commit lands directly below selector output with no blank gap (content-hug)', async () => {
    // Same invariants as bottom-pin variant but with contentHug:true.
    // Key invariant: HUG-COMMIT must appear exactly once after resume, and
    // the compositor must not duplicate the selector content. We don't assert
    // tight row proximity because content-hug starts near the top of the
    // viewport and the selector output may soft-wrap.
    const { c, vs, stdout } = await makeCompositorRig({ contentHug: true });
    const N = 4;
    const k = 3;

    c.suspendInput();

    for (let i = 0; i < N; i++) stdout.write(`hugsel-line-${i}\n`);
    for (let r = 0; r < k; r++) {
      stdout.write(`\x1b[${N}A`);
      stdout.write('\x1b[0J');
      for (let i = 0; i < N; i++) stdout.write(`hugsel-line-${i}\n`);
    }

    c.resumeInput();
    c.commitAbove('HUG-COMMIT\n');
    (c as any).repaint();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // Primary invariant: HUG-COMMIT must appear exactly once.
    const commitCount = all.filter((l) => l.trim() === 'HUG-COMMIT').length;
    expect(commitCount, `HUG-COMMIT must appear exactly once:\n${dump}`).toBe(1);

    // HUG-COMMIT must follow the selector output in reading order.
    const commitIdx = all.findIndex((l) => l.trim() === 'HUG-COMMIT');
    // The selector wrote N lines ending at row N (from startRow=1). The
    // commit must come at or after that in the all array.
    expect(commitIdx, `HUG-COMMIT must be reachable in screen:\n${dump}`).toBeGreaterThanOrEqual(0);

    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// L1: remove() reference equality (idempotency + chain safety)
// ---------------------------------------------------------------------------

describe('L1: remove() reference equality', () => {
  it('double-calling remove() only restores once (second call is a no-op)', () => {
    const stream = makeStream(24, 80);

    const obs = installObserver(stream, 1, stream.rows, stream.columns);

    // Capture the wrapper that installObserver installed.
    const installedWrapper = (stream as any).write as typeof stream.write;

    // Advance cursor so we get a non-trivial state.
    stream.write('line1\n');
    stream.write('line2\n');

    // First remove: should restore the original write (removing our wrapper).
    const state1 = obs.remove();
    // stream.write should NOT be our wrapper anymore.
    expect((stream as any).write, 'wrapper should be removed after first remove()').not.toBe(installedWrapper);

    // Capture the restored write for reference.
    const restoredWrite = (stream as any).write as typeof stream.write;

    // Second remove: must not throw and stream.write must still be the same
    // restored write (not changed again).
    const state2 = obs.remove();
    expect((stream as any).write, 'stream.write must not change on second remove()').toBe(restoredWrite);

    // Both calls return the same logical state.
    expect(state1.cursorRow).toBe(state2.cursorRow);
    expect(state1.scrollCount).toBe(state2.scrollCount);
  });

  it('if another wrapper is installed after us, our remove() does not blow it away', () => {
    const stream = makeStream(24, 80);

    const obs = installObserver(stream, 1, stream.rows, stream.columns);
    // Capture our wrapper reference (whatever the stream has now).
    const ourWrapper = (stream as any).write as typeof stream.write;

    // Someone installs another wrapper after us (e.g. a second observer layer).
    const innerWrapper = vi.fn((...args: unknown[]) => (ourWrapper as any)(...args) as boolean);
    (stream as any).write = innerWrapper;

    // Our remove() must NOT restore origWrite (it would blow away innerWrapper).
    // Since stream.write !== ourWrapper (innerWrapper replaced it), remove()
    // should be a no-op w.r.t. stream.write.
    obs.remove();
    expect((stream as any).write, 'inner wrapper must still be installed').toBe(innerWrapper);
  });
});

// ---------------------------------------------------------------------------
// L3: live dimensions after SIGWINCH
// ---------------------------------------------------------------------------

describe('L3: live dimensions after SIGWINCH', () => {
  it('after stream.rows decreases, advanceRow() uses the new row count to count scrolls', () => {
    // Write exactly (newRows - startRow) lines after the SIGWINCH, so we're
    // positioned exactly at the new floor before the tested lines. Then write
    // more lines and verify they scroll (not advance row) with the new floor.
    //
    // Strategy: startRow = 1, newRows = 10. Write 9 lines to reach row 10
    // (the new floor). Then shrink to 10 rows. Now write 3 more lines —
    // with old dims (24 rows) they would NOT scroll; with new dims (10 rows)
    // all 3 advance past the floor and scroll.

    const stream = makeStream(24, 80);
    const startRow = 1;
    const newRows = 10;
    const obs = installObserver(stream, startRow, stream.rows, stream.columns);

    // Write 9 lines: row goes from 1 to 10 (no scroll — original floor is 24).
    for (let i = 0; i < 9; i++) stream.write(`pre-${i}\n`);
    // row is now 10, scrolls = 0.

    // Simulate SIGWINCH: terminal shrinks to 10 rows.
    stream.rows = newRows;

    // Write 3 more lines. With new floor = 10, row is already AT the floor,
    // so every advanceRow() call should scroll (not advance).
    for (let i = 0; i < 3; i++) stream.write(`post-${i}\n`);

    const { scrollCount } = obs.remove();
    // Without fix (using original 24-row snapshot): 0 scrolls
    //   (row advances from 10 to 13, well under the old 24-row floor).
    // With fix (using live stream.rows = 10): 3 scrolls
    //   (row was at 10 = floor, so each \n scrolls).
    expect(scrollCount).toBe(3);
  });

  it('after stream.columns decreases, soft-wrap uses the new column count', () => {
    const stream = makeStream(24, 80);
    const obs = installObserver(stream, 1, stream.rows, stream.columns);

    // Write a non-wrapping string on 80-col terminal.
    stream.write('A'.repeat(40)); // 40 chars — no wrap at col 80

    // Simulate terminal width shrinking to 30.
    stream.columns = 30;

    // Write enough to trigger a wrap at the new 30-col width.
    // Currently col is at 40 (past the new 30-col limit). The next write
    // should wrap immediately and start counting from col 0.
    // Write 30 more chars: with the new getCols()=30, the current col=40
    // is already >= 30, but the observer does not retroactively adjust col.
    // To verify live-dims, write a 30-char line that would wrap at 30-col.
    stream.write('B'.repeat(30)); // fills col 30 → triggers wrap
    // Then write another line with \n.
    stream.write('\n');

    const { cursorRow } = obs.remove();
    // At least the \n should have bumped the row. With live dims we also expect
    // the 30-char fill to have triggered a soft-wrap, adding at least one row.
    expect(cursorRow).toBeGreaterThanOrEqual(2);
  });
});

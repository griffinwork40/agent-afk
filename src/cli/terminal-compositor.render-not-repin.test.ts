/**
 * Stage 2 (#540 — "render, don't re-pin") regression.
 *
 * repositionCommittedBand re-renders the visible window STATELESSLY: it erases
 * the above-frame content region from the anchor FLOOR, not from the (possibly
 * stale) tracked band top `committedBandTopRow`, then repaints the band's bottom
 * `fit` rows hugging the frame. So the on-screen result is a pure function of
 * (committedBand, floor, targetBottom) — a row stranded above a DRIFTED tracked
 * top (the scrollback-gap "void": a row a prior eager-scroll / eviction / echo
 * left painted while the tracked top slid below it) is cleared by construction
 * on the next repaint, instead of surviving because the incremental erase began
 * below it.
 *
 * HARD CORRECTNESS GATE: this test FAILS on the pre-Stage-2 erase
 *   `for (let r = Math.max(floor, self.committedBandTopRow); r < newTop; r++)`
 * — the stranded row at physical row 3 survives because the erase starts at
 * row 5 (the drifted tracked top) — and PASSES after Stage 2
 *   `for (let r = floor; r < newTop; r++)`.
 *
 * This is a direct unit test of the free function on a constructed
 * CommittedBandHost (the same "free-functions-on-host" testability pattern as
 * commit-mode.test.ts → decideCommitMode). The full end-to-end void needs a
 * real PTY to certify (docs/scrollback.md:108-111); this isolates the exact
 * viewport property the fix establishes, which @xterm/headless CAN certify.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { repositionCommittedBand } from './terminal-compositor.committed-band-repin.js';
import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import { eraseAndPaintRow } from './terminal-compositor.scrollback.js';

const COLS = 80;
const ROWS = 24;

type Out = NodeJS.WriteStream & { columns: number; rows: number };

function makeStdout(): Out {
  const s = new PassThrough() as unknown as Out;
  s.columns = COLS;
  s.rows = ROWS;
  return s;
}
function collect(stream: Out): () => string {
  const chunks: string[] = [];
  (stream as unknown as PassThrough).on('data', (c: unknown) => chunks.push(String(c)));
  return () => chunks.join('');
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (l != null) out.push(l.translateToString(true));
  }
  return out;
}

function makeHost(stdout: Out, over: Partial<CommittedBandHost>): CommittedBandHost {
  return {
    repaint: () => {},
    debugLog: () => {},
    committedBand: [],
    committedBandMeta: [],
    committedBandTopRow: 0,
    committedBandBottomRow: 0,
    lastMeasuredFrameTop: 0,
    committedBandPaintedRows: 0,
    bandReflowCache: null,
    committing: false,
    commitInFlight: false,
    hasCommitted: true,
    pendingResizeErase: null,
    bandGeometryStale: false,
    anchorRow: 1,
    armed: true,
    // repin only null-checks logUpdate; it never calls a method on it.
    logUpdate: {} as never,
    stdout,
    ...over,
  };
}

describe('Stage 2 (#540) render-not-repin: stateless window re-render', () => {
  it('erases a row stranded above a drifted committedBandTopRow (gap-free by construction)', async () => {
    const stdout = makeStdout();
    const all = collect(stdout);

    // Pre-state: a "stranded" committed row physically painted at row 3, while
    // the band model's tracked top has DRIFTED DOWN to row 5 — BELOW the
    // stranded row. The pre-Stage-2 erase starts at max(floor=1, 5)=5 and never
    // touches row 3; the Stage-2 erase starts at floor=1 and clears it.
    stdout.write(eraseAndPaintRow(3, 'STRANDED-VOID-ROW'));

    const host = makeHost(stdout, {
      committedBand: ['BAND-A row', 'BAND-B row', 'BAND-C row'],
      committedBandTopRow: 5, // drifted BELOW the stranded row at row 3
      committedBandBottomRow: 7,
      committedBandPaintedRows: 3,
      anchorRow: 1, // floor = 1
    });

    // Repaint geometry: bottom-aligned band at [6, 8]:
    //   desiredTopRow=9 → targetBottom=8; floor=1 → maxFit=8 → fit=3 → newTop=6.
    // moved = (newTop 6 !== committedBandTopRow 5) → true, so it repaints.
    repositionCommittedBand(host, /* desiredTopRow */ 9, /* preRenderFrameTop */ 0, /* targetBottomRow */ 23);

    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 100,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines
      .map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`)
      .join('\n');

    // (1) The band is re-rendered bottom-aligned at rows 6..8 (0-based 5..7).
    expect(lines.some((l) => l.includes('BAND-A row')), `band not rendered:\n${dump}`).toBe(true);
    expect(lines.some((l) => l.includes('BAND-C row')), `band not rendered:\n${dump}`).toBe(true);

    // (2) THE STAGE-2 PROPERTY: the stranded row above the drifted tracked top
    //     must be GONE — cleared by the above-band erase, not left as a void.
    expect(
      lines.some((l) => l.includes('STRANDED-VOID-ROW')),
      `stranded row above the drifted tracked top survived — the scrollback-gap void:\n${dump}`,
    ).toBe(false);

    // (3) The region ABOVE the band [rows 1..5 → 0-based 0..4] is blank
    //     (bottom-aligned: blanks above band, content hugs frame top).
    for (let i = 0; i <= 4; i++) {
      expect((lines[i] ?? '').trim(), `row ${i + 1} not blank above the band:\n${dump}`).toBe('');
    }

    // (4) Field bookkeeping stays consistent for the commit/eviction readers.
    expect(host.committedBandTopRow).toBe(6);
    expect(host.committedBandBottomRow).toBe(8);
    expect(host.committedBandPaintedRows).toBe(3);
  });

  it('protects the banner/anchor region above the floor (never erases above anchorRow)', async () => {
    const stdout = makeStdout();
    const all = collect(stdout);

    // A 2-row banner occupies rows 1..2; the anchor floor is row 3. Content in
    // the protected [1, anchorRow) region must never be erased by the re-render.
    stdout.write(eraseAndPaintRow(1, 'BANNER-LINE-1'));
    stdout.write(eraseAndPaintRow(2, 'BANNER-LINE-2'));

    const host = makeHost(stdout, {
      committedBand: ['BAND-A row', 'BAND-B row'],
      committedBandTopRow: 8,
      committedBandBottomRow: 9,
      committedBandPaintedRows: 2,
      anchorRow: 3, // floor = 3 → erase starts at row 3, banner at 1..2 untouched
    });

    // desiredTopRow=9 → targetBottom=8; floor=3 → maxFit=6 → fit=2 → newTop=7.
    repositionCommittedBand(host, 9, 0, 23);

    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 100,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines
      .map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`)
      .join('\n');

    expect(lines.some((l) => l.includes('BANNER-LINE-1')), `banner row 1 erased:\n${dump}`).toBe(true);
    expect(lines.some((l) => l.includes('BANNER-LINE-2')), `banner row 2 erased:\n${dump}`).toBe(true);
    expect(lines.some((l) => l.includes('BAND-A row')), `band not rendered:\n${dump}`).toBe(true);
  });

  it('caps blank gap on short terminals (#2182): a thin band on a 20-row terminal leaves at most ceil(20/3)=7 blank rows', async () => {
    // Scenario: 20-row terminal, overlay collapsed, frame shrinks to 3 rows
    // (input + spinner + gap). Geometry from the issue:
    //   targetBottom=16, floor=1, maxFit=16, fit=3, newTop=14 (13 blank rows).
    // Without the cap: 13 blank rows at top, band at rows 14-16.
    // With the cap: MAX_BLANK_ROWS=ceil(20/3)=7, band paints at rows 8-10,
    // rows 11-16 erased (gap erase), only 7 blank rows visible at top.
    const SHORT_ROWS = 20;
    const SHORT_COLS = 80;

    const stdout = makeStdout();
    // Override rows on the stream to simulate a 20-row terminal.
    (stdout as unknown as { rows: number }).rows = SHORT_ROWS;
    const all = collect(stdout);

    const host = makeHost(stdout, {
      committedBand: ['RESULT-A', 'RESULT-B', 'RESULT-C'],
      committedBandTopRow: 0, // force a repaint (moved = true)
      committedBandBottomRow: 0,
      committedBandPaintedRows: 0,
      anchorRow: 1, // floor = 1
    });

    // desiredTopRow=17 → targetBottom=16; floor=1 → maxFit=16 → fit=3 → newTop=14.
    // Without cap: 13 blank rows. With cap: MAX_BLANK_ROWS=7, paintTop=8.
    repositionCommittedBand(host, /* desiredTopRow */ 17, /* preRenderFrameTop */ 0, /* targetBottomRow */ 19);

    const term = new HeadlessTerminal({
      cols: SHORT_COLS,
      rows: SHORT_ROWS,
      scrollback: 100,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines
      .map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`)
      .join('\n');

    // (1) Band content must be rendered somewhere in the viewport.
    expect(lines.some((l) => l.includes('RESULT-A')), `band not rendered:\n${dump}`).toBe(true);
    expect(lines.some((l) => l.includes('RESULT-C')), `band not rendered:\n${dump}`).toBe(true);

    // (2) The blank gap above the band must be ≤ MAX_BLANK_ROWS (= 7).
    const firstBandRow = lines.findIndex((l) => l.includes('RESULT-A'));
    const blankRowsAboveBand = firstBandRow; // 0-based: blank rows from index 0 to firstBandRow-1
    expect(
      blankRowsAboveBand,
      `blank gap (${blankRowsAboveBand} rows) exceeds the MAX_BLANK_ROWS cap:\n${dump}`,
    ).toBeLessThanOrEqual(7);

    // (3) Without the fix the gap would be 13 rows; verify we did better.
    expect(
      blankRowsAboveBand,
      `blank gap (${blankRowsAboveBand} rows) was not reduced below uncapped 13:\n${dump}`,
    ).toBeLessThan(13);

    // (4) Tracking: committedBandTopRow is the capped paintTop (8, 1-indexed);
    //     committedBandBottomRow remains targetBottom (16) so commit-path
    //     contiguity checks (committedBandBottomRow === frameTop − 1) still work.
    //     endTurnFlush uses committedBandTopRow for the erase start so it finds
    //     the real painted rows even when the cap shifted them above newTop.
    expect(host.committedBandTopRow).toBe(8);  // floor(1) + MAX_BLANK_ROWS(7) = 8
    expect(host.committedBandBottomRow).toBe(16); // targetBottom (unchanged)
    expect(host.committedBandPaintedRows).toBe(3);

    // (5) The gap rows between band bottom and frame top must be blank.
    //     Band bottom is at row paintTop+fit-1 = 10 (1-indexed).
    //     targetBottom = 16. Rows 11..16 (0-based 10..15) should be blank.
    for (let i = 10; i <= 15; i++) {
      expect((lines[i] ?? '').trim(), `gap row ${i + 1} not blank:\n${dump}`).toBe('');
    }
  });
});

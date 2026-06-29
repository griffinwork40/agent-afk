/**
 * Regression guard: welcome-banner window (anchorRow > 1) + a final assistant
 * message committed with a MEDIUM overlay (tall enough to make paintedCount <
 * bandLen at commit time, short enough that desiredTopRow > anchorRow so the
 * banner floor stays unreduced) + post-turn repaints with spinner still active
 * must NOT silently drop the oldest pending band rows that don't fit the
 * settled above-banner room.
 *
 * ROOT CAUSE (invariant-violation path):
 *
 *   1. Banner present (anchorRow = 9), MEDIUM overlay (10 rows + chrome):
 *      frame = overlay(10)+spinner(1)+gap(1)+input(1) = 13 rows.
 *      targetBottom = ROWS-1 = 23; desiredTopRow = 23-13+1 = 11.
 *      prevTopRow = 1 (arm fresh, first frame just settled to bottom).
 *   2. commitAbove fires:
 *        - fitsAboveFrame = false (prevTopRow = 1, BLOCKER-1 gate).
 *        - anchorFloor = 9, overflowTargetBottom = ROWS-1 = 23,
 *          maxBandModel = 23 - 9 = 14.
 *        - overflowPriorContiguous = false (anchorRow ≤ 1 guard cuts off under
 *          banner geometry → the merge / overflowHasPending gates are closed).
 *        - useBandHold = !fitsAboveFrame && maxBandModel > 0 = true.
 *        - Phase-1: genuineOverflow = max(0, 15-14) = 1 row (BANNERBLOCK-00)
 *          archived to scrollback via top-write-then-scroll at anchorFloor.
 *        - Phase-2 repaint: desiredTopRow = 11 > anchorRow = 9 → hasBanner
 *          eviction sees anchorDeficit = 0 → anchorRow stays at 9. newTopRow=11.
 *        - Phase-3: postScrollFloor = 9, maxRun = 11-9 = 2, paintedCount = 2.
 *          model[12..13] = {BANNERBLOCK-13, ''} painted at rows 9..10.
 *          committedBandPaintedRows = 2. 12 rows (model[0..11]) are PENDING.
 *          anchorRow = 9 (unchanged). hasBanner = true.
 *   3. Turn ends: overlay clears. First repaint fires (spinner still active).
 *        preserveRowsBeforeFrameRender(desiredTopRow=21):
 *          hasBanner = anchorRow > 1 = TRUE → enters legacy deficit branch.
 *          growthDeficit = max(0, 11-21) = 0; anchorDeficit = max(0, 21<9? ...: 0) = 0.
 *          deficit = 0 → band-update block (lines 181-198) SKIPPED entirely.
 *          (Line 197 committedBandPaintedRows = bandLen is NOT reached here
 *          because it's inside `if (deficit > 0)`. The band stays at
 *          committedBandPaintedRows = 2.)
 *        repositionCommittedBand(21, preRenderFrameTop, 22):
 *          floor = 9, targetBottom = 20, maxFit = 20-9+1 = 12.
 *          fit = min(14, 12) = 12. paint = model[2..13].
 *          Erase: newTop = 20-12+1 = 9; old committedBandTopRow = 9;
 *          loop runs r in [9, 8) → ZERO iterations, old rows NOT erased.
 *          Paints model[2..13] at rows 9..20. model[0]=BANNERBLOCK-01 and
 *          model[1]=BANNERBLOCK-02 are silently dropped — never painted, never
 *          archived. CONTENT LOSS: 2 rows vanish from the terminal.
 *   4. Second repaint (spinner still active): same geometry, same result.
 *      The 2 oldest pending rows remain missing from the buffer.
 *
 * WHY the invariant comment at frame-preserve.ts:195-196 is WRONG:
 *   The comment claims "a fully-pending band has no banner above it and cannot
 *   reach this branch." This is true ONLY for the fully-pending case
 *   (committedBandPaintedRows = 0), which requires newTopRow ≤ 1 — forcing
 *   the hasBanner eviction to reduce anchorRow to ≤ 1 during Phase-2.
 *   A PARTIALLY-pending band (0 < paintedRows < bandLen) coexists with
 *   anchorRow > 1 when the overlay is tall enough that prevTopRow ≤ 1
 *   (BLOCKER-1, so fitsAboveFrame = false and useBandHold fires) but short
 *   enough that desiredTopRow > anchorRow (so the banner survives Phase-2
 *   unreduced). In this window, maxRun = newTopRow - anchorFloor < bandLen,
 *   leaving the oldest (bandLen - maxRun) rows pending under a live banner.
 *   The hasBanner branch reaches lines 181-198 only when deficit > 0; when
 *   deficit = 0 it exits immediately — and when the overlay collapses the
 *   frame GROWS (desiredTopRow increases), making growthDeficit = 0 always.
 *   So the hasBanner branch NEVER runs the pending-overflow eviction that
 *   would save the oldest rows.
 *
 * FIX (terminal-compositor.frame-preserve.ts, hasBanner branch):
 *   Before the legacy deficit eviction, when overlayCollapsed && hasPending &&
 *   bandLen > room (room = desiredTopRow - floor): paint the full model top-
 *   aligned at [floor, floor+bandLen-1], evict the oldest overflow rows to
 *   scrollback, update band tracking. Mirrors the !hasBanner collapse-time
 *   eviction (lines 87-119) with floor = anchorFloor instead of 1.
 *
 * GEOMETRY: ROWS=24, anchorRow=9 (8-row banner), no status line.
 *   overflowTargetBottom = 23; maxBandModel = 14.
 *   Overlay = 10 lines (medium); spinner on → frame = 13 rows, desiredTopRow=11.
 *   Block = 14 content lines (+ 1 separator = 15 total) → genuineOverflow=1
 *   archived in Phase-1; band holds 14 rows; paintedCount=2 (12 pending).
 *   End-of-turn collapse: setOverlay(''), 2 repaints with spinner still on
 *   (3-row frame each time, desiredTopRow=21, maxFit=12 < 14 → 2 rows dropped).
 *
 * This test FAILS on pre-fix code (BANNERBLOCK-01 and BANNERBLOCK-02 missing)
 * and PASSES after the hasBanner pending-overflow eviction is added to
 * frame-preserve.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
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
  s.setRawMode = vi.fn((r: boolean) => {
    s.isRaw = r;
    return s;
  });
  return s;
}
function collect(stream: MockStdout): () => string {
  const c: string[] = [];
  stream.on('data', (x) => c.push(String(x)));
  return () => c.join('');
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active;
  const o: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (l) o.push(l.translateToString(true));
  }
  return o;
}

const COLS = 80;
const ROWS = 24;
// Banner occupies terminal rows 1..BANNER_ROWS; compositor anchors at BANNER_ROWS+1.
const BANNER_ROWS = 8;
const ANCHOR_ROW = BANNER_ROWS + 1; // = 9
//
// Geometry derivation (no status line, extraRows = 0):
//   overflowTargetBottom = ROWS-1 = 23; maxBandModel = 23-9 = 14.
//   Overlay = OVERLAY_LINES lines + spinner(1) + gap(1) + input(1)
//           = OVERLAY_LINES + 3 rows of frame.
//   desiredTopRow = (ROWS-1) - (OVERLAY_LINES+3) + 1 = 21 - OVERLAY_LINES.
//   Need desiredTopRow > ANCHOR_ROW = 9 → OVERLAY_LINES < 12.
//   With OVERLAY_LINES = 10: desiredTopRow = 11 > 9. anchorRow stays 9. ✓
//   maxRun = newTopRow - anchorFloor = 11 - 9 = 2 → paintedCount = 2.
//
//   At collapse (spinner still on → 3-row frame, desiredTopRow = 21):
//     floor = 9, targetBottom = 20, maxFit = 12 < 14 = bandLen → 2 rows dropped.
const OVERLAY_LINES = 10;
const OVERFLOW_TARGET_BOTTOM = ROWS - 1; // = 23
const MAX_BAND_MODEL = OVERFLOW_TARGET_BOTTOM - ANCHOR_ROW; // = 14
// Block: MAX_BAND_MODEL content rows + 1 separator = 15 total rows in overflowRun.
// genuineOverflow = 15 - 14 = 1 → BANNERBLOCK-00 archived to scrollback in Phase-1.
// model = overflowRun[1..14] = BANNERBLOCK-01..BANNERBLOCK-13 + ''.
// paintedCount = 2 → model[12..13] = {BANNERBLOCK-13, ''} painted at rows 9..10.
// model[0..11] = BANNERBLOCK-01..BANNERBLOCK-12 are PENDING (12 rows).
// At first spinner-on repaint: fit=12, paints model[2..13] → model[0..1] DROPPED.
const BLOCK_LINES = MAX_BAND_MODEL; // = 14 content lines

describe('banner end-of-turn overflow-gap regression: partially-pending band under anchorRow > 1', () => {
  it('preserves ALL committed lines when a medium overlay leaves a partially-pending band under a banner', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);

    // Print the banner BEFORE arming — exactly like the interactive REPL surface.
    // External constraint (anchor ceiling): rows 1..BANNER_ROWS are protected
    // pre-arm content; anchorRow = BANNER_ROWS+1 is the first paintable row.
    for (let i = 0; i < BANNER_ROWS; i++) {
      stdout.write(`BANNER_LINE_${i}\n`);
    }

    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      anchorRow: ANCHOR_ROW,
    });
    await c.arm();

    // Spinner on: contributes 1 row + the gap row to the frame (total chrome
    // = spinner+gap+input = 3). At collapse, spinner-on frame = 3 rows,
    // desiredTopRow = 21, maxFit = 12 < 14 = bandLen → 2 rows dropped.
    c.setSpinner({ enabled: true });

    // Medium overlay: desiredTopRow = ROWS-1 - (OVERLAY+spinner+gap+input) + 1
    //   = 23 - (10+1+1+1) + 1 = 11 > anchorRow = 9 → anchorRow stays 9. ✓
    const mediumOverlay = Array.from(
      { length: OVERLAY_LINES },
      (_, i) => `streaming preview row ${i}`,
    ).join('\n');
    c.setOverlay(mediumOverlay);

    // Block: BLOCK_LINES labelled content rows + separator.
    // Phase-1 archives 1 row (genuineOverflow = 1, the separator-inclusive
    // overflowRun has 15 rows, maxBandModel = 14 → 1 archived).
    // Phase-3 paints only the bottom 2 rows of the 14-row model (paintedCount=2).
    // The 12 oldest rows (model[0..11]) are PENDING.
    const blockContent = Array.from(
      { length: BLOCK_LINES },
      (_, i) => `BANNERBLOCK-${String(i).padStart(2, '0')} content line here`,
    ).join('\n');

    // Commit while the medium overlay is up (prevTopRow = 1 on first-arm render).
    c.commitAbove(blockContent + '\n\n');

    // --- End-of-turn collapse sequence (spinner remains active for both repaints,
    // as happens when a background loopStageBar fires after the overlay clears but
    // before the spinner has stopped). ---
    // External constraint (turn-end ordering): overlay clears before repaints.
    c.setOverlay('');
    // Both repaints with spinner on → 3-row frame → desiredTopRow=21, maxFit=12.
    // Pre-fix: first repaint's repositionCommittedBand drops model[0..1] (2 oldest
    // pending rows); second repaint repeats the same drop. Result: BANNERBLOCK-01
    // and BANNERBLOCK-02 vanish from both scrollback and viewport.
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    // Feed into xterm headless to observe the real terminal state.
    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 600,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());

    const lines = allLines(term);
    const dump = lines
      .map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`)
      .join('\n');

    // The frame (input row with the ⎯ rule glyph U+23AF) must be present.
    const FRAME_RE = /\u23af/;
    const frameAbsIdx = lines.findIndex((l) => FRAME_RE.test(l));
    expect(
      frameAbsIdx,
      `frame (input rule U+23AF) not found in buffer:\n${dump}`,
    ).toBeGreaterThanOrEqual(0);

    // CORE ASSERTION: every BANNERBLOCK-NN row must appear EXACTLY ONCE across
    // the full buffer (scrollback + viewport). Pre-fix: BANNERBLOCK-01 and
    // BANNERBLOCK-02 (model[0..1], 2 oldest pending rows) are silently dropped
    // when repositionCommittedBand's fit=12 < bandLen=14 without first evicting
    // the overflow to scrollback (as the !hasBanner path does).
    for (let i = 0; i < BLOCK_LINES; i++) {
      const label = `BANNERBLOCK-${String(i).padStart(2, '0')}`;
      const hits = lines.filter((l) => l.includes(label)).length;
      expect(
        hits,
        `"${label}" must appear exactly once across the full buffer (found ${hits}):\n${dump}`,
      ).toBe(1);
    }

    // SECONDARY ASSERTION: no run of ≥ 3 consecutive blank rows between the
    // first BANNERBLOCK content and the frame (one blank is the rhythm separator;
    // two should not appear in a run of only 14 lines).
    const firstContentAbs = lines.findIndex((l) => l.includes('BANNERBLOCK-'));
    if (firstContentAbs >= 0 && frameAbsIdx > firstContentAbs) {
      let maxBlankRun = 0;
      let cur = 0;
      for (let i = firstContentAbs; i < frameAbsIdx; i++) {
        if ((lines[i] ?? '').trim() === '') {
          cur++;
          maxBlankRun = Math.max(maxBlankRun, cur);
        } else {
          cur = 0;
        }
      }
      expect(
        maxBlankRun,
        `blank run of ${maxBlankRun} rows between first BANNERBLOCK content and frame:\n${dump}`,
      ).toBeLessThanOrEqual(2);
    }

    term.dispose();
    c.disarm();
  }, 15_000);
});

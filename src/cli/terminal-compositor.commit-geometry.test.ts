/**
 * Regression: stale `prevTopRow` (from shrink-padded `logUpdate.topRow`) causes
 * `decideCommitMode` to compute wrong geometry, routing a commit to `useBandHold`
 * when the block fits the real above-frame room — permanently losing prior committed
 * content that was repositioned by `repositionCommittedBand`.
 *
 * ROOT CAUSE (see docs/scrollback.md §407-424):
 *   `commitAbove` captures `prevTopRow = self.logUpdate.topRow` BEFORE Phase-2
 *   `repaint()`.  When `CupFrameRenderer.render()` applies shrink-padding (frame
 *   shrank since the previous render), `logUpdate.topRow` equals the PADDED top row
 *   — lower than the real, unpadded frame top that Phase-2's repaint will establish.
 *   `measure(currentFrame, absoluteBottom).topRow` returns the unpadded top.
 *
 *   Concretely (ROWS=24, extraRows=2, absoluteBottom=21, anchorFloor=1, COLS=120,
 *   spinner ON, **no tip**, anchorRow=1):
 *
 *   1. Tall overlay (14 lines) → frame 17 rows → last render places `topRow` = 5.
 *
 *   2. `commitAbove("GEO_PROSE\n\n")` — 1-row block, `fitsAboveFrame` TRUE (1 ≤ 4).
 *      Phase-3 CUP-paints at rows 3..4.
 *      `committedBand = ["GEO_PROSE", ""]`, `committedBandBottomRow` = 4.
 *
 *   3. Overlay SHRINKS to 4 lines → `repaint()` applies shrink-padding:
 *      `previousRawLineCount`=17, new raw=7, `shrinkPad`=10, `newTopRow`=5 — same!
 *      `logUpdate.topRow` = **5** (STALE).
 *      `measure(4-line overlay frame, 21).topRow` = **15** (REAL).
 *      `repositionCommittedBand` runs: repins band from rows 3..4 → rows 13..14
 *      (adjacent to the real frame top at 15).  `committedBandBottomRow` = 14.
 *
 *   4. `commitAbove("GEO_TABLE ...\n\n")` — 5-row block, **with stale prevTopRow**:
 *      `fitsAboveFrame` = 5 > 1 && 5 ≤ stale_room=4 → **FALSE** (WRONG).
 *      With `measure` topRow=15: 5 ≤ real_room=14 → **TRUE** (correct routing).
 *      The wrong FALSE fires `useBandHold = TRUE`.
 *
 *      Band-hold picks `overflowPriorContiguous`: `committedBandBottomRow`(14)
 *      === stale `frameTop`-1=4 → **FALSE** (stale frame top 5 doesn't match band at 14).
 *      So `overflowRun` = just the new 5-row block — NO merge with prior prose.
 *
 *      Band-hold Phase-3: paints rows 9..14 with the NEW block only.
 *      The prior prose that `repositionCommittedBand` placed at rows 13..14 is
 *      **overwritten** by rows 13..14 of the new band-hold paint.
 *      The prose is NOT in the new band model AND was not scrolled to scrollback
 *      (band-hold emits 0 LFs) → it is **permanently lost**.
 *
 *   With CORRECT `prevTopRow` = 15 (from `measure`):
 *      `fitsAboveFrame` = TRUE → fits path, Phase-3 merges the prior prose via
 *      `contiguousPriorBand` (arm 1: `committedBandBottomRow`(14) === `newTopRow`(15)-1=14
 *      → TRUE). `run` = [prose, sep, table_rows, sep] = 8 rows; band = rows 7..14.
 *      Prose survives in the band model and viewport.
 *
 * RED assertion: after collapse, the prior-committed prose ("GEO_PROSE") MUST appear
 * ONCE in the buffer.  Pre-fix it DISAPPEARS (0 hits) because the stale routing
 * caused band-hold to overwrite it without archiving it to scrollback.
 *
 * The defect also matches the "blank void / orphan divider" screenshot symptom:
 * the void above the table is NOT an empty area — it's where prose used to be
 * before band-hold's incorrect paint silently erased it.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows; return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true; s.isRaw = false;
  s.setRawMode = vi.fn((r: boolean) => { s.isRaw = r; return s; });
  return s;
}
function collect(stream: MockStdout): () => string {
  const chunks: string[] = [];
  stream.on('data', (x) => chunks.push(String(x)));
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
    if (l) out.push(l.translateToString(true));
  }
  return out;
}

const COLS = 120, ROWS = 24;

describe('commitAbove: stale prevTopRow from shrink-padded render loses repositioned committed content', () => {
  it('prior committed prose survives after overlay-shrink then subsequent commit', async () => {
    // External constraint (pre-repaint vs post-repaint geometry ordering):
    // decideCommitMode must use the TRUE frame top that Phase-2 repaint() will
    // establish, not the stale shrink-padded top from the previous render cycle.
    // Using the stale top causes useBandHold=TRUE when fits was correct, which
    // overwrites content that repositionCommittedBand correctly placed adjacent to
    // the real frame — permanently losing it from both viewport and scrollback.
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);

    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });

    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1,
    });
    await c.arm();

    // extraRows=2: absoluteBottom = ROWS-1-2 = 21.
    statusLine.setExtraRows(2);
    // Spinner ON adds 1 row to frame; tip OFF (no tip set).
    c.setSpinner({ enabled: true });

    // Step 1 + 2: tall overlay (14 lines) → frame 17 rows → topRow=5.
    // commitAbove(prose) fits (1 row ≤ stale_room=4 AND real_room=4 — no divergence yet).
    // Phase-3: committedBand=["GEO_PROSE",""], committedBandBottomRow=4.
    const tallOverlay = Array.from(
      { length: 14 },
      (_, i) => `thinking ${i} — subagent dispatched, analysing claim ${i}`,
    ).join('\n');
    c.setOverlay(tallOverlay);
    c.commitAbove('GEO_PROSE committed block — should survive the shrink\n\n');

    const internals = c as unknown as {
      repaint(): void;
      logUpdate: { topRow?: number };
      committedBand: string[];
      committedBandTopRow: number;
      committedBandBottomRow: number;
      committedBandPaintedRows: number;
    };

    // Verify precondition: prose is in the band, adjacent to the tall frame at row 5.
    expect(internals.committedBandBottomRow, 'prose must be adjacent to tall frame (row 4)').toBe(4);
    expect(internals.logUpdate?.topRow, 'tall frame topRow must be 5').toBe(5);

    // Step 3: SHRINK overlay (4 lines) → repaint() → shrink-pad.
    // previousRawLineCount=17 → new raw=7 → shrinkPad=10 → newTopRow=5 (STALE!).
    // logUpdate.topRow remains 5.  Real: measure(7-line frame, 21).topRow = 15.
    // repositionCommittedBand runs: moves band from rows 3..4 → rows 13..14
    // (adjacent to real frame top at 15). committedBandBottomRow = 14.
    const smallOverlay = Array.from(
      { length: 4 },
      (_, i) => `overlay shrunk ${i}`,
    ).join('\n');
    c.setOverlay(smallOverlay);

    // Verify the shrink-pad divergence: topRow is still 5 (stale) even though the
    // real frame is now at row 15. repositionCommittedBand moved the band to 13..14.
    expect(internals.logUpdate?.topRow, 'topRow must be stale (5) due to shrink-padding').toBe(5);
    expect(internals.committedBandBottomRow, 'band must be repositioned to row 14 (adjacent to real frame)').toBe(14);

    // Step 4: commitAbove(5-row block). This is the defect trigger:
    // stale prevTopRow=5 → fitsAboveFrame = 5>1 && 5<=stale_room=4 → FALSE.
    // real topRow=15 → fitsAboveFrame = 5>1 && 5<=real_room=14 → TRUE.
    // With stale: useBandHold=TRUE; overflowRun=new_block_only (no merge because
    //   overflowPriorContiguous: committedBandBottomRow(14) === stale(5)-1=4 → FALSE);
    //   band-hold Phase-3 paints rows 9..14 with the new block — OVERWRITING the
    //   repositioned prose at rows 13..14 without archiving it to scrollback.
    // With real: fitsAboveFrame=TRUE → fits path; Phase-3 merges prose (contiguous)
    //   into the combined 8-row run and paints rows 7..14; prose survives.
    c.commitAbove(
      'GEO_TABLE_ROW_1 | data | col\n' +
      'GEO_TABLE_ROW_2 | data | col\n' +
      'GEO_TABLE_ROW_3 | data | col\n' +
      'GEO_TABLE_ROW_4 | data | col\n' +
      'GEO_TABLE_ROW_5 | data | col\n\n',
    );

    // Collapse the overlay.
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    // Feed all bytes into an xterm/headless terminal.
    const term = new HeadlessTerminal({
      cols: COLS, rows: ROWS, scrollback: 400,
      allowProposedApi: true, convertEol: true,
    });
    await termWrite(term, all());

    const lines = allLines(term);
    const dump = lines
      .map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`)
      .join('\n');

    // (1) PROSE MUST SURVIVE: GEO_PROSE was committed first and must appear
    //     EXACTLY ONCE after collapse. Pre-fix: it appears 0 times — the stale
    //     routing caused band-hold to overwrite it without scrollback archival.
    const prosHits = lines.filter((l) => l.includes('GEO_PROSE')).length;
    expect(
      prosHits,
      `GEO_PROSE committed first must survive — stale prevTopRow causes band-hold to overwrite it (found ${prosHits}):\n${dump}`,
    ).toBe(1);

    // (2) TABLE ROWS MUST ALSO BE PRESENT exactly once each.
    for (const marker of ['GEO_TABLE_ROW_1', 'GEO_TABLE_ROW_2', 'GEO_TABLE_ROW_3', 'GEO_TABLE_ROW_4', 'GEO_TABLE_ROW_5']) {
      const hits = lines.filter((l) => l.includes(marker)).length;
      expect(hits, `"${marker}" must appear exactly once:\n${dump}`).toBe(1);
    }

    // (3) BOTH VISIBLE IN VIEWPORT (not stranded in scrollback).
    const baseY = term.buffer.active.baseY;
    const viewport = lines.slice(baseY);
    const SPINNER_RE = /[\u2800-\u28ff]/;
    const frameIdx = viewport.findIndex((l) => SPINNER_RE.test(l));
    expect(frameIdx, `spinner/frame not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

    const aboveFrame = viewport.slice(0, frameIdx);
    const proseInView = aboveFrame.filter((l) => l.includes('GEO_PROSE')).length;
    expect(proseInView, `GEO_PROSE must be visible in the viewport above the frame:\n${dump}`).toBe(1);
    const tableInView = aboveFrame.filter((l) => l.includes('GEO_TABLE_ROW_1')).length;
    expect(tableInView, `GEO_TABLE_ROW_1 must be visible in the viewport above the frame:\n${dump}`).toBe(1);

    // (4) COMMIT ORDER: prose above table.
    const proseRow = aboveFrame.findIndex((l) => l.includes('GEO_PROSE'));
    const tableRow = aboveFrame.findIndex((l) => l.includes('GEO_TABLE_ROW_1'));
    expect(proseRow, `GEO_PROSE visible:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(tableRow, `GEO_TABLE_ROW_1 visible:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(proseRow < tableRow, `prose must appear above table rows (commit order):\n${dump}`).toBe(true);

    // (5) NO BLANK VOID between first content row and frame (at most 1 = rhythm separator).
    const firstContent = aboveFrame.findIndex((l) => l.trim() !== '');
    let maxBlankRun = 0, cur = 0;
    for (let i = Math.max(0, firstContent); i < frameIdx; i++) {
      if ((aboveFrame[i] ?? '').trim() === '') {
        cur++;
        maxBlankRun = Math.max(maxBlankRun, cur);
      } else {
        cur = 0;
      }
    }
    expect(
      maxBlankRun,
      `blank void of ${maxBlankRun} rows between content rows (stale prevTopRow left a gap):\n${dump}`,
    ).toBeLessThanOrEqual(1);

    term.dispose();
    statusLine.stop();
    c.disarm();
  }, 15_000);
});

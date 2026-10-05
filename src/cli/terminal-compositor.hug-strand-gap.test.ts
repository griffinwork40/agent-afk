/**
 * Issue #2229 — content-hug strand-gap regression:
 * when the content-hug frame has bottom-pinned (hugSlack == 0) and a tall
 * overlay is subsequently shown while commits land, those commits must be
 * routed through band-hold (same as bottom-pin mode) so no blank rows appear
 * at the top of the viewport on overlay collapse and every committed row is
 * present exactly once across scrollback + viewport.
 *
 * Hypothesis under test (commit-mode.ts overlayTallEnoughToStrand):
 *   OLD (27342ddb): `!contentHug && fitsAboveFrame && room < maxBandModel`
 *   → always false in content-hug mode → tall-overlay commits use the fits
 *     path → eager LF scrolls freeze band rows in scrollback → void on collapse.
 *   NEW: `!hugSlack && anchorRow <= 1 && fitsAboveFrame && room < maxBandModel`
 *   → applies when hugSlack == 0 and no pre-arm banner (anchorRow == 1) →
 *     routes to band-hold → no void.
 *
 * Two tests in this file:
 *   (A) Premise: while hugSlack > 0 (hug frame has slack, viewport not yet full)
 *       commits do NOT push any band rows into native scrollback — verified by
 *       checking that the terminal scrollback is empty (baseY == 0) while the
 *       banner is still visible.
 *   (B) Strand-gap regression: after hugSlack == 0, a tall overlay is shown
 *       across several commits, the overlay collapses — no blank rows at the
 *       top of the viewport and every committed row appears exactly once.
 *       Must FAIL with the `!contentHug` global skip and PASS with the
 *       `!hugSlack && anchorRow <= 1` condition.
 *
 * Geometry (24 rows, no banner: anchorRow=1, extraRows=0):
 *   absoluteBottom = 23, maxBandModel = 22.
 *   Viewport-fill phase: ~22 one-line commits (each 2 band rows) reduce
 *   hugSlack to 0 — the frame bottom-pins at row 23.
 *   Strand phase: a 12-row overlay makes frameTop = 23 - 12 - 1 + 1 = 11,
 *   room = 11 - 1 = 10 < maxBandModel = 22. The fits path would freeze band
 *   rows at 10-row capacity; on collapse room expands to 22 and 12 rows of
 *   viewport are blank above the band. Band-hold prevents this.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 80;
const ROWS = 24;

function makeStdout(): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = ROWS;
  return s;
}

function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

function collect(stdout: MockStdout): () => string {
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));
  return () => chunks.join('');
}

async function termWrite(t: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((r) => t.write(data, r));
}

function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
  }
  return out;
}

// Contract: A content-hug compositor with anchorRow=1 (no banner) fills the
// viewport by committing one-line blocks until the frame bottom-pins, then
// shows a tall overlay, commits several more blocks under it, collapses the
// overlay, and asserts the invariants below.
//
// The coordinator's premise: while hugSlack > 0 (hug frame has slack, viewport
// not yet full), fits-path LFs scroll only ALREADY-PAINTED band rows into
// scrollback — never blank rows — so the void on collapse cannot form. Once
// hugSlack == 0 the same tall-overlay stranding scenario that affects
// bottom-pin mode can occur, and the overlayTallEnoughToStrand check must
// apply (gated on anchorRow <= 1 so band-hold's overflowPriorContiguous merge
// works correctly).

describe('hug-strand-gap: content-hug strand-gap protection (anchorRow=1, no banner)', () => {
  // Contract (premise — (A)): while hugSlack > 0 the scrollback remains empty
  // because fits-path LFs carry only already-painted band rows, never blanks.
  it('(A) premise: hugSlack > 0 — commits do not push blank rows into scrollback', async () => {
    const stdout = makeStdout();
    const all = collect(stdout);
    const c = new TerminalCompositor({
      stdout,
      stdin: makeStdin(),
      onCancel: vi.fn(),
      anchorRow: 1,
      contentHug: true,
    });
    await c.arm();
    c.setSpinner({ enabled: true });

    // Commit a few blocks while the hug frame still has slack (viewport not
    // yet full). With ROWS=24 and anchorRow=1, hugSlack > 0 after the first
    // few single-line commits. We commit only 3 blocks — well within the
    // slack — to keep the frame far from the floor.
    for (let i = 0; i < 3; i++) {
      c.commitAbove(`PREMISE-${String(i).padStart(2, '0')}\n`);
      const r = c as unknown as { repaint(): void };
      r.repaint();
    }
    c.setSpinner({ enabled: false });
    (c as unknown as { repaint(): void }).repaint();

    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 2000,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

    // Contract (premise): no scrollback rows while hugSlack > 0. baseY === 0
    // means the terminal has not scrolled any rows into scrollback.
    expect(
      term.buffer.active.baseY,
      `Premise violation: scrollback must be empty (baseY=0) while hugSlack > 0, but baseY=${term.buffer.active.baseY}:\n${dump}`,
    ).toBe(0);

    // All 3 committed rows must be visible in the viewport.
    for (let i = 0; i < 3; i++) {
      const label = `PREMISE-${String(i).padStart(2, '0')}`;
      expect(
        lines.filter((l) => l.includes(label)).length,
        `"${label}" must appear exactly once:\n${dump}`,
      ).toBe(1);
    }

    term.dispose();
    c.disarm();
  }, 15_000);

  // Contract (strand-gap regression — (B)): after hugSlack reaches 0 (frame
  // bottom-pinned), a tall overlay shown while commits land must NOT freeze band
  // rows in scrollback at narrow-room capacity, leaving blank rows at the top of
  // the viewport on collapse. Every committed row must appear exactly once.
  //
  // Prove failure mode: temporarily restoring `!contentHug` (global skip) would
  // make the fits path freeze rows at room=10 capacity during the 12-row overlay,
  // leaving 12 blank rows at the top of the viewport on collapse. The new
  // `!hugSlack && anchorRow <= 1` condition routes to band-hold instead.
  // NOTE: (B) is an end-to-end content-integrity check for the bottom-pinned
  // content-hug phase. It is NOT sensitive to the strand check itself: it was
  // verified to pass with overlayTallEnoughToStrand forced to false. On main
  // the tall-overlay gap fix has only unit-level coverage (commit-mode.test.ts
  // "tall-overlay gap fix ..."), and the content-hug routing is pinned the
  // same way ("hug-strand: ..." in commit-mode.test.ts).
  it('(B) hugSlack==0 + tall overlay — no blank rows at viewport top, every row exactly once (end-to-end sanity)', async () => {
    const stdout = makeStdout();
    const all = collect(stdout);
    const c = new TerminalCompositor({
      stdout,
      stdin: makeStdin(),
      onCancel: vi.fn(),
      anchorRow: 1,
      contentHug: true,
    });
    await c.arm();
    c.setSpinner({ enabled: true });
    const internals = c as unknown as { repaint(): void; committedBand: string[] };

    // Phase 1: fill the viewport. Commit enough one-line blocks that hugSlack
    // reaches 0 (frame bottom-pins). With ROWS=24, anchorRow=1, spinner=2 rows
    // (absoluteBottom=23, maxBandModel=22), hugSlack becomes 0 after ~20
    // single-line commits (each 2 band rows × 11 = 22 rows model). We commit
    // ROWS-3 = 21 blocks to ensure bottom-pinning.
    const fillCount = ROWS - 3;
    const fillRows: string[] = [];
    for (let i = 0; i < fillCount; i++) {
      const label = `FILL-${String(i).padStart(4, '0')}`;
      fillRows.push(label);
      c.commitAbove(`${label}\n`);
      internals.repaint();
    }

    // Phase 2: show a tall overlay and commit under it (the strand scenario).
    // 12-row overlay + spinner (1 line) + input (1 line) = 14-row frame.
    // frameTop = 24 - 14 = 10, room = 10 - 1 = 9. maxBandModel = 22.
    // room < maxBandModel → overlayTallEnoughToStrand with the new condition.
    const tallOverlay = Array.from(
      { length: 12 },
      (_, i) => `overlay-row-${String(i).padStart(2, '0')} — held across commits`,
    ).join('\n');
    const strandRows: string[] = [];
    for (let k = 0; k < 4; k++) {
      const label = `STRAND-${String(k).padStart(2, '0')}`;
      strandRows.push(label);
      c.setOverlay(tallOverlay);
      c.commitAbove(`${label}\n`);
      internals.repaint();
    }

    // Phase 3: overlay collapses (turn ends).
    c.setOverlay('');
    c.setSpinner({ enabled: false });
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 2000,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

    const FRAME_RE = /\u23af/;
    const baseY = term.buffer.active.baseY;
    const view = lines.slice(baseY);
    const frameIdx = view.findIndex((l) => FRAME_RE.test(l));
    expect(frameIdx, `frame (input rule) not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

    // (1) NO BLANK VOID at top of viewport: the strand void appears as many
    //     blank rows at the TOP of the above-frame region (the content
    //     bottom-aligns against the frame while the band is short). Pre-fix
    //     (global !contentHug skip) the fits path froze band rows at room=9
    //     capacity; on collapse with room=21, the band (8 rows) bottom-aligns
    //     at rows 15-22, leaving rows 1-14 blank. Assert that the blank run
    //     at the top of the viewport (before the first content row) is ≤ 1.
    const firstContent = view.findIndex((l) => l.trim() !== '');
    const lastContent = (() => {
      for (let i = frameIdx - 1; i >= 0; i--) {
        if ((view[i] ?? '').trim() !== '') return i;
      }
      return -1;
    })();
    // Blank rows ABOVE the committed content (the strand void).
    // firstContent is the 0-indexed viewport row of the first content row.
    // In the stranding case this is far from 0 (many blank rows above).
    // With band-hold, the full band is visible so firstContent ≈ 0.
    expect(
      firstContent,
      `strand void: ${firstContent} blank rows at top of viewport above committed content (expected ≤1; frameIdx=${frameIdx} lastContent=${lastContent}):\n${dump}`,
    ).toBeLessThanOrEqual(1);
    // Also assert no large internal blank runs (belt-and-suspenders).
    let maxBlankRun = 0;
    let cur = 0;
    for (let i = Math.max(0, firstContent); i <= lastContent; i++) {
      if ((view[i] ?? '').trim() === '') {
        cur++;
        maxBlankRun = Math.max(maxBlankRun, cur);
      } else {
        cur = 0;
      }
    }
    expect(
      maxBlankRun,
      `blank gap of ${maxBlankRun} rows within committed content:\n${dump}`,
    ).toBeLessThanOrEqual(1);

    // (2) EVERY COMMITTED ROW APPEARS EXACTLY ONCE across scrollback + viewport.
    //     The most recent strand rows must also be visible above the frame.
    for (const label of strandRows) {
      const hits = lines.filter((l) => l.includes(label)).length;
      expect(
        hits,
        `"${label}" must appear exactly once across the full buffer (found ${hits}):\n${dump}`,
      ).toBe(1);
    }

    // (3) NEWEST STRAND ROWS VISIBLE IN VIEWPORT above the frame.
    const wantInView = [strandRows[strandRows.length - 1]!, strandRows[strandRows.length - 2]!].filter(
      (x): x is string => x !== undefined,
    );
    for (const label of wantInView) {
      const inView = view.slice(0, frameIdx).filter((l) => l.includes(label)).length;
      expect(
        inView,
        `"${label}" must appear exactly once in the viewport above the frame:\n${dump}`,
      ).toBe(1);
    }

    // (4) COMMITTED RUN HUGS THE FRAME: the most recent committed row sits
    //     immediately above the frame with at most one rhythm-separator blank.
    expect(
      frameIdx - lastContent,
      `committed run does not hug the frame (lastContent=${lastContent} frame=${frameIdx}):\n${dump}`,
    ).toBeLessThanOrEqual(2);

    term.dispose();
    c.disarm();
  }, 15_000);
});

/**
 * Regression (PR #649 follow-up, H1): a multi-line block committed via
 * commitAbove() while the live overlay FILLS the viewport (prevTopRow == 1)
 * must be HELD in the band model and painted when the overlay collapses — NOT
 * dropped down the legacy overflow path.
 *
 * Pre-fix: with prevTopRow == 1 the `useBandHold` gate (`prevTopRow > 1 && …`)
 * and Phase 3's `if (newTopRow > 1)` guard both fail, so Phase 3 falls to
 * `clearCommittedBand()` and the block is lost from screen AND scrollback. This
 * is exactly the "lost table" the user saw when a /review streamed a table
 * under a tall subagent-tree overlay (BLOCKER-1 comment at terminal-compositor.ts
 * ~1040 documents the drop and notes "No existing test hits prevTopRow <= 1").
 *
 * The fix decouples band-hold routing from prevTopRow and adds a Phase 3
 * newTopRow<=1 storage branch that holds the model "fully pending" with
 * committedBandBottomRow = collapsedFrameTop - 1 (so consecutive full-overlay
 * commits MERGE rather than replace).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import xterm from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HeadlessTerminal = (xterm as any).Terminal;

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows; return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true; s.isRaw = false; s.setRawMode = vi.fn((r: boolean) => { s.isRaw = r; return s; }); return s;
}
function collect(stream: MockStdout): () => string {
  const c: string[] = [];
  stream.on('data', (x) => c.push(String(x)));
  return () => c.join('');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function termWrite(t: any, d: string): Promise<void> {
  return new Promise((r) => t.write(d, () => r()));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allLines(t: any): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}

const COLS = 120, ROWS = 24;

describe('commitAbove H1: multi-line block committed at prevTopRow==1 (full-viewport overlay)', () => {
  it('holds a multi-line block in the band model and paints it on collapse (not dropped)', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });

    // A 22-line overlay + spinner + gap + input OVERFLOWS the 24-row viewport,
    // pinning the frame top to row 1 → prevTopRow == 1 at commit time.
    const tallOverlay = Array.from({ length: 22 }, (_, i) => `thinking ${i} — held overlay row keeping the frame at full height`).join('\n');

    // A multi-line "table" block (no internal blank line) with unique body
    // markers, committed as ONE block while the overlay fills the viewport.
    const tableRows = [
      'TBL_HEADER unique marker row',
      'TBL_ROW_A first body row',
      'TBL_ROW_B second body row',
      'TBL_ROW_C third body row',
    ];
    c.setOverlay(tallOverlay);
    c.commitAbove(`${tableRows.join('\n')}\n\n`);

    // Precondition (proves we exercised the prevTopRow<=1 / newTopRow<=1 storage
    // branch): the band is non-empty and its bottom sits at collapsedFrameTop-1
    // (= rows-1-extraRows-1 = 20), the sentinel the H1 branch sets — NOT the
    // newTopRow-1 a normal (newTopRow>1) commit would set.
    const internals = c as unknown as { repaint(): void; committedBand: string[]; committedBandBottomRow: number };
    expect(internals.committedBand.length, 'band model must hold the committed block (not cleared)').toBeGreaterThan(0);
    expect(internals.committedBandBottomRow, 'must have taken the H1 newTopRow<=1 storage branch (collapsedFrameTop-1=20)').toBe(20);

    // Overlay collapses (turn ends → spinner stops, overlay clears).
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    // Every committed row must be present EXACTLY ONCE across the whole buffer
    // (it lives in the painted band after collapse). Pre-fix all rows vanished.
    for (const row of tableRows) {
      const marker = row.split(' ')[0]!; // TBL_HEADER / TBL_ROW_A / …
      const hits = lines.filter((l) => l.includes(marker)).length;
      expect(hits, `committed row "${marker}" must be present exactly once after collapse (found ${hits}):\n${dump}`).toBe(1);
    }

    // The body must be visible in the viewport (not stranded in scrollback).
    const baseY = term.buffer.active.baseY;
    const view = lines.slice(baseY);
    for (const marker of ['TBL_HEADER', 'TBL_ROW_A', 'TBL_ROW_B', 'TBL_ROW_C']) {
      const inView = view.filter((l) => l.includes(marker)).length;
      expect(inView, `"${marker}" must be visible in the viewport after collapse:\n${dump}`).toBe(1);
    }

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);

  it('accumulates MULTIPLE blocks committed under a sustained full-viewport overlay (no drops)', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });

    const tallOverlay = Array.from({ length: 22 }, (_, i) => `thinking ${i} — sustained tall overlay row`).join('\n');
    const internals = c as unknown as { repaint(): void; committedBand: string[] };

    // Stream several small blocks while the overlay stays full (prevTopRow==1).
    // Total rows committed (5) stay within maxBandModel so none should archive
    // to scrollback — all must accumulate in the band and survive collapse.
    const markers = ['ACC_ONE', 'ACC_TWO', 'ACC_THREE', 'ACC_FOUR', 'ACC_FIVE'];
    for (const m of markers) {
      c.setOverlay(tallOverlay);
      c.commitAbove(`${m} streamed block under full overlay\n\n`);
    }

    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    // No committed block may be DROPPED: each marker present at least once
    // somewhere in the buffer (painted band and/or scrollback), never zero.
    for (const m of markers) {
      const hits = lines.filter((l) => l.includes(m)).length;
      expect(hits, `streamed block "${m}" must not be lost (found ${hits}):\n${dump}`).toBeGreaterThanOrEqual(1);
      expect(hits, `streamed block "${m}" must not be duplicated (found ${hits})`).toBeLessThanOrEqual(1);
    }

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);

  it('survives a PARTIAL overlay shrink between commits (pending band at prevTopRow==1 → smaller overlay → next commit)', async () => {
    // The residual transition: block A is stored FULLY PENDING at prevTopRow==1
    // (committedBandBottomRow set to the collapsed frame top - 1). Then the
    // overlay PARTIALLY shrinks (not a full collapse) so the frame top drops to
    // a mid-screen row, and block B commits there. repositionCommittedBand must
    // re-pin A's pending model above the new frame top on the shrink so that
    // (a) A becomes visible and (b) B then merges contiguously with it — neither
    // block dropped or duplicated.
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });
    const internals = c as unknown as { repaint(): void; committedBand: string[]; committedBandBottomRow: number };

    // Block A committed under a FULL-viewport overlay → stored fully pending.
    const fullOverlay = Array.from({ length: 22 }, (_, i) => `full overlay row ${i}`).join('\n');
    const aRows = ['TRANS_ALPHA_1', 'TRANS_ALPHA_2', 'TRANS_ALPHA_3'];
    c.setOverlay(fullOverlay);
    c.commitAbove(`${aRows.join('\n')}\n\n`);
    expect(internals.committedBandBottomRow, 'A must have taken the prevTopRow<=1 storage branch').toBe(20);

    // PARTIAL shrink: overlay drops to 10 lines → frame top moves to a mid row
    // (prevTopRow > 1, but the frame is NOT fully collapsed). Repaint so
    // repositionCommittedBand re-pins A above the new frame top before B commits.
    const smallOverlay = Array.from({ length: 10 }, (_, i) => `small overlay row ${i}`).join('\n');
    c.setOverlay(smallOverlay);
    internals.repaint();

    // Block B committed under the SMALLER overlay (prevTopRow > 1 now).
    const bRows = ['TRANS_BETA_1', 'TRANS_BETA_2'];
    c.commitAbove(`${bRows.join('\n')}\n\n`);

    // Full collapse.
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    // Neither block A nor B may be dropped or duplicated across the buffer.
    for (const m of [...aRows, ...bRows]) {
      const hits = lines.filter((l) => l.includes(m)).length;
      expect(hits, `block "${m}" must survive the partial-shrink transition exactly once (found ${hits}):\n${dump}`).toBe(1);
    }

    // Commit order preserved: A's last row sits above B's first row.
    const aLast = lines.findIndex((l) => l.includes('TRANS_ALPHA_3'));
    const bFirst = lines.findIndex((l) => l.includes('TRANS_BETA_1'));
    expect(aLast, `A and B both present:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(bFirst, `A and B both present:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(aLast < bFirst, `A must sit above B (commit order):\n${dump}`).toBe(true);

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);
});

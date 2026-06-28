/**
 * MINIMAL FAILING REGRESSION: two-table overflow path drops T2 header.
 *
 * Geometry (exact, verified against running code):
 *   COLS=80, ROWS=24, extraRows=2, anchorRow=1
 *   6-line overlay → frameTop=13, room=12
 *   T1 = 12 rows (content=11, sep=1 via paintSeparator) → fully fits, fully painted
 *   T2 = 13 rows (content=13, no sep since fitsAboveFrame=FALSE)
 *   bandTextLines for T2 = 14 rows (content=13 + sep)
 *   overflowRun = T1_band(12) + T2_bandTextLines(14) = 26 > maxBandModel=20
 *   overflowHasPending = FALSE (T1 fully painted)
 *   fitsAboveFrame = FALSE (13 > 12)
 *   useBandHold = FALSE → OVERFLOW PATH → T2 header split to scrollback!
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { renderMarkdownToTerminal } from './formatter.js';

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
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}

const COLS = 80, ROWS = 24;

// These exact tables produce T1=11 content rows, T2=13 content rows at 80-col terminal
const TABLE1_MD = [
  '| Model | Resolved | Headline (N=36) | 95% CI (Wilson) | Among evaluated |',
  '|-------|----------|-----------------|-----------------|-----------------|',
  '| Kimi k1.5-long-context | 18/36 | 50.0% | 33.4–66.6% | 50.0% |',
  '| Qwen3-235B-A22B | 16/36 | 44.4% | 28.6–61.3% | 44.4% |',
  '| claude-sonnet-4-5 | 20/36 | 55.6% | 38.5–71.6% | 55.6% |',
].join('\n');

const TABLE2_MD = [
  '| Repo | Kimi k1.5-long-context | Qwen3-235B-A22B | claude-sonnet-4-5 |',
  '|------|------------------------|-----------------|-------------------|',
  '| django | 1/2 | 1/2 | 2/2 |',
  '| pydata | 2/2 | 2/2 | 1/2 |',
  '| pylint-dev | 0/1 | 0/1 | 0/1 |',
  '| scikit-learn | 3/4 | 3/4 | 2/4 |',
  '| sphinx-doc | 2/3 | 2/3 | 1/3 |',
].join('\n');

// 6-line overlay → frame ≈ 11 rows → frameTop ≈ 13 → room=12
// T1(11 content + 1 sep = 12) fits (12 ≤ 12); T2(13 content) doesn't (13 > 12)
const OVERLAY = Array.from({ length: 6 }, (_, i) => `generating analysis line ${i}`).join('\n');

describe('REGRESSION: T2 header split to scrollback when merged run > maxBandModel (80-col)', () => {
  it('Table 2 header must be in the viewport (not split to scrollback by overflow path)', async () => {
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

    const internals = c as unknown as {
      repaint(): void;
      committedBand: string[];
      committedBandPaintedRows: number;
      committedBandBottomRow: number;
    };

    const t1Rendered = renderMarkdownToTerminal(TABLE1_MD, { maxWidth: COLS });
    const t2Rendered = renderMarkdownToTerminal(TABLE2_MD, { maxWidth: COLS });
    const t1Lines = t1Rendered.replace(/\n$/, '').split('\n');
    const t2Lines = t2Rendered.replace(/\n$/, '').split('\n');
    console.log(`T1 content rows: ${t1Lines.length}, T2 content rows: ${t2Lines.length}`);

    // Commit T1 — should take fits-path (room=12, T1=11 content rows fits)
    c.setOverlay(OVERLAY);
    c.commitAbove(t1Rendered.replace(/\n$/, '') + '\n\n');
    const t1Band = internals.committedBand.length;
    const t1Painted = internals.committedBandPaintedRows;
    const t1Bottom = internals.committedBandBottomRow;
    console.log(`After T1: band=${t1Band}, painted=${t1Painted}, bandBottom=${t1Bottom}`);
    // PRECONDITION: T1 must be fully painted for the bug to trigger
    // (if overflowHasPending=TRUE, useBandHold is forced and T2 is saved)

    // Commit T2 — should trigger overflow path (T1+T2 merged > maxBandModel, T1 fully painted)
    c.setOverlay(OVERLAY); // Same overlay = same frame → contiguous band
    c.commitAbove(t2Rendered.replace(/\n$/, '') + '\n\n');
    const t2Band = internals.committedBand.length;
    const t2Painted = internals.committedBandPaintedRows;
    console.log(`After T2: band=${t2Band}, painted=${t2Painted}`);

    // Collapse overlay (turn ends)
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');
    console.log('\nFull buffer:\n' + dump);

    const FRAME_RE = /\u23af/;
    const baseY = term.buffer.active.baseY;
    const view = lines.slice(baseY);
    const frameIdx = view.findIndex((l) => FRAME_RE.test(l));
    expect(frameIdx, 'frame not found').toBeGreaterThanOrEqual(0);

    // CRITICAL ASSERTION: Table 2 header must appear in the VIEWPORT
    // Pre-fix: T2 header is in scrollback (archived by overflow Phase 1), 
    // NOT visible in the viewport without scrolling up.
    const t2HeaderInView = view.slice(0, frameIdx).filter((l) => l.includes('Repo')).length;
    expect(
      t2HeaderInView,
      `Table 2 header ('Repo') must appear in the viewport (found ${t2HeaderInView} times).\n` +
      `Pre-fix: T2 header lands in scrollback while T2 body is on screen.\n${dump}`
    ).toBe(1);

    // No large vertical blank gap in the viewport
    const firstContent = view.findIndex((l) => l.trim() !== '');
    let maxBlankRun = 0, cur = 0;
    for (let i = Math.max(0, firstContent); i < frameIdx; i++) {
      if ((view[i] ?? '').trim() === '') { cur++; maxBlankRun = Math.max(maxBlankRun, cur); }
      else cur = 0;
    }
    expect(
      maxBlankRun,
      `Blank gap of ${maxBlankRun} rows in viewport (max 1 allowed).\n${dump}`
    ).toBeLessThanOrEqual(1);

    // T2 header must appear exactly once total (no duplication from overflow)
    const t2HeaderTotal = lines.filter((l) => l.includes('Repo')).length;
    expect(
      t2HeaderTotal,
      `T2 header appears ${t2HeaderTotal} times total (expected 1 — overflow path duplicates it).\n${dump}`
    ).toBe(1);

    term.dispose(); statusLine.stop(); c.disarm();
  }, 20_000);
});

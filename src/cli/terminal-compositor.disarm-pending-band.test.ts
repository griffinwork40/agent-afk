/**
 * Regression (PR #649 follow-up): a multi-line block committed via commitAbove()
 * while the live overlay FILLS the viewport (prevTopRow == 1) is HELD in the
 * committedBand model FULLY PENDING — stored with committedBandBottomRow =
 * collapsedFrameTop-1, painted to NEITHER the terminal NOR scrollback, to be
 * materialized later by repositionCommittedBand() on collapse
 * (terminal-compositor.committed-band-commit.ts newTopRow<=1 storage branch).
 *
 * THE LOSS: if disarm() runs BEFORE that collapse-repaint — the user hits
 * Ctrl-C / the turn aborts / the process exits mid-turn while the tall overlay
 * is still up — disarm() does logUpdate.clear() + done() + resetState() and the
 * model is discarded. Because the pending rows were never painted and never
 * archived, the whole committed block (e.g. a streamed "Done" report or table)
 * vanishes from screen AND scrollback. Pre-band-hold the legacy overflow path
 * archived to scrollback, so the block survived in history.
 *
 * THE FIX: disarm() flushes the genuinely-unpainted band-model prefix to
 * scrollback as REAL content BEFORE logUpdate.clear(), tracked via the
 * committedBandPaintedRows field (0 for a fully-pending model). The NORMAL
 * teardown — overlay collapsed first, so repositionCommittedBand already
 * painted the band — must NOT re-emit those on-screen rows (that would
 * duplicate them in scrollback). Both behaviors are asserted below.
 *
 * Test #1 ("disarm before collapse") FAILS on current code (rows absent, count
 * 0) and passes after the fix. Test #2 ("normal collapse path") proves the fix
 * does not duplicate already-painted rows.
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

describe('disarm() before collapse: pending band-hold rows are preserved in scrollback', () => {
  it('flushes a fully-pending committed block to scrollback when disarm() runs before the overlay collapses', async () => {
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

    // A multi-line "Done report" block committed as ONE block under the overlay.
    const reportRows = [
      'DONE_HEADER unique marker row',
      'DONE_LINE_A first body row',
      'DONE_LINE_B second body row',
      'DONE_LINE_C third body row',
    ];
    c.setOverlay(tallOverlay);
    c.commitAbove(`${reportRows.join('\n')}\n\n`);

    // Precondition: the block took the fully-pending storage branch — band model
    // non-empty, bottom at collapsedFrameTop-1 (=rows-1-extraRows-1=20), and
    // ZERO painted rows (nothing on screen, nothing in scrollback yet).
    const internals = c as unknown as {
      repaint(): void;
      committedBand: string[];
      committedBandBottomRow: number;
      committedBandPaintedRows: number;
    };
    expect(internals.committedBand.length, 'band model must hold the committed block').toBeGreaterThan(0);
    expect(internals.committedBandBottomRow, 'must be the fully-pending storage branch (collapsedFrameTop-1=20)').toBe(20);
    expect(internals.committedBandPaintedRows, 'nothing painted yet — block is fully pending').toBe(0);

    // The user aborts mid-turn: disarm() WITHOUT collapsing the overlay first.
    // Pre-fix this discards the model and the block is lost from screen AND
    // scrollback. Post-fix disarm() flushes the pending rows to scrollback.
    statusLine.stop();
    c.disarm();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    // Every committed row must survive EXACTLY ONCE across the whole buffer
    // (scrollback). Pre-fix: every row absent (count 0) — the headline loss.
    for (const row of reportRows) {
      const marker = row.split(' ')[0]!; // DONE_HEADER / DONE_LINE_A / …
      const hits = lines.filter((l) => l.includes(marker)).length;
      expect(
        hits,
        `committed row "${marker}" must survive in scrollback after abort-before-collapse (found ${hits}):\n${dump}`,
      ).toBe(1);
    }

    term.dispose(); c.disarm();
  }, 15_000);

  it('does NOT duplicate rows on the normal teardown (collapse → repaint → disarm)', async () => {
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

    const tallOverlay = Array.from({ length: 22 }, (_, i) => `thinking ${i} — held overlay row keeping the frame at full height`).join('\n');
    const reportRows = [
      'NORM_HEADER unique marker row',
      'NORM_LINE_A first body row',
      'NORM_LINE_B second body row',
      'NORM_LINE_C third body row',
    ];
    c.setOverlay(tallOverlay);
    c.commitAbove(`${reportRows.join('\n')}\n\n`);

    const internals = c as unknown as {
      repaint(): void;
      committedBand: string[];
      committedBandPaintedRows: number;
    };
    expect(internals.committedBandPaintedRows, 'block starts fully pending').toBe(0);

    // NORMAL path: the overlay collapses (turn ends → spinner stops, overlay
    // clears). repositionCommittedBand paints the band on the collapse repaint —
    // so committedBandPaintedRows becomes the full band length.
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    internals.repaint();
    internals.repaint();
    expect(
      internals.committedBandPaintedRows,
      'after collapse the band is fully painted on screen',
    ).toBe(internals.committedBand.length);

    // THEN disarm. The flush MUST be a no-op (painted === length): the rows are
    // already on screen, so re-emitting them would DUPLICATE them in scrollback.
    statusLine.stop();
    c.disarm();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    // Each committed row present EXACTLY ONCE — not twice. A regression in the
    // disarm flush (flushing already-painted rows) would make this 2.
    for (const row of reportRows) {
      const marker = row.split(' ')[0]!;
      const hits = lines.filter((l) => l.includes(marker)).length;
      expect(
        hits,
        `committed row "${marker}" must appear exactly once after normal collapse→disarm (found ${hits}):\n${dump}`,
      ).toBe(1);
    }

    term.dispose(); c.disarm();
  }, 15_000);
});

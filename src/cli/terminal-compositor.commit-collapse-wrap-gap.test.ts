/**
 * Regression (big-gap.txt): the "massive blank space". A long streamed line is
 * committed while a tall overlay (status footer + spinner + streaming preview)
 * FILLS the viewport, then the overlay collapses. The committed line must be
 * re-pinned hugging the live frame on collapse — not dropped, leaving a run of
 * ~N shrink-pad blank rows between the transcript and the frame.
 *
 * Root cause: when the frame fills the viewport (desiredTopRow ≤ 1) commitAbove
 * had nowhere to paint the block (newTopRow ≤ 1) and DROPPED it from the band
 * (clearCommittedBand) — the block lived only in scrollback. On collapse
 * repositionCommittedBand found an empty band and re-pinned nothing, so
 * CupFrameRenderer's shrink-pad blank rows stayed blank (the gap). The wrap-
 * blind logical line count (a7ace49 / #39 follow-up) compounded it by under-
 * scrolling the wrapped block.
 *
 * Fix (band-hold, review #649): when the frame fills the viewport (newTopRow
 * <= 1) and the run fits the collapsed screen, commitAbove no longer DROPS the
 * block — the H1 band-hold branch HOLDS the full run in `committedBand` (fully
 * pending, nothing painted yet) and repositionCommittedBand PAINTS it adjacent
 * to the frame on the next collapse. commitAbove's lineCount is physical
 * (wrap-aware) so the scroll/anchor math matches the wrapped screen. (An earlier
 * fix parked the block in a separate `coveredBand` field; band-hold superseded
 * that path and the field was removed.)
 *
 * HARD GATE: pre-fix the committed WRAPMARK line is ABSENT from the collapsed
 * viewport (dropped) and a tall blank gap sits above the frame. Post-fix the
 * line is present, single-copy, and hugs the frame.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { LoopStageBar } from './commands/interactive/loop-stage.js';

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
function collect(stream: MockStdout): () => string { const c: string[] = []; stream.on('data', (x) => c.push(String(x))); return () => c.join(''); }
function termWrite(t: HeadlessTerminal, d: string): Promise<void> { return new Promise((r) => t.write(d, r)); }
function lines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}
function wireFooter(stdout: MockStdout): { statusLine: StatusLine; loopStageBar: LoopStageBar } {
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: 'STATUSMODELXYZ', cost: 0, tokens: 0, contextPct: 0 });
  const loopStageBar = new LoopStageBar({ getExtraRows: () => statusLine.getExtraRows(), stream: stdout });
  loopStageBar.setRowCountChangeHandler(() => statusLine.setExtraRows(1));
  statusLine.setAfterScrollRestore(() => loopStageBar.redraw());
  loopStageBar.start();
  return { statusLine, loopStageBar };
}

const COLS = 120, ROWS = 24;
const SPINNER_RE = /[\u2800-\u28ff]/; // braille spinner glyph row (the live frame)

describe('commit-under-full-overlay → collapse gap regression (big-gap.txt)', () => {
  it('re-pins the committed wrapping line hugging the frame after the overlay collapses', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const { statusLine, loopStageBar } = wireFooter(stdout);

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    const internals = c as unknown as { repaint(): void };

    c.setSpinner({ enabled: true });
    // Prior transcript already committed.
    c.commitAbove('PRIOR_TRANSCRIPT_LINE\n');
    // A tall overlay (streaming preview) fills the viewport — desiredTopRow ≤ 1.
    c.setOverlay(Array.from({ length: ROWS - 1 }, (_, i) => `streaming preview row ${i}`).join('\n'));
    // The model commits a long assistant line WHILE the overlay fills the screen.
    // One logical line that soft-wraps to 2 physical rows (the capture's shape).
    c.commitAbove('WRAPMARK_assistant_line_' + 'x'.repeat(COLS + 25) + '\n');
    // Overlay collapses back to idle (turn settles, preview clears).
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const ls = lines(term);
    const vStart = Math.max(0, ls.length - ROWS);
    const view = ls.slice(vStart);
    const dump = view.map((l, i) => `[${String(vStart + i).padStart(2)}] ${JSON.stringify(l.slice(0, 56))}`).join('\n');

    const markerIdxs = view
      .map((l, i) => (l.includes('WRAPMARK_assistant_line_') ? i : -1))
      .filter((i) => i >= 0);
    const frameIdx = view.findIndex((l) => SPINNER_RE.test(l));

    expect(frameIdx, `frame (spinner) not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

    // (a) PRESENT + SINGLE-COPY: the committed line survives the collapse exactly
    //     once. Pre-fix it is dropped (0 occurrences) — the gap bug.
    expect(
      markerIdxs.length,
      `committed line must appear exactly once after collapse (0 = dropped/gap bug, >1 = duplicate):\n${dump}`,
    ).toBe(1);

    // (b) HUGS THE FRAME: the committed line sits immediately above the live
    //     frame — no blank gap between transcript and frame. (markerIdx is the
    //     line's first physical row; its soft-wrap continuation is the row just
    //     below, so the frame is ≤2 rows under the marker.)
    const markerIdx = markerIdxs[0]!;
    expect(
      frameIdx - markerIdx,
      `committed line does not hug the frame (marker=${markerIdx}, frame=${frameIdx}) — blank gap between:\n${dump}`,
    ).toBeLessThanOrEqual(2);
    expect(markerIdx, `committed line should be above the frame:\n${dump}`).toBeLessThan(frameIdx);

    // Single status row still holds (no double-statusline regression).
    expect(ls.filter((l) => l.includes('STATUSMODELXYZ')).length, `status row not single:\n${dump}`).toBe(1);

    term.dispose(); loopStageBar.stop(); statusLine.stop(); c.disarm();
  }, 15_000);
});

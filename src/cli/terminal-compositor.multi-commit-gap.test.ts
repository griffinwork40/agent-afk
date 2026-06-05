/**
 * Regression: a "massive gap" must not open between committed content and the
 * live frame when MULTIPLE blocks are committed during a tall overlay and the
 * overlay then collapses (the subagent-rollup case).
 *
 * Root cause (pre-existing, orthogonal to the loop-stage rail / #634 —
 * reproduces identically at extraRows=0): commitAbove tracked only the
 * MOST-RECENT committed block in `committedBand`. On a large collapse,
 * repositionCommittedBand re-pinned that one block against the frame while
 * OLDER on-screen committed blocks stayed stranded high, opening a tall blank
 * gap between the two groups.
 *
 * Fix: commitAbove tracks the FULL contiguous on-screen committed run, so the
 * whole run re-pins adjacent to the frame on collapse — the committed lines
 * visible in the viewport form a single contiguous block hugging the frame.
 *
 * HARD GATE: pre-fix the viewport's committed lines split into two groups
 * (TOOL_OUTPUT_* high, rollup low) — non-contiguous → fails. Post-fix they are
 * one contiguous block immediately above the frame → passes.
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

const COLS = 80, ROWS = 24;
const COMMITTED_RE = /TOOL_OUTPUT_\d|memory_search|bash x37|Done \(114/;
const SPINNER_RE = /[\u2800-\u28ff]/; // braille spinner glyph row

/** Real production footer wiring (StatusLine + LoopStageBar + after-scroll restore). */
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

describe('multi-commit gap regression (real footer, extraRows=1)', () => {
  it('keeps the viewport committed run contiguous and hugging the frame after many commits + collapse', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const { statusLine, loopStageBar } = wireFooter(stdout);

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    const internals = c as unknown as { repaint(): void };

    // Subagent run: a tall overlay is up while tool outputs commit one by one,
    // then a multi-line rollup commits and the overlay collapses to idle.
    c.setSpinner({ enabled: true });
    for (let k = 0; k < 8; k++) {
      c.setOverlay(Array.from({ length: 10 }, (_, i) => `stream ${k}.${i}`).join('\n'));
      c.commitAbove(`TOOL_OUTPUT_${k}\n`);
    }
    c.commitAbove('memory_search — done\nbash x37 — done\nDone (114 tools)\n');
    c.setOverlay('');
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const ls = lines(term);

    // Scope to the VISIBLE viewport (the last ROWS rows). Older committed lines
    // that scrolled into scrollback above the viewport are correct — the bug is
    // about the LIVE view showing a gap between committed content and the frame.
    const vStart = Math.max(0, ls.length - ROWS);
    const view = ls.slice(vStart);
    const dump = view.map((l, i) => `[${String(vStart + i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    const frameIdx = view.findIndex((l) => SPINNER_RE.test(l));
    expect(frameIdx, `frame (spinner) not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

    const committedIdxs = view
      .map((l, i) => (COMMITTED_RE.test(l) ? i : -1))
      .filter((i) => i >= 0);
    expect(committedIdxs.length, `no committed lines in viewport:\n${dump}`).toBeGreaterThan(0);

    const min = committedIdxs[0]!;
    const max = committedIdxs[committedIdxs.length - 1]!;
    // Contiguous: the committed lines occupy an unbroken span (no stranded
    // block separated by a blank gap — the pre-fix bug).
    expect(
      max - min + 1,
      `committed lines are NOT contiguous in the viewport (the gap bug): span=${max - min + 1}, count=${committedIdxs.length}:\n${dump}`,
    ).toBe(committedIdxs.length);
    // The run's bottom hugs the frame (the most-recent commit sits just above it).
    expect(
      frameIdx - max,
      `committed run does not hug the frame (bottom=${max}, frame=${frameIdx}):\n${dump}`,
    ).toBe(1);
    // The most-recent committed line is the rollup's last line, adjacent to the frame.
    expect(view[max], `rollup tail not adjacent to frame:\n${dump}`).toContain('Done (114 tools)');

    // Double-statusline fix still holds in this heavy scenario.
    expect(ls.filter((l) => l.includes('STATUSMODELXYZ')).length, `status row not single:\n${dump}`).toBe(1);

    term.dispose(); loopStageBar.stop(); statusLine.stop(); c.disarm();
  }, 15_000);
});

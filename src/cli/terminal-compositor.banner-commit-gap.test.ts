/**
 * Regression (banner case): the interactive REPL prints an ASCII banner before
 * arming, so the compositor runs with anchorRow > 1 (hasBanner = true). Every
 * OTHER gap/scrollback regression test uses anchorRow: 1, so the banner path
 * was uncovered — and broken: `commitAbove` gated its full-contiguous-run
 * tracking + merge on `anchorRow <= 1`, and never lowered `anchorRow` when its
 * Phase-1 scroll pushed the banner into scrollback. The floor went stale, the
 * band could only ever track `frameTop - anchorRow` rows, committed content
 * piled up orphaned in the vacated banner rows, and a tall overlay collapsing
 * after several commits stranded the older blocks (blank gap), re-pinned a
 * partial band (duplication), and dropped untracked lines that never reached
 * scrollback (lost commits) — the reported "stuff isn't getting committed to
 * the scrollback" bug.
 *
 * Fix (terminal-compositor.committed-band.ts): drop the `anchorRow <= 1` gate
 * (the `committedBandBottomRow === newTopRow - 1` equality is the real, banner-
 * agnostic contiguity guard) and decrement `anchorRow` by the rows Phase 1
 * scrolls, exactly as the evict path does — so the floor follows the banner
 * into scrollback and the band tracks the whole visible run.
 *
 * Parameterized over two geometries to prove the fix is not tuned to one size.
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

const SPINNER_RE = /[\u2800-\u28ff]/;
const COMMITTED_RE = /TOOL_OUTPUT_\d|memory_search|bash x37|Done \(114/;

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

interface Geometry { name: string; cols: number; rows: number; bannerRows: number; overlayRows: number; commits: number }

const GEOMETRIES: Geometry[] = [
  { name: '24-row terminal, 8-row banner', cols: 80, rows: 24, bannerRows: 8, overlayRows: 10, commits: 8 },
  { name: '50-row terminal, 12-row banner (real AFK banner)', cols: 100, rows: 50, bannerRows: 12, overlayRows: 22, commits: 12 },
];

describe('banner commit→collapse gap (anchorRow > 1, real footer)', () => {
  for (const g of GEOMETRIES) {
    it(`does not lose committed content and keeps the viewport run contiguous — ${g.name}`, async () => {
      const stdout = makeStdout(g.cols, g.rows);
      const stdin = makeStdin();
      const all = collect(stdout);

      // Print a banner BEFORE arming, exactly like the interactive surface. The
      // compositor protects rows 1..anchorRow-1; anchorRow is the first row below.
      for (let i = 0; i < g.bannerRows; i++) stdout.write(`BANNER_LINE_${i}\n`);

      const { statusLine, loopStageBar } = wireFooter(stdout);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: g.bannerRows + 1 });
      await c.arm();
      const internals = c as unknown as { repaint(): void };

      // Subagent run: a tall overlay is up while tool outputs commit one by one,
      // then a multi-line rollup commits and the overlay collapses to idle.
      const committedBlocks: string[] = [];
      c.setSpinner({ enabled: true });
      for (let k = 0; k < g.commits; k++) {
        c.setOverlay(Array.from({ length: g.overlayRows }, (_, i) => `stream ${k}.${i}`).join('\n'));
        const block = `TOOL_OUTPUT_${k}`;
        committedBlocks.push(block);
        c.commitAbove(`${block}\n`);
      }
      for (const line of ['memory_search — done', 'bash x37 — done', 'Done (114 tools)']) committedBlocks.push(line);
      c.commitAbove('memory_search — done\nbash x37 — done\nDone (114 tools)\n');
      c.setOverlay('');
      internals.repaint();
      internals.repaint();

      const term = new HeadlessTerminal({ cols: g.cols, rows: g.rows, scrollback: 800, allowProposedApi: true, convertEol: true });
      await termWrite(term, all());
      const ls = lines(term);
      const fullDump = ls.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

      // Exact whole-line match: substring matching would conflate "TOOL_OUTPUT_1"
      // with "TOOL_OUTPUT_10"/"_11". translateToString(true) right-trims, and the
      // committed lines are written left-aligned, so a trimmed === is exact.
      const occurrences = (block: string): number => ls.filter((l) => l.trim() === block).length;
      // (1) DURABILITY: every committed block survives EXACTLY once in the buffer
      // (scrollback + viewport). Zero = the "not committed to scrollback" bug.
      // (2) NO DUPLICATES: more than one = the garbled/doubled-row symptom. The
      // single-copy invariant means exactly one copy reaches the terminal.
      for (const block of committedBlocks) {
        const count = occurrences(block);
        expect(count, `committed block "${block}" should appear EXACTLY once, saw ${count}×:\n${fullDump}`).toBe(1);
      }

      // (3) CONTIGUITY: the committed lines visible in the viewport hug the
      // frame with no massive blank gap between them and the live frame.
      const vStart = Math.max(0, ls.length - g.rows);
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
      expect(
        max - min + 1,
        `committed lines NOT contiguous (gap bug): span=${max - min + 1}, count=${committedIdxs.length}:\n${dump}`,
      ).toBe(committedIdxs.length);
      expect(frameIdx - max, `committed run does not hug the frame (bottom=${max}, frame=${frameIdx}):\n${dump}`).toBe(1);
      // The most-recent committed line is the rollup tail, adjacent to the frame.
      expect(view[max], `rollup tail not adjacent to frame:\n${dump}`).toContain('Done (114 tools)');
      // Footer status row remains single (no double-statusline under the heavy scenario).
      expect(ls.filter((l) => l.includes('STATUSMODELXYZ')).length, `status row not single:\n${fullDump}`).toBe(1);

      term.dispose(); loopStageBar.stop(); statusLine.stop(); c.disarm();
    }, 15_000);
  }
});

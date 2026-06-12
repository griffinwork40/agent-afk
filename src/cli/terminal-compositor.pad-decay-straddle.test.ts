/**
 * Reproduction: subagent-block gap — a commitAbove BURST that straddles the
 * CupFrameRenderer shrink-pad decay strands the first committed line(s) high
 * on screen with a multi-row blank gap below them, before the rest of the
 * burst lands hugging the collapsed frame.
 *
 * Production shape (mint skill, screenshot 2026-06-10): subagent tool tray
 * overlay is TALL (header + many tool rows). On subagent completion the
 * overlay collapses (setOverlay short) and a deferred coordinator batch then
 * commits the block: header, tool rows, Done. Final scrollback shows
 *   `→ Agent(mint-parallelize) [subagent] — 18 tools · …`
 *   ~28 BLANK rows
 *   tool rows + `Done (36 tools · …)`
 *
 * Mechanism under test (hypothesis):
 *   1. setOverlay(short) after a tall overlay triggers the one-render shrink
 *      pad: render() pads the frame back to the old footprint, so
 *      `topRow` stays at the TALL position for exactly one render.
 *   2. commitAbove(#1 of burst) Phase 1 computes fitsAboveFrame from the
 *      still-padded (stale-tall) topRow → writes line #1 high on screen.
 *   3. The same commit's Phase 2 repaint decays the pad → frame collapses to
 *      the bottom, vacating the tall footprint as blank rows BELOW line #1.
 *   4. commitAbove(#2..N) now see the collapsed topRow → land at the bottom;
 *      the band-merge contiguity check fails against line #1's stranded row;
 *      the vacated blanks sit between line #1 and lines #2..N.
 *   5. Subsequent commits scroll the whole arrangement verbatim into
 *      scrollback: line #1, big blank run, lines #2..N.
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
function dumpMap(lines: string[]): string {
  const out: string[] = [];
  let blanks = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').trimEnd();
    if (l === '') { blanks++; continue; }
    if (blanks > 0) { out.push(`     [${blanks} blank]`); blanks = 0; }
    out.push(`[${String(i).padStart(3)}] ${l.slice(0, 70)}`);
  }
  if (blanks > 0) out.push(`     [${blanks} blank]`);
  return out.join('\n');
}

/** Largest run of contiguous blank rows strictly between buffer rows a and b. */
function maxBlankRun(lines: string[], a: number, b: number): number {
  let max = 0, run = 0;
  for (let r = a + 1; r < b; r++) {
    if ((lines[r] ?? '').trim() === '') { run++; if (run > max) max = run; }
    else run = 0;
  }
  return max;
}

async function runScenario(opts: {
  cols: number;
  rows: number;
  tallLines: number;
  commitsWhileTall: number;
  burst: string[];
  trailingCommits: number;
}): Promise<{ lines: string[]; dump: string; find: (m: string) => number }> {
  const stdout = makeStdout(opts.cols, opts.rows);
  const stdin = makeStdin();
  const all = collect(stdout);
  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
  const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
  await c.arm();
  statusLine.setExtraRows(2);
  c.setSpinner({ enabled: true });

  // Prior context: a completed block already in history (mirrors mint-plan).
  c.setOverlay('tool detail a\ntool detail b');
  c.commitAbove('EARLIER_CTX_A\n');
  c.commitAbove('EARLIER_CTX_B\n');

  // Subagent tray grows TALL (header + tool rows live in the overlay).
  const tray = Array.from({ length: opts.tallLines }, (_, i) => `live tray row ${i}`).join('\n');
  c.setOverlay(tray);

  // Optional commits while tall — puts the committed band hugging the tall
  // frame top (production: earlier orchestrator prose/tool flushes).
  for (let k = 0; k < opts.commitsWhileTall; k++) {
    c.commitAbove(`WHILE_TALL_${k}\n`);
  }

  // Subagent completes: overlay collapses to a short frame (spinner+input),
  // then the deferred batch commits the whole block as a burst.
  c.setOverlay('spinner row');
  for (const line of opts.burst) c.commitAbove(`${line}\n`);

  // Next subagent starts; later activity pushes history toward scrollback.
  c.setOverlay('next subagent spinner\nnext subagent row');
  for (let k = 0; k < opts.trailingCommits; k++) {
    c.commitAbove(`TRAILING_${k}\n`);
  }
  c.setOverlay('');
  const internals = c as unknown as { repaint(): void };
  internals.repaint();
  internals.repaint();

  const term = new HeadlessTerminal({ cols: opts.cols, rows: opts.rows, scrollback: 1000, allowProposedApi: true, convertEol: true });
  await termWrite(term, all());
  const lines = allLines(term);
  const dump = dumpMap(lines);
  term.dispose(); statusLine.stop(); c.disarm();
  const find = (m: string): number => lines.findIndex((l) => l.includes(m));
  return { lines, dump, find };
}

const BURST = [
  'BLOCK_HEADER Agent(mint-parallelize)',
  ...Array.from({ length: 6 }, (_, i) => `BLOCK_TOOL_${i}`),
  'BLOCK_DONE (36 tools)',
];

describe('commitAbove burst straddling shrink-pad decay (subagent block gap)', () => {
  for (const geometry of [
    { cols: 80, rows: 24, tallLines: 14 },
    { cols: 120, rows: 50, tallLines: 30 },
  ]) {
    for (const commitsWhileTall of [0, 2]) {
      it(`keeps the burst contiguous (${geometry.cols}x${geometry.rows}, tall=${geometry.tallLines}, whileTall=${commitsWhileTall})`, async () => {
        const { lines, dump, find } = await runScenario({
          cols: geometry.cols,
          rows: geometry.rows,
          tallLines: geometry.tallLines,
          commitsWhileTall,
          burst: BURST,
          trailingCommits: 6,
        });

        // Every burst line must appear exactly once.
        for (const m of BURST) {
          const hits = lines.filter((l) => l.includes(m)).length;
          expect(hits, `${m} must appear exactly once (found ${hits}):\n${dump}`).toBe(1);
        }

        const headerIdx = find('BLOCK_HEADER');
        const firstToolIdx = find('BLOCK_TOOL_0');
        const doneIdx = find('BLOCK_DONE');

        // Order: header above tools above done.
        expect(headerIdx, `header before tools:\n${dump}`).toBeLessThan(firstToolIdx);
        expect(firstToolIdx, `tools before done:\n${dump}`).toBeLessThan(doneIdx);

        // THE BUG: a multi-row blank gap inside one committed block.
        // Allow at most 1 blank row (rhythm separator); the regression strands
        // the header above the vacated tall-frame footprint (~tallLines rows).
        const gap = maxBlankRun(lines, headerIdx, doneIdx);
        expect(
          gap,
          `blank gap of ${gap} rows inside the committed block (header row ${headerIdx} → done row ${doneIdx}):\n${dump}`,
        ).toBeLessThanOrEqual(1);
      }, 20_000);
    }
  }
});

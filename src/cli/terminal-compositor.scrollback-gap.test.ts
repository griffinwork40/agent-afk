/**
 * Regression: committed content must NOT be lost, and must NOT be separated by
 * a massive blank gap in scrollback, when blocks are committed while a tall
 * overlay (a streaming "thought" preview) is up and the band repeatedly caps.
 *
 * Root cause (pre-fix):
 *  1. commitAbove Phase 2's CupFrameRenderer erase pass (stale-tall previousTopRow
 *     after a shrink-pad collapse) wiped older band rows, and Phase 3 repainted
 *     ONLY the newest line — so the wiped lines were dropped on the next cap
 *     believing they had reached scrollback when only blanks had: LOST commits.
 *  2. preserveRowsBeforeFrameRender scrolled the full frame-growth deficit of
 *     BLANK rows (above the frame-hugging band) into scrollback on every upward
 *     growth — opening a "massive gap" between committed clusters in scrollback.
 *
 * Fix: Phase 3 repaints the FULL band (screen == model); evict-on-growth scrolls
 * only the band OVERFLOW as real content (never blank rows). See docs/scrollback.md.
 *
 * HARD GATE: production geometry is extraRows=2 (StatusLine + LoopStageBar +
 * VerdictLedger). Pre-fix this loses early commits AND opens a multi-row blank
 * gap in scrollback; post-fix every committed line survives exactly once and the
 * committed lines that reached scrollback are perfectly contiguous (zero blank
 * rows between consecutive scrollback entries).
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

const COLS = 80, ROWS = 24;

describe('commitAbove scrollback gap regression (tall-overlay caps, extraRows=2)', () => {
  it('preserves every committed line exactly once with no massive blank gap in scrollback', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    // Production steady-state footer: StatusLine(1) + LoopStageBar(1) + VerdictLedger(1) → extraRows=2.
    statusLine.setExtraRows(2);
    c.setSpinner({ enabled: true });

    // Commit a series of blocks while a tall "thought" overlay is up (the band
    // caps to ~4 lines, forcing the oldest into scrollback) interleaved with
    // short tool overlays — mirrors a real investigation turn.
    const markers: string[] = [];
    const commit = (m: string) => { markers.push(m); c.commitAbove(`${m}\n`); };
    for (let k = 0; k < 7; k++) {
      c.setOverlay(Array.from({ length: 13 }, (_, i) => `thinking ${k}.${i} streaming preview`).join('\n'));
      commit(`THOUGHTLINE_${k}`);
      c.setOverlay(`tool detail ${k} line a\ntool detail ${k} line b`);
      commit(`TOOLLINE_${k}`);
    }
    c.setOverlay('');
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    // (1) No loss / no duplication: every committed marker appears exactly once,
    //     across scrollback + viewport, in commit order.
    const seen: number[] = [];
    for (const m of markers) {
      const hits = lines.map((l, i) => (l.includes(m) ? i : -1)).filter((i) => i >= 0);
      expect(hits.length, `marker ${m} must appear exactly once (found ${hits.length}):\n${dump}`).toBe(1);
      seen.push(hits[0]!);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!, `markers out of order at ${markers[i]}:\n${dump}`).toBeGreaterThan(seen[i - 1]!);
    }

    // (2) No massive gap in scrollback: consecutive committed lines that BOTH
    //     live in scrollback (above the live viewport) must be contiguous — at
    //     most one blank row between them. (The pre-fix bug scrolled the whole
    //     frame-growth deficit of blanks into scrollback, opening multi-row gaps.)
    const baseY = term.buffer.active.baseY; // first viewport row index
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1]!, b = seen[i]!;
      if (b >= baseY) break; // reached the live viewport — boundary handled by the band, not scrollback
      let blanks = 0;
      for (let r = a + 1; r < b; r++) if ((lines[r] ?? '').trim() === '') blanks++;
      expect(
        blanks,
        `blank gap (${blanks} rows) in scrollback between ${markers[i - 1]} and ${markers[i]}:\n${dump}`,
      ).toBe(0);
    }

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);
});

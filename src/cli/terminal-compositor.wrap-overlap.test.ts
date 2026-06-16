/**
 * Regression (PR #649 follow-up, "eating the bottom"): when a committed block
 * contains a logical line WIDER than the terminal, the terminal hard-wraps it
 * into ≥2 physical rows. commitAbove() must count those physical rows so the
 * NEXT commit is positioned below them — otherwise the next block is painted
 * onto the prior block's wrapped tail, overwriting ("eating") it.
 *
 * Pre-fix: lineCount = newline-count (wrap-blind), so a wide single-line block
 * counts as 1 row. Phase 1 scrolls 1 row and Phase 3 tracks 1 row; the next
 * commit's paint lands on the wide line's wrapped 2nd row and clobbers it.
 *
 * Fix: hardWrapToWidth() splits each logical line into its visual rows up front
 * (pure character wrap matching the terminal), so lineCount == physical rows.
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
function termWrite(t: HeadlessTerminal, d: string): Promise<void> { return new Promise((r) => t.write(d, r)); }
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}

const COLS = 40, ROWS = 24;

describe('commitAbove wrap-aware line counting ("eating the bottom" overlap)', () => {
  it('does not let the next commit overwrite a wide block\'s wrapped tail', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    const internals = c as unknown as { repaint(): void };

    // Block 1: ONE logical line of 55 chars on a 40-col terminal → wraps to 2
    // physical rows: row A = 40 'X', row B = "WRAPTAIL_UNIQUE" (15 chars).
    const wideLine = 'X'.repeat(COLS) + 'WRAPTAIL_UNIQUE';
    expect(wideLine.length).toBe(COLS + 15);
    c.commitAbove(`${wideLine}\n`);

    // Block 2: a distinct one-line block committed immediately after.
    c.commitAbove('SECONDBLOCK_UNIQUE\n');

    internals.repaint();

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    // The wide block's wrapped tail must SURVIVE — pre-fix the second block's
    // paint landed on its row and overwrote it (0 occurrences).
    const tailRows = lines.map((l, i) => (l.includes('WRAPTAIL_UNIQUE') ? i : -1)).filter((i) => i >= 0);
    const secondRows = lines.map((l, i) => (l.includes('SECONDBLOCK_UNIQUE') ? i : -1)).filter((i) => i >= 0);
    expect(tailRows.length, `wide block's wrapped tail must survive exactly once:\n${dump}`).toBe(1);
    expect(secondRows.length, `second block must be present exactly once:\n${dump}`).toBe(1);

    // No overlap: the two markers occupy DIFFERENT physical rows, and the wide
    // block's tail sits ABOVE the second block (commit order preserved).
    expect(tailRows[0], `tail and second block must not share a row:\n${dump}`).not.toBe(secondRows[0]);
    expect(tailRows[0]! < secondRows[0]!, `wide block tail must sit above the later block:\n${dump}`).toBe(true);

    // Sanity: the wide block's first physical row (40 X's) is still intact and
    // sits immediately above its wrapped tail.
    const headRow = tailRows[0]! - 1;
    expect(lines[headRow]?.includes('X'.repeat(COLS)), `wide block head row (40 X) must precede the tail:\n${dump}`).toBe(true);

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);
});

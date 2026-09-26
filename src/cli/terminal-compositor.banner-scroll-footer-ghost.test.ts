/**
 * Banner-scroll footer ghost — regression for the "second footer mid-screen
 * right after the first message" report.
 *
 * Mechanism: the first commit after a welcome banner scrolls the banner into
 * scrollback with a FULL-screen scroll (writeWithScrollGuard), which drags the
 * reserved footer (health rail + status line) up by `anchorRow - 1` rows. The
 * footer repaints itself at the physical bottom, but its scrolled-up copy lands
 * inside the compositor region. Under content-hug the frame parks right under
 * the echo at the top of the screen and never repaints the rows below the
 * prompt, so the copy stayed visible as a second, stale footer. The fix erases
 * every surviving compositor row inside the guarded scroll (bannerScrollSequence).
 *
 * Checked against a real headless xterm so the DECSTBM + scroll semantics are
 * the emulator's, not a mock's.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

const COLS = 80;
const STATUS = 'FOOTER-STATUS';

/** Distinct marker for each bar row above the status line (0-indexed from top of footer). */
function barMarker(i: number): string {
  return `FOOTER-BAR-${i}`;
}

function makeStdout(rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = rows;
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

/**
 * Paint the reserved footer at the physical bottom, cursor preserved.
 * Paints `extraRows` distinct bar rows (each with a unique marker) above
 * the status line so the test can assert each appears exactly once.
 */
function footerPaint(rows: number, extraRows: number): string {
  let seq = '\x1b[s';
  for (let i = 0; i < extraRows; i++) {
    const physRow = rows - extraRows + i; // rows-extraRows, rows-extraRows+1, …, rows-1
    seq += `\x1b[${physRow};1H\x1b[2K${barMarker(i)}`;
  }
  seq += `\x1b[${rows};1H\x1b[2K${STATUS}\x1b[u`;
  return seq;
}

/** Mirrors StatusLine.withFullScrollRegion: full region for the write, then
 *  re-reserve the footer rows and self-heal the footer (flush + afterScrollRestore). */
function makeScrollRegion(stdout: MockStdout, extraRows: number) {
  const reserve = (): string => `\x1b[s\x1b[1;${stdout.rows - 1 - extraRows}r\x1b[u`;
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s\x1b[r\x1b[u');
      try {
        return fn();
      } finally {
        stdout.write(reserve() + footerPaint(stdout.rows, extraRows));
      }
    },
    getExtraRows: (): number => extraRows,
  };
}

async function run(rows: number, contentHug: boolean, extraRows: number): Promise<string[]> {
  const stdout = makeStdout(rows);
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));
  const banner = Array.from({ length: 10 }, (_, i) => `BANNER-${i}`);
  stdout.write(`${banner.join('\r\n')}\r\n` + footerPaint(rows, extraRows));
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    scrollRegion: makeScrollRegion(stdout, extraRows),
    anchorRow: banner.length + 1,
    contentHug,
  });
  await c.arm();
  const repaint = (): void => (c as unknown as { repaint(): void }).repaint();
  repaint();
  c.commitAbove('ECHO-0000\n');
  c.setSpinner({ enabled: true });
  repaint();
  const term = new HeadlessTerminal({ cols: COLS, rows, scrollback: 2000, allowProposedApi: true, convertEol: true });
  await new Promise<void>((r) => term.write(chunks.join(''), r));
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
  term.dispose();
  c.disarm();
  return out;
}

const dumpOf = (lines: string[]): string =>
  lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

// Parameterize over: screen height, content-hug mode, and footer extra-row count.
// extraRows=2 checks that a taller footer (two bar rows above the status line)
// leaves no scrolled-up copy of either bar and that neither live bar is erased.
// With a 10-row banner the erase stops at rows - bannerRows in every case here;
// the absoluteBottom ceiling only binds when bannerRows < extraRows + 1.
describe.each([24, 62])('banner scroll leaves no displaced footer copy (%i rows)', (ROWS) => {
  it.each([
    [true, 1],
    [false, 1],
    [true, 2],
    [false, 2],
  ])('contentHug=%s extraRows=%i: each footer marker appears exactly once, status on last row', async (contentHug, extraRows) => {
    const lines = await run(ROWS, contentHug as boolean, extraRows as number);
    const dump = dumpOf(lines);
    // Each bar row marker must appear exactly once (not duplicated by ghost).
    for (let i = 0; i < (extraRows as number); i++) {
      const marker = barMarker(i);
      expect(lines.filter((l) => l.includes(marker)).length, `${marker} duplicated:\n${dump}`).toBe(1);
    }
    // Status line appears exactly once and sits on the physical last row.
    expect(lines.filter((l) => l.includes(STATUS)).length, `${STATUS} duplicated:\n${dump}`).toBe(1);
    expect(lines[lines.length - 1], `status line not on the last row:\n${dump}`).toContain(STATUS);
    expect(lines.filter((l) => l.includes('ECHO-0000')).length, `echo not exactly-once:\n${dump}`).toBe(1);
  });
});

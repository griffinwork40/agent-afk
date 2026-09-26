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
 * every surviving compositor row inside the guarded scroll (eraseDisplacedRows).
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
/** Footer rows owned by the bars above the status line (health rail). */
const EXTRA_ROWS = 1;
const RAIL = 'FOOTER-RAIL';
const STATUS = 'FOOTER-STATUS';

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

/** Paint the reserved footer at the physical bottom, cursor preserved. */
function footerPaint(rows: number): string {
  return `\x1b[s\x1b[${rows - 1};1H\x1b[2K${RAIL}\x1b[${rows};1H\x1b[2K${STATUS}\x1b[u`;
}

/** Mirrors StatusLine.withFullScrollRegion: full region for the write, then
 *  re-reserve the footer rows and self-heal the footer (flush + afterScrollRestore). */
function makeScrollRegion(stdout: MockStdout) {
  const reserve = (): string => `\x1b[s\x1b[1;${stdout.rows - 1 - EXTRA_ROWS}r\x1b[u`;
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s\x1b[r\x1b[u');
      try {
        return fn();
      } finally {
        stdout.write(reserve() + footerPaint(stdout.rows));
      }
    },
    getExtraRows: (): number => EXTRA_ROWS,
  };
}

async function run(rows: number, contentHug: boolean): Promise<string[]> {
  const stdout = makeStdout(rows);
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));
  const banner = Array.from({ length: 10 }, (_, i) => `BANNER-${i}`);
  stdout.write(`${banner.join('\r\n')}\r\n` + footerPaint(rows));
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    scrollRegion: makeScrollRegion(stdout),
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

describe.each([24, 62])('banner scroll leaves no displaced footer copy (%i rows)', (ROWS) => {
  it.each([true, false])('contentHug=%s: footer appears exactly once, at the bottom', async (contentHug) => {
    const lines = await run(ROWS, contentHug);
    const dump = dumpOf(lines);
    for (const marker of [RAIL, STATUS]) {
      expect(lines.filter((l) => l.includes(marker)).length, `${marker} duplicated:\n${dump}`).toBe(1);
    }
    expect(lines[lines.length - 1], `status line not on the last row:\n${dump}`).toContain(STATUS);
    expect(lines.filter((l) => l.includes('ECHO-0000')).length, `echo not exactly-once:\n${dump}`).toBe(1);
  });
});

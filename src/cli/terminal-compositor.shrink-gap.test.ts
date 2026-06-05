/**
 * Regression: committed content must stay adjacent to the live frame after the
 * frame collapses ("weird gap in scrollback").
 *
 * Root cause (residual of PR #557): commitAbove() Phase 3 paints committed text
 * via absolute CUP at rows ABOVE the live frame top — positioned while the frame
 * is tall (a streaming/tool overlay active). CupFrameRenderer only ever erases
 * its OWN footprint, and evict-on-growth only fires when the frame grows UPWARD.
 * So when the overlay collapses to a short spinner+input frame, the committed
 * text is orphaned at its old high rows while the frame re-anchors to the bottom
 * — opening a large blank gap between them.
 *
 * Fix: TerminalCompositor retains the most-recent above-frame committed block
 * (committedBand) and re-pins it immediately above the frame top on a shrink
 * repaint (repositionCommittedBand), shifting its tracked rows when an
 * intervening growth-evict scrolls it.
 *
 * HARD CORRECTNESS GATE: this test fails on the pre-fix code (a ~12-row blank
 * gap between the committed line and the frame) and passes after the fix
 * (committed line immediately above the spinner).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
};
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

function makeMockStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  return s;
}
function makeMockStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}
function collectWrites(stream: MockStdout): { all: () => string } {
  const chunks: string[] = [];
  stream.on('data', (c: unknown) => chunks.push(String(c)));
  return { all: () => chunks.join('') };
}
function makeScrollRegion(stdout: MockStdout) {
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s');
      stdout.write('\x1b[r');
      stdout.write('\x1b[u');
      try {
        return fn();
      } finally {
        const rows = stdout.rows;
        stdout.write('\x1b[s');
        stdout.write(`\x1b[1;${rows}r`);
        stdout.write('\x1b[u');
      }
    },
    getExtraRows(): number {
      return 0;
    },
  };
}
function termWriteSync(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}
function allLines(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const result: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line != null) result.push(line.translateToString(true));
  }
  return result;
}

const COLS = 80;
const ROWS = 24;
const COMMITTED = 'COMMITTED_TOOL_OUTPUT_LINE';

describe('commitAbove shrink-gap regression', () => {
  it('re-pins committed content adjacent to the frame after the overlay collapses', async () => {
    const stdout = makeMockStdout(COLS, ROWS);
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    const scrollRegion = makeScrollRegion(stdout);
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion,
      anchorRow: 1,
    });
    await c.arm();

    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 400,
      allowProposedApi: true,
      convertEol: true,
    });

    // 1) Tall streaming overlay (12 lines) — the frame grows, its top climbs high.
    const tall = Array.from({ length: 12 }, (_, i) => `stream line ${i}`).join('\n');
    c.setOverlay(tall);

    // 2) Commit a tool-output line above the tall frame (Phase 3 paints it just
    //    above the high frame top).
    c.commitAbove(`${COMMITTED}\n`);

    // 3) Streaming ends → a thinking spinner appears (a 1-row growth that
    //    evict-scrolls the committed line up) and the overlay collapses. This is
    //    the shrink that used to strand the committed line.
    c.setSpinner({ enabled: true });
    c.setOverlay('');

    // 4) Spinner ticks fire further repaints; the frame finishes collapsing to
    //    the bottom (shrink-padding holds the top for one render).
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    await termWriteSync(term, writes.all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    const committedIdx = lines.findIndex((l) => l.includes(COMMITTED));
    expect(committedIdx, `committed line not rendered:\n${dump}`).toBeGreaterThanOrEqual(0);

    // Largest run of blank rows below the committed line (the gap, if any).
    let blankRun = 0;
    let maxBlankRun = 0;
    for (let i = committedIdx + 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === '') {
        blankRun += 1;
        maxBlankRun = Math.max(maxBlankRun, blankRun);
      } else {
        blankRun = 0;
      }
    }
    expect(
      maxBlankRun,
      `large blank gap (${maxBlankRun} rows) between committed content and the frame:\n${dump}`,
    ).toBeLessThanOrEqual(1);

    // Stronger: the committed line sits immediately above the live frame's first
    // content row (the spinner) — at most one breathing-room blank between them.
    const spinnerIdx = lines.findIndex((l) => l.includes('⠋') || /\b(tok|thought)\b/.test(l));
    if (spinnerIdx >= 0) {
      expect(
        spinnerIdx - committedIdx,
        `committed line not adjacent to the frame (committed=${committedIdx}, frame=${spinnerIdx}):\n${dump}`,
      ).toBeLessThanOrEqual(2);
    }

    term.dispose();
    c.disarm();
  }, 15_000);
});

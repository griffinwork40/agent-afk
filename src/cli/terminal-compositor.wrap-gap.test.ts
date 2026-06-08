/**
 * Regression: committed content must stay intact and adjacent to the live frame
 * when an overlay line is WIDER than the terminal and soft-wraps to ≥2 physical
 * rows ("weird gap + missing/overlapping text" on long streamed messages).
 *
 * Root cause (review #592 follow-up): TerminalCompositor.repaint() computed the
 * frame's `desiredTopRow` from the LOGICAL line count (`frameLines.length`),
 * but CupFrameRenderer.render() positions the frame at the PHYSICAL top after
 * wrapAnsi(hard:true) at stdout.columns. When any frame line wraps, physical >
 * logical, so preserveRowsBeforeFrameRender (eviction) and repositionCommittedBand
 * (re-pin) operate on the wrong rows — the committed band lands inside the
 * physical frame footprint and is clobbered by the next render's erase pass,
 * opening a blank gap and dropping committed text.
 *
 * Trigger: src/cli/wrap.ts wrapToWidth uses hard:false (a long unbreakable token
 * — URL, inline-code span, file:line ref — is NOT broken and overruns the width),
 * while CupFrameRenderer wraps hard:true and splits it. The two row counts then
 * diverge.
 *
 * HARD CORRECTNESS GATE: RED on the wrap-blind code (committed marker is dropped
 * or a multi-row blank gap opens above the overlay), GREEN once repaint() derives
 * desiredTopRow from the physical (wrapped) row count.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

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
const MARKER = 'COMMITTED_MARKER_LINE';

describe('repaint wrap-blindness regression', () => {
  it('keeps committed content intact + adjacent when an overlay line soft-wraps', async () => {
    const stdout = makeMockStdout(COLS, ROWS);
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    const scrollRegion = makeScrollRegion(stdout);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion, anchorRow: 1 });
    await c.arm();

    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 400,
      allowProposedApi: true,
      convertEol: true,
    });

    // 1) Commit a recognizable marker block — lands in the band just above the
    //    idle input frame.
    c.commitAbove(`${MARKER}\n`);

    // 2) An overlay arrives whose lines exceed the terminal width. Each long line
    //    soft-wraps to 2 physical rows. The compositor's LOGICAL count (4) is one
    //    short of the PHYSICAL count (7) per long line → desiredTopRow is wrong.
    const long = 'WRAPME_' + 'x'.repeat(COLS + 25); // > COLS → wraps to 2 rows
    const overlay = ['short head', long, long, 'short tail'].join('\n');
    c.setOverlay(overlay);

    // 3) A spinner tick / further repaint (the second repaint the streamer fires
    //    as content lands). This is where the wrong desiredTopRow re-pins the
    //    band into the physical frame and the erase pass clobbers it.
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    await termWriteSync(term, writes.all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    const markerIdx = lines.findIndex((l) => l.includes(MARKER));
    const headIdx = lines.findIndex((l) => l.includes('short head'));
    const tailIdx = lines.findIndex((l) => l.includes('short tail'));

    // (a) The committed marker must survive — exactly one copy, not clobbered.
    expect(lines.filter((l) => l.includes(MARKER)).length, `marker dropped or duplicated:\n${dump}`).toBe(1);

    // (b) Overlay content intact.
    expect(headIdx, `overlay head missing:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(tailIdx, `overlay tail missing:\n${dump}`).toBeGreaterThanOrEqual(0);

    // (c) DISCRIMINATING: the committed marker sits strictly ABOVE the overlay
    //     block. The wrap-blind bug re-pins it INSIDE the physical frame (below
    //     the overlay's first line), interleaving committed + streamed content.
    expect(
      markerIdx,
      `committed marker is interleaved INSIDE the overlay (marker=${markerIdx}, head=${headIdx}):\n${dump}`,
    ).toBeLessThan(headIdx);

    term.dispose();
    c.disarm();
  }, 15_000);
});

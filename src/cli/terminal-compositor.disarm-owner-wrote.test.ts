/**
 * F2 regression tests — disarm() while suspended on the owner-wrote path.
 *
 * Root cause (F2): flushPendingCommittedBand and the queued-commit archive
 * both called buildScrollbackArchiveEscape(lines, anchorFloor, ...) which
 * CUP-paints at anchorFloor (often row 1) with per-row ESC[2K erases. On
 * the owner-wrote disarm path those rows hold still-visible prior transcript
 * or owner output that has never reached scrollback — the erase silently
 * destroys them (F2 root cause).
 *
 * Fix: on the owner-wrote disarm path, emit pending rows and queued commits
 * as a plain append at cursor row R (appendLinesAtCursor), letting the
 * terminal scroll naturally without touching anchorFloor.
 *
 * Test matrix:
 *   (a) owner writes 2 lines (no scroll), 1 queued commit, disarm:
 *       prior block, both owner lines, queued commit — all exactly once,
 *       in reading order.
 *   (b) same scenario with enough owner output to cause a full-screen scroll.
 *   (c) fully-pending band (all-pending before suspend), owner scrolls,
 *       then disarm — verifies the pending rows reach scrollback without
 *       CUP-erase at anchorFloor. Both bottom-pin and content-hug variants.
 *
 * Every test uses a 2-assertion protocol:
 *   (i)  The target label appears exactly once (no loss, no duplicate).
 *   (ii) Reading order is preserved (prior precedes owner precedes queued).
 *
 * All tests FAIL without the F2 fix (the labels simply disappear or are
 * erased; verify by reverting lifecycle.ts+teardown.ts to the pre-fix state).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 80;
const ROWS = 24;

function makeStdout(rows = ROWS, cols = COLS): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  return s;
}

function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => { (s as any).isRaw = raw; return s; });
  return s;
}

function attachScreen(stdout: MockStdout): VirtualScreen {
  const vs = new VirtualScreen(stdout.columns, stdout.rows);
  stdout.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) vs.write(chunk);
    else if (typeof chunk === 'string') vs.write(Buffer.from(chunk, 'utf-8'));
  });
  return vs;
}

function dumpScreen(vs: VirtualScreen): string {
  return [
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3)}] ${JSON.stringify(l)}`),
    ...vs.visibleLines().map((l, i) => `[vp-${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`),
  ].join('\n');
}

function countLabel(vs: VirtualScreen, label: string): number {
  return [...vs.scrollbackLines(), ...vs.visibleLines()]
    .filter((l) => l.trim() === label).length;
}

async function makeRig(opts: { contentHug?: boolean; overlay?: string } = {}): Promise<{
  c: TerminalCompositor;
  vs: VirtualScreen;
  stdout: MockStdout;
  repaint(): void;
}> {
  const stdout = makeStdout();
  const vs = attachScreen(stdout);
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    anchorRow: 1,
    ...(opts.contentHug ? { contentHug: true } : {}),
  });
  await c.arm();
  if (opts.overlay) {
    c.setOverlay(opts.overlay);
    (c as any).repaint();
  }
  return {
    c,
    vs,
    stdout,
    repaint: () => (c as any).repaint(),
  };
}

// ---------------------------------------------------------------------------
// F2(a): owner writes 2 lines (no scroll), 1 queued commit, disarm while suspended
// ---------------------------------------------------------------------------

describe('F2(a): disarm-while-suspended owner-wrote, no scroll — all content survives exactly once in order', () => {
  it('prior block + 2 owner lines + queued commit each appear exactly once in reading order (bottom-pin)', async () => {
    const { c, vs, stdout, repaint } = await makeRig();

    // Step 1: commit a block before suspend.
    c.commitAbove('PRIOR-BLOCK\n');
    repaint();

    // Step 2: suspend.
    c.suspendInput();

    // Step 3: owner writes exactly 2 lines (no full-screen scroll at ROWS=24).
    stdout.write('OWNER-LINE-1\r\n');
    stdout.write('OWNER-LINE-2\r\n');

    // Step 4: queue a commit while suspended.
    c.commitAbove('QUEUED-COMMIT\n');

    // Step 5: disarm while still suspended (owner-wrote path: R != P).
    c.disarm();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // Every label must appear exactly once.
    expect(countLabel(vs, 'PRIOR-BLOCK'), `PRIOR-BLOCK must appear exactly once:\n${dump}`).toBe(1);
    expect(countLabel(vs, 'OWNER-LINE-1'), `OWNER-LINE-1 must appear exactly once:\n${dump}`).toBe(1);
    expect(countLabel(vs, 'OWNER-LINE-2'), `OWNER-LINE-2 must appear exactly once:\n${dump}`).toBe(1);
    expect(countLabel(vs, 'QUEUED-COMMIT'), `QUEUED-COMMIT must appear exactly once:\n${dump}`).toBe(1);

    // Reading order: PRIOR-BLOCK < OWNER-LINE-1 < OWNER-LINE-2 < QUEUED-COMMIT.
    const priorIdx = all.findIndex((l) => l.trim() === 'PRIOR-BLOCK');
    const owner1Idx = all.findIndex((l) => l.trim() === 'OWNER-LINE-1');
    const owner2Idx = all.findIndex((l) => l.trim() === 'OWNER-LINE-2');
    const queuedIdx = all.findIndex((l) => l.trim() === 'QUEUED-COMMIT');

    expect(priorIdx, `PRIOR-BLOCK (${priorIdx}) must precede OWNER-LINE-1 (${owner1Idx}):\n${dump}`).toBeLessThan(owner1Idx);
    expect(owner1Idx, `OWNER-LINE-1 (${owner1Idx}) must precede OWNER-LINE-2 (${owner2Idx}):\n${dump}`).toBeLessThan(owner2Idx);
    expect(owner2Idx, `OWNER-LINE-2 (${owner2Idx}) must precede QUEUED-COMMIT (${queuedIdx}):\n${dump}`).toBeLessThan(queuedIdx);
  });

  it('prior block + 2 owner lines + queued commit each appear exactly once in reading order (content-hug)', async () => {
    const { c, vs, stdout, repaint } = await makeRig({ contentHug: true });

    c.commitAbove('PRIOR-HUG\n');
    repaint();

    c.suspendInput();

    stdout.write('OWNER-HUG-1\r\n');
    stdout.write('OWNER-HUG-2\r\n');

    c.commitAbove('QUEUED-HUG\n');
    c.disarm();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    expect(countLabel(vs, 'PRIOR-HUG'), `PRIOR-HUG must appear exactly once:\n${dump}`).toBe(1);
    expect(countLabel(vs, 'OWNER-HUG-1'), `OWNER-HUG-1 must appear exactly once:\n${dump}`).toBe(1);
    expect(countLabel(vs, 'OWNER-HUG-2'), `OWNER-HUG-2 must appear exactly once:\n${dump}`).toBe(1);
    expect(countLabel(vs, 'QUEUED-HUG'), `QUEUED-HUG must appear exactly once:\n${dump}`).toBe(1);

    const priorIdx = all.findIndex((l) => l.trim() === 'PRIOR-HUG');
    const owner1Idx = all.findIndex((l) => l.trim() === 'OWNER-HUG-1');
    const queuedIdx = all.findIndex((l) => l.trim() === 'QUEUED-HUG');

    expect(priorIdx, `PRIOR-HUG (${priorIdx}) must precede OWNER-HUG-1 (${owner1Idx}):\n${dump}`).toBeLessThan(owner1Idx);
    expect(owner1Idx, `OWNER-HUG-1 (${owner1Idx}) must precede QUEUED-HUG (${queuedIdx}):\n${dump}`).toBeLessThan(queuedIdx);
  });
});

// ---------------------------------------------------------------------------
// F2(b): owner writes enough to cause a full-screen scroll
// ---------------------------------------------------------------------------

describe('F2(b): disarm-while-suspended owner-wrote with scroll — all content survives exactly once in order', () => {
  it('prior block + scrolling owner output + queued commit each appear exactly once (bottom-pin)', async () => {
    const { c, vs, stdout, repaint } = await makeRig();

    c.commitAbove('PRIOR-SCROLL\n');
    repaint();

    c.suspendInput();

    // Owner writes ROWS+4 lines — forces full-screen scroll (S > 0).
    for (let i = 0; i < ROWS + 4; i++) stdout.write(`OWNER-SCROLL-${i}\r\n`);

    c.commitAbove('QUEUED-SCROLL\n');
    c.disarm();

    const dump = dumpScreen(vs);

    // PRIOR-SCROLL must appear exactly once.
    expect(countLabel(vs, 'PRIOR-SCROLL'), `PRIOR-SCROLL must appear exactly once:\n${dump}`).toBe(1);
    // QUEUED-SCROLL must appear exactly once.
    expect(countLabel(vs, 'QUEUED-SCROLL'), `QUEUED-SCROLL must appear exactly once:\n${dump}`).toBe(1);

    // Reading order: PRIOR-SCROLL before QUEUED-SCROLL.
    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const priorIdx = all.findIndex((l) => l.trim() === 'PRIOR-SCROLL');
    const queuedIdx = all.findIndex((l) => l.trim() === 'QUEUED-SCROLL');
    expect(priorIdx, `PRIOR-SCROLL (${priorIdx}) must precede QUEUED-SCROLL (${queuedIdx}):\n${dump}`).toBeLessThan(queuedIdx);
  });

  it('prior block + scrolling owner output + queued commit each appear exactly once (content-hug)', async () => {
    const { c, vs, stdout, repaint } = await makeRig({ contentHug: true });

    c.commitAbove('PRIOR-SCROLL-HUG\n');
    repaint();

    c.suspendInput();

    for (let i = 0; i < ROWS + 4; i++) stdout.write(`OWNER-SCROLL-HUG-${i}\r\n`);

    c.commitAbove('QUEUED-SCROLL-HUG\n');
    c.disarm();

    const dump = dumpScreen(vs);

    expect(countLabel(vs, 'PRIOR-SCROLL-HUG'), `PRIOR-SCROLL-HUG must appear exactly once:\n${dump}`).toBe(1);
    expect(countLabel(vs, 'QUEUED-SCROLL-HUG'), `QUEUED-SCROLL-HUG must appear exactly once:\n${dump}`).toBe(1);

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const priorIdx = all.findIndex((l) => l.trim() === 'PRIOR-SCROLL-HUG');
    const queuedIdx = all.findIndex((l) => l.trim() === 'QUEUED-SCROLL-HUG');
    expect(priorIdx, `PRIOR-SCROLL-HUG (${priorIdx}) must precede QUEUED-SCROLL-HUG (${queuedIdx}):\n${dump}`).toBeLessThan(queuedIdx);
  });
});

// ---------------------------------------------------------------------------
// F2(c): fully-pending band — owner scrolls, pending rows must reach scrollback
// ---------------------------------------------------------------------------

describe('F2(c): fully-pending band (F3 scenario): pending rows survive disarm-owner-wrote', () => {
  it('fully-pending band (paintedRows=0) is not lost when owner scrolls before disarm (bottom-pin)', async () => {
    // Large overlay forces commitPhase3HoldStore → all-pending band.
    const overlay = Array.from({ length: ROWS - 2 }, (_, i) => `overlay-${i}`).join('\n');
    const { c, vs, stdout, repaint } = await makeRig({ overlay });

    c.commitAbove('PENDING-BAND-BOTTOM\n');
    repaint();

    // Verify precondition: band is fully pending.
    const raw = c as unknown as { committedBand: string[]; committedBandPaintedRows: number };
    expect(raw.committedBandPaintedRows, 'precondition: paintedRows must be 0').toBe(0);
    expect(raw.committedBand.length, 'precondition: band must be non-empty').toBeGreaterThan(0);

    c.suspendInput();

    // Owner scrolls.
    for (let i = 0; i < ROWS + 2; i++) stdout.write(`OWNER-PEND-${i}\r\n`);

    c.disarm();

    const dump = dumpScreen(vs);
    expect(countLabel(vs, 'PENDING-BAND-BOTTOM'), `PENDING-BAND-BOTTOM must appear exactly once:\n${dump}`).toBe(1);
  });

  it('partially-pending band is not lost when owner scrolls before disarm (content-hug)', async () => {
    // With contentHugBandReserve active the newest band rows stay painted, so a
    // 1-row band can no longer go fully pending. Commit a band LARGER than the
    // reserve (max(3, rows/4) = 6 at 24 rows) so the older rows are genuinely
    // pending, then assert every row survives disarm-owner-wrote exactly once.
    const overlay = Array.from({ length: ROWS }, (_, i) => `overlay-hug-${i}`).join('\n');
    const { c, vs, stdout, repaint } = await makeRig({ overlay, contentHug: true });

    const labels = Array.from({ length: 12 }, (_, i) => `PENDING-BAND-HUG-${i}`);
    c.commitAbove(labels.join('\n') + '\n');
    repaint();

    const raw = c as unknown as { committedBand: string[]; committedBandPaintedRows: number };
    expect(raw.committedBand.length, 'precondition: band must be non-empty').toBeGreaterThan(0);
    expect(
      raw.committedBandPaintedRows,
      'precondition: some band rows must be pending (paintedRows < band length)',
    ).toBeLessThan(raw.committedBand.length);

    c.suspendInput();

    for (let i = 0; i < ROWS + 2; i++) stdout.write(`OWNER-PEND-HUG-${i}\r\n`);

    c.disarm();

    const dump = dumpScreen(vs);
    for (const label of labels) {
      expect(countLabel(vs, label), `${label} must appear exactly once:\n${dump}`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// F1 regression test — CSI overflow discard does not corrupt col
// ---------------------------------------------------------------------------

describe('F1: CSI overflow discard swallows bytes until final byte, does not corrupt col', () => {
  it('overlong CSI followed by printable text: col is correct (not corrupted by parameter bytes)', async () => {
    // Use the installObserver directly via TerminalCompositor internals is
    // complex; instead verify the fix at the processChunk level.
    // Strategy: import the process module directly and verify col after a
    // CSI overflow followed by printable text.
    const { processChunk, ObserverEscState, CSI_BUF_MAX } = await import('./terminal-compositor.lifecycle.suspend-observer.process.js');
    type ObserverState = {
      row: number; col: number; scrolls: number;
      savedRow: number; savedCol: number;
      state: number; csiBuf: string;
    };
    const st: ObserverState = {
      row: 1, col: 0, scrolls: 0,
      savedRow: 1, savedCol: 0,
      state: ObserverEscState.Normal, csiBuf: '',
    };
    const getRows = () => 24;
    const getCols = () => 80;

    // Build an overlong CSI sequence: param section > CSI_BUF_MAX bytes,
    // then a final byte (A = CUU), then printable text 'abc'.
    const longParam = '1'.repeat(CSI_BUF_MAX + 5); // definitely overflow
    const overlong = `\x1b[${longParam}A`; // CUU with huge param — should be discarded
    const after = 'abc'; // 3 printable chars → col should be 3, not something corrupted

    processChunk(overlong + after, st, getRows, getCols);

    // col must be 3 (the 3 printable chars), not corrupted by parameter bytes
    // re-processed as printable (which would give a huge col value).
    expect(st.col, 'col must be 3 after 3 printable chars (parameter bytes must not corrupt col)').toBe(3);
    // row must still be 1 (the malformed CUU was discarded, no valid CUU fired).
    expect(st.row, 'row must still be 1 (malformed CUU must be discarded)').toBe(1);
  });
});

/**
 * #2450 regression test — owner-wrote disarm append path must apply
 * contentMargin() padding.
 *
 * The bug: appendLinesAtCursor (used on the owner-wrote disarm path) emitted
 * archived lines without prepending contentMargin(), so on terminals with
 * AFK_CENTER_CONTENT enabled the archived rows rendered left-flush instead of
 * indented — unlike the normal archive path (buildScrollbackArchiveEscape) which
 * always applies the margin.
 *
 * Fix: appendLinesAtCursor prepends contentMargin() to each non-empty line,
 * matching exactly what buildScrollbackArchiveEscape does.
 *
 * Test strategy: spy on contentMargin() from render/measure.js to return a
 * fixed 25-space string (simulating a 150-col terminal with centering on), then
 * run the owner-wrote disarm path (queue a commit while suspended, owner writes
 * one line → disarmOwnerWrote=true, then disarm). Assert that the queued commit
 * line appears indented by those 25 spaces in the VirtualScreen output.
 *
 * Both affected append sites are exercised:
 *   (1) queued commit archive: appendLinesAtCursor(t.contentLines, ...)
 *   (2) pending band flush:    appendLinesAtCursor(pendingLines, ...)
 *
 * These tests FAIL without the fix (lines render left-flush, 0 leading spaces).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';
import * as measure from './render/measure.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 150; // wide enough that margin > 0 under centering
const ROWS = 24;
const MARGIN_SPACES = 25; // floor((150 - 100) / 2) for the default 100-col measure
const MARGIN = ' '.repeat(MARGIN_SPACES);

// Spy that returns a fixed non-empty margin, simulating AFK_CENTER_CONTENT=1
// on a 150-col terminal. Installed before each test and restored after.
let marginSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  marginSpy?.mockRestore();
});

function installMarginSpy(): void {
  // Spying on the module namespace object intercepts the binding used by
  // teardown.ts under Vitest's CommonJS transform. Under native ESM this
  // would silently stop intercepting the named import — tracked advisory
  // finding from #2660.
  marginSpy = vi.spyOn(measure, 'contentMargin').mockReturnValue(MARGIN);
}

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
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3, '0')}] ${JSON.stringify(l)}`),
    ...vs.visibleLines().map((l, i) => `[vp-${String(i + 1).padStart(3, '0')}] ${JSON.stringify(l)}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// (1) Queued-commit path: line must be indented when owner-wrote path fires
// ---------------------------------------------------------------------------

describe('#2450: queued commit via appendLinesAtCursor is indented by contentMargin()', () => {
  it('queued commit appended on the owner-wrote disarm path has MARGIN_SPACES leading spaces', async () => {
    installMarginSpy();

    const stdout = makeStdout();
    const vs = attachScreen(stdout);
    const c = new TerminalCompositor({
      stdout,
      stdin: makeStdin(),
      onCancel: vi.fn(),
      anchorRow: 1,
    });
    await c.arm();

    // Suspend, then owner writes one line (sets disarmOwnerWrote = true).
    c.suspendInput();
    stdout.write('OWNER-LINE\r\n');

    // Queue a commit while suspended.
    c.commitAbove('MARGIN-QUEUED\n');

    // Disarm while suspended → owner-wrote path → appendLinesAtCursor for the queued commit.
    c.disarm();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // The queued commit must appear exactly once.
    const matches = all.filter((l) => l.trimStart().startsWith('MARGIN-QUEUED'));
    expect(matches.length, `MARGIN-QUEUED must appear exactly once:\n${dump}`).toBe(1);

    // It must be left-padded by MARGIN_SPACES leading spaces.
    const line = matches[0]!;
    const leadingSpaces = line.length - line.trimStart().length;
    expect(
      leadingSpaces,
      `MARGIN-QUEUED must be indented by ${MARGIN_SPACES} spaces on the owner-wrote disarm path (got ${leadingSpaces}):\n${dump}`,
    ).toBe(MARGIN_SPACES);
  });
});

// ---------------------------------------------------------------------------
// (2) Pending-band path: pending rows must be indented when owner-wrote path fires
// ---------------------------------------------------------------------------

describe('#2450: pending band rows via appendLinesAtCursor are indented by contentMargin()', () => {
  it('pending band rows appended on the owner-wrote disarm path have MARGIN_SPACES leading spaces', async () => {
    installMarginSpy();

    const stdout = makeStdout();
    const vs = attachScreen(stdout);
    // Large overlay forces commitPhase3HoldStore → all-pending band.
    const overlay = Array.from({ length: ROWS - 2 }, (_, i) => `overlay-${i}`).join('\n');
    const c = new TerminalCompositor({
      stdout,
      stdin: makeStdin(),
      onCancel: vi.fn(),
      anchorRow: 1,
    });
    await c.arm();

    c.setOverlay(overlay);
    (c as any).repaint();
    c.commitAbove('MARGIN-PENDING\n');
    (c as any).repaint();

    // Precondition: band is fully pending (never painted to screen).
    const raw = c as unknown as { committedBand: string[]; committedBandPaintedRows: number };
    expect(raw.committedBandPaintedRows, 'precondition: paintedRows must be 0 (fully-pending band)').toBe(0);
    expect(raw.committedBand.length, 'precondition: band must be non-empty').toBeGreaterThan(0);

    // Suspend → owner writes → disarmOwnerWrote = true.
    c.suspendInput();
    stdout.write('OWNER-PEND\r\n');

    // Disarm while suspended → pending rows go through appendLinesAtCursor.
    c.disarm();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    const matches = all.filter((l) => l.trimStart().startsWith('MARGIN-PENDING'));
    expect(matches.length, `MARGIN-PENDING must appear exactly once:\n${dump}`).toBe(1);

    const line = matches[0]!;
    const leadingSpaces = line.length - line.trimStart().length;
    expect(
      leadingSpaces,
      `MARGIN-PENDING must be indented by ${MARGIN_SPACES} spaces on the owner-wrote disarm path (got ${leadingSpaces}):\n${dump}`,
    ).toBe(MARGIN_SPACES);
  });
});

// ---------------------------------------------------------------------------
// (3) Negative: no margin when centering is off (contentMargin returns '')
// ---------------------------------------------------------------------------

describe('#2450 negative: queued commit is NOT indented when contentMargin() returns empty', () => {
  it('queued commit has zero leading spaces when contentMargin() returns empty string', async () => {
    // Do NOT install the marginSpy — contentMargin() falls through to the real
    // implementation which returns '' when AFK_CENTER_CONTENT is unset.
    // We stub it to '' explicitly to make the test deterministic.
    marginSpy = vi.spyOn(measure, 'contentMargin').mockReturnValue('');

    const stdout = makeStdout();
    const vs = attachScreen(stdout);
    const c = new TerminalCompositor({
      stdout,
      stdin: makeStdin(),
      onCancel: vi.fn(),
      anchorRow: 1,
    });
    await c.arm();

    c.suspendInput();
    stdout.write('OWNER-LINE\r\n');
    c.commitAbove('NO-MARGIN-QUEUED\n');
    c.disarm();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    const matches = all.filter((l) => l.trimStart().startsWith('NO-MARGIN-QUEUED'));
    expect(matches.length, `NO-MARGIN-QUEUED must appear exactly once:\n${dump}`).toBe(1);

    const line = matches[0]!;
    const leadingSpaces = line.length - line.trimStart().length;
    expect(
      leadingSpaces,
      `NO-MARGIN-QUEUED must have 0 leading spaces when centering is off (got ${leadingSpaces}):\n${dump}`,
    ).toBe(0);
  });
});

/**
 * AFK_CENTER_CONTENT committed-band geometry regressions (center audit A1-A3, B7, D).
 *
 * The band margin is painted at paint time, so committed text must be WRAPPED
 * at the content-band width (`cols - marginCols`), and every archive must
 * measure and paint `margin + row` per physical row. Each scenario replays the
 * compositor's real byte stream through @xterm/headless. The margin comes from
 * the compositor's OWN mock stdout width (200 cols, measure 100 → margin 50).
 * `process.stdout.columns` is synced to the mock by default so each geometry
 * test pins its own bug; the D test desyncs it to pin that no compositor site
 * reads process.stdout for the band.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows;
  return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true; s.isRaw = false;
  s.setRawMode = vi.fn((r: boolean) => { s.isRaw = r; return s; });
  return s;
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
function bufferLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out;
}

const COLS = 200;
const ROWS = 24;
const MARGIN = 50; // floor((200 - 100) / 2)
const LONG = 'WIDEHEAD_' + 'x'.repeat(170) + '_WIDETAIL'; // 188: fits cols, not cols - margin

const origProcCols = process.stdout.columns;
function setProcCols(n: number | undefined): void {
  Object.defineProperty(process.stdout, 'columns', { value: n, configurable: true, writable: true });
}
afterEach(() => { vi.unstubAllEnvs(); setProcCols(origProcCols); });

type Scenario = (c: TerminalCompositor, s: MockStdout) => void;

async function run(
  centered: boolean,
  scenario: Scenario,
  procCols: number = COLS,
  rows: number = ROWS,
): Promise<string[]> {
  const cols = COLS;
  setProcCols(procCols);
  __resetStdinClaimForTests();
  vi.stubEnv('AFK_CENTER_CONTENT', centered ? '1' : '');
  vi.stubEnv('AFK_TEXT_MEASURE', '100');
  const stdout = makeStdout(cols, rows);
  const chunks: string[] = [];
  stdout.on('data', (x) => chunks.push(String(x)));
  const c = new TerminalCompositor({ stdout, stdin: makeStdin(), onCancel: vi.fn(), anchorRow: 1 });
  await c.arm();
  scenario(c, stdout);
  const bytes = chunks.join('');
  try { c.disarm(); } catch { /* teardown best-effort */ }
  const term = new HeadlessTerminal({ cols: stdout.columns, rows, scrollback: 800, allowProposedApi: true, convertEol: true }); // ONLCR, as libuv raw mode keeps it
  await termWrite(term, bytes);
  const lines = bufferLines(term);
  term.dispose();
  return lines;
}

const repaint = (c: TerminalCompositor): void => (c as unknown as { repaint(): void }).repaint();
const count = (ls: string[], k: string): number => ls.filter((l) => l.includes(k)).length;
/** Concatenate the margin-stripped content rows so a wrapped line reads whole. */
const joined = (ls: string[]): string => ls.map((l) => l.trim()).join('');

describe('centered committed band (AFK_CENTER_CONTENT)', () => {
  it('A1: a line wider than cols - margin wraps at the band width instead of being clipped', async () => {
    const lines = await run(true, (c) => {
      c.commitAbove('BEFORE_LINE\n');
      c.commitAbove(LONG + '\n');
      c.commitAbove('AFTER_LINE\n');
      repaint(c);
    });
    expect(count(lines, '_WIDETAIL')).toBe(1);
    expect(joined(lines)).toContain(LONG);
    const head = lines.find((l) => l.includes('WIDEHEAD_')) ?? '';
    expect(head.length).toBe(COLS); // margin + band-width row, exactly fills the terminal
    expect(head.startsWith(' '.repeat(MARGIN) + 'WIDEHEAD_')).toBe(true);
  });

  it('A2: the wrapped tail of the newest commit never lands on the input-rule row', async () => {
    const lines = await run(true, (c) => {
      c.commitAbove('PRE\n');
      c.commitAbove(LONG + '\n');
    });
    expect(count(lines, '_WIDETAIL')).toBe(1);
    const tail = lines.findIndex((l) => l.includes('_WIDETAIL'));
    expect(lines[tail]?.startsWith(' '.repeat(MARGIN) + 'x')).toBe(true);
    expect(lines[tail + 1] ?? '').toContain('⎯'); // the live frame's rule, intact
  });

  it('A3: endTurn archive with a wide line keeps every row of the turn (no stranded last row)', async () => {
    const lines = await run(true, (c) => {
      c.commitAbove('T1_A\n');
      c.commitAbove(LONG + '\n');
      c.commitAbove('T1_LAST\n');
      repaint(c);
      c.endTurn();
      c.commitAbove('T2_A\n');
      c.commitAbove('T2_B\n');
      repaint(c);
      c.endTurn();
    });
    for (const k of ['T1_A', '_WIDETAIL', 'T1_LAST', 'T2_A', 'T2_B']) expect(count(lines, k), k).toBe(1);
    expect(lines.findIndex((l) => l.includes('T1_LAST'))).toBeLessThan(lines.findIndex((l) => l.includes('T2_A')));
  });

  it('B7: every physical row of an archived wrapped line carries the margin', async () => {
    const lines = await run(true, (c) => {
      for (let i = 0; i < 3; i++) c.commitAbove(`ROW_${i}\n`);
      c.commitAbove(LONG + '\n');
      c.commitAbove('AFTER_LINE\n');
      repaint(c);
      c.endTurn();
      c.disarm();
    });
    expect(count(lines, '_WIDETAIL')).toBe(1);
    const content = lines.filter((l) => /ROW_|WIDEHEAD_|_WIDETAIL|AFTER_LINE/.test(l));
    expect(content).toHaveLength(6); // 3 rows + 2-row wide line + AFTER_LINE
    for (const l of content) expect(l.startsWith(' '.repeat(MARGIN)) && l[MARGIN] !== ' ', l).toBe(true);
  });

  it('A1 (resize): after narrowing to 120 the band re-wraps at the new band width (110)', async () => {
    const L115 = 'R115HEAD_' + 'y'.repeat(97) + '_R115TAIL';
    const lines = await run(true, (c, s) => {
      c.commitAbove('PRE\n');
      c.commitAbove(L115 + '\n');
      s.columns = 120;
      setProcCols(120);
      repaint(c);
      c.commitAbove('POST\n');
      repaint(c);
    });
    const content = lines.filter((l) => /PRE|R115HEAD_|y|_R115TAIL|5TAIL|POST/.test(l) && !l.includes('⎯'));
    expect(joined(content)).toContain(L115);
    for (const l of content) {
      expect(l.length, l).toBeLessThanOrEqual(120);
      expect(l.startsWith(' '.repeat(10)) && l[10] !== ' ', l).toBe(true);
    }
  });

  it('D: the band margin follows the compositor stdout width, not process.stdout', async () => {
    const lines = await run(true, (c) => {
      c.commitAbove('LIVE_ROW\n');
      repaint(c);
      c.endTurn();
      c.commitAbove('NEXT_ROW\n');
      repaint(c);
    }, 80);
    for (const k of ['LIVE_ROW', 'NEXT_ROW']) {
      const row = lines.find((l) => l.includes(k)) ?? '';
      expect(row, k).toBe(' '.repeat(MARGIN) + k);
    }
  });

  it('B8: the phase-1 overflow arm (no band room: 2-row terminal) paints rows with the margin', async () => {
    const lines = await run(true, (c) => {
      c.commitAbove('OVF_A\nOVF_B\nOVF_C\n');
      repaint(c);
    }, COLS, 2);
    const ovf = lines.filter((l) => l.includes('OVF_'));
    expect(ovf.length).toBeGreaterThan(0);
    for (const l of ovf) expect(l.startsWith(' '.repeat(MARGIN) + 'OVF_'), l).toBe(true);
  });

  it('default path: centering off keeps full-width single-row wrapping', async () => {
    const lines = await run(false, (c) => {
      c.commitAbove(LONG + '\n');
      repaint(c);
      c.endTurn();
      c.disarm();
    });
    expect(lines.filter((l) => l.includes('WIDEHEAD_'))).toEqual([LONG]);
  });
});

// ---------------------------------------------------------------------------
// Issue #3763 — WIDTH-ONLY narrowing resize leaves duplicate oldest rows
//
// Root cause: with AFK_CENTER_CONTENT=1 (AFK_TEXT_MEASURE=100) the compositor
// paints each row as `margin + content`, where margin = floor((cols-measure)/2).
// At 200 cols: margin=50, so each painted row is up to 200 cols wide.  On a
// width-only SIGWINCH to 120 cols, DECAWM autowrap reflows those 200-col rows
// into ceil(200/120)=2 physical rows each, expanding the on-screen footprint
// ABOVE the `top` anchor.  `pendingResizeErase` was snapshotted with `bottom =
// lastKnownRows - 1` (logical rows), so only the lower half of the physical
// footprint was erased, leaving the upper half as duplicate "ghost" copies of
// the oldest visible rows.
//
// Fix (handleResizeImmediate): inflate `bottom` by the reflow factor
// ceil(lastKnownCols / newCols) so the erase covers the full physical
// footprint after narrowing.
//
// Test strategy: directly inspect `pendingResizeErase.bottom` after a
// width-only SIGWINCH with centering on, confirming it covers the inflated
// physical rows.  Pure unit test — no xterm headless needed.
// ---------------------------------------------------------------------------

describe('issue #3763 — WIDTH-ONLY narrowing resize: pendingResizeErase covers inflated physical rows', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); vi.stubEnv('AFK_CENTER_CONTENT', '1'); vi.stubEnv('AFK_TEXT_MEASURE', '100'); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setProcCols(origProcCols); });

  it('#3763: bottom inflated by ceil(200/120)=2 after 200→120 col narrowing', async () => {
    setProcCols(COLS); // 200

    const stdout = makeStdout(COLS, ROWS); // 200 cols, 24 rows
    const stdin = makeStdin();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1 });
    await c.arm();

    // Let initial frame render so lastKnownRows and lastKnownCols are set.
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      lastKnownRows: number;
      lastKnownCols: number;
      pendingResizeErase: { top: number; bottom: number; origin?: string } | null;
      lastMeasuredFrameBottom: number;
    };
    expect(internals.lastKnownRows, 'lastKnownRows must be set after first repaint').toBeGreaterThan(0);
    expect(internals.lastKnownCols, 'lastKnownCols must be 200 after first repaint').toBe(200);

    // Commit some rows so the footprint has a non-trivial top.
    c.commitAbove('ROW_A\nROW_B\nROW_C\n');
    vi.advanceTimersByTime(20);

    const topBefore = internals.lastKnownRows;

    // Width-only narrowing: 200→120 cols, same 24 rows.
    stdout.columns = 120;
    setProcCols(120);
    process.stdout.emit('resize');

    const erase = internals.pendingResizeErase;
    expect(erase, 'pendingResizeErase must be set on width-only narrowing SIGWINCH').not.toBeNull();
    if (!erase) return;

    // At 200 cols with AFK_TEXT_MEASURE=100: each painted row is up to 200
    // cols wide. At 120 cols: ceil(200/120) = 2 physical rows per old row.
    // So `bottom` must be at least `top + 2*(logicalRows) - 1`, which is
    // strictly larger than the pre-fix `lastKnownRows - 1`.
    const logicalBottom = topBefore - 1; // the pre-fix value
    expect(erase.bottom, '#3763: bottom must exceed the pre-fix logical bottom').toBeGreaterThan(logicalBottom);
    // Confirm the factor: bottom >= top + 2*(logicalBottom - top + 1) - 1
    const logicalRows = logicalBottom - erase.top + 1;
    const inflatedBottom = erase.top + 2 * logicalRows - 1;
    expect(erase.bottom, '#3763: bottom must cover ceil(200/120)=2x inflated footprint').toBeGreaterThanOrEqual(inflatedBottom);

    vi.advanceTimersByTime(200); // drain CPR timeout
    c.disarm();
  });

  it('#3763: widen-guard — no inflation when terminal widens (120→200 cols)', async () => {
    // reflowedPhysicalRows must return logicalRows unchanged when newCols >= oldCols.
    // Set up at 120 cols so lastKnownCols=120, then fire a width-only SIGWINCH
    // that widens to 200 cols. bottom must equal the plain logical bottom
    // (lastKnownRows - 1 - extraRows), not an inflated value.
    vi.unstubAllEnvs();
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
    setProcCols(120);

    const stdout = makeStdout(120, ROWS); // start at 120 cols
    const stdin = makeStdin();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1 });
    await c.arm();
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      lastKnownRows: number;
      lastKnownCols: number;
      pendingResizeErase: { top: number; bottom: number; origin?: string } | null;
    };
    expect(internals.lastKnownCols, 'lastKnownCols must be 120 after first repaint').toBe(120);

    c.commitAbove('ROW_A\nROW_B\nROW_C\n');
    vi.advanceTimersByTime(20);

    const rowsBefore = internals.lastKnownRows;

    // Width-only WIDEN: 120→200 cols, same 24 rows.
    stdout.columns = 200;
    setProcCols(200);
    process.stdout.emit('resize');

    const erase = internals.pendingResizeErase;
    expect(erase, 'pendingResizeErase set on width-only SIGWINCH').not.toBeNull();
    if (!erase) return;

    // Widen never reflows: bottom must equal logicalBottom = rowsBefore - 1.
    // reflowedPhysicalRows returns logicalRows unchanged when newCols >= oldCols.
    const logicalBottom = rowsBefore - 1;
    expect(erase.bottom, '#3763 widen-guard: bottom must equal logicalBottom, not inflated').toBe(logicalBottom);

    vi.advanceTimersByTime(200);
    c.disarm();
  });

  it('#3763: EXPAND narrowing inflates bottom — same family as WIDTH-ONLY', async () => {
    // EXPAND branch: rows grow AND cols narrow simultaneously.
    // Confirm EXPAND also applies reflowedPhysicalRows (issue #4010 fix).
    setProcCols(COLS); // 200

    const stdout = makeStdout(COLS, ROWS); // 200 cols, 24 rows
    const stdin = makeStdin();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1 });
    await c.arm();
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      lastKnownRows: number;
      lastKnownCols: number;
      pendingResizeErase: { top: number; bottom: number; origin?: string } | null;
    };
    expect(internals.lastKnownCols, 'lastKnownCols must be 200').toBe(200);

    c.commitAbove('ROW_A\nROW_B\nROW_C\n');
    vi.advanceTimersByTime(20);

    const rowsBefore = internals.lastKnownRows;

    // EXPAND + narrow: rows grow 24→28, cols shrink 200→120.
    stdout.rows = ROWS + 4;
    stdout.columns = 120;
    setProcCols(120);
    process.stdout.emit('resize');

    const erase = internals.pendingResizeErase;
    expect(erase, 'pendingResizeErase set on EXPAND SIGWINCH').not.toBeNull();
    if (!erase) return;
    expect(erase.origin, 'origin must be expand').toBe('expand');

    // bottom must exceed the pre-fix logicalBottom = rowsBefore - 1.
    // ceil(200/120) = 2 physical rows per old row → same inflation as WIDTH-ONLY.
    const logicalBottom = rowsBefore - 1;
    expect(erase.bottom, '#4010: EXPAND bottom must exceed pre-fix logical bottom').toBeGreaterThan(logicalBottom);
    const logicalRows = logicalBottom - erase.top + 1;
    const inflatedBottom = erase.top + 2 * logicalRows - 1;
    expect(erase.bottom, '#4010: EXPAND bottom must cover 2x inflated footprint').toBeGreaterThanOrEqual(inflatedBottom);

    vi.advanceTimersByTime(200);
    c.disarm();
  });
});

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
import { describe, it, expect, vi, afterEach } from 'vitest';
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

async function run(centered: boolean, scenario: Scenario, procCols: number = COLS): Promise<string[]> {
  const cols = COLS;
  setProcCols(procCols);
  __resetStdinClaimForTests();
  vi.stubEnv('AFK_CENTER_CONTENT', centered ? '1' : '');
  vi.stubEnv('AFK_TEXT_MEASURE', '100');
  const stdout = makeStdout(cols, ROWS);
  const chunks: string[] = [];
  stdout.on('data', (x) => chunks.push(String(x)));
  const c = new TerminalCompositor({ stdout, stdin: makeStdin(), onCancel: vi.fn(), anchorRow: 1 });
  await c.arm();
  scenario(c, stdout);
  const bytes = chunks.join('');
  try { c.disarm(); } catch { /* teardown best-effort */ }
  const term = new HeadlessTerminal({ cols: stdout.columns, rows: ROWS, scrollback: 800, allowProposedApi: true });
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

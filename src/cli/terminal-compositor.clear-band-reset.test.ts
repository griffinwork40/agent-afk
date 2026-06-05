/**
 * Regression: `/clear` must not let the previous session's transcript reappear
 * when the next slash-command menu pops up.
 *
 * Root cause: clearScreen() (bootstrap.ts) physically wipes the screen
 * (`\x1b[3J\x1b[2J\x1b[H`) and zeroes the overlay, but historically left the
 * compositor's committedBand populated. A surviving band is CUP-painted back
 * onto the freshly-cleared screen by repositionCommittedBand() on the next
 * shrink repaint — which a slash menu open→collapse triggers — resurrecting
 * the prior transcript.
 *
 * Fix: clearScreen() calls compositor.resetCommittedBand() (which drops the
 * band + commit-presence flags) BEFORE the physical wipe, so the next shrink
 * repaint has nothing to re-pin.
 *
 * HARD CORRECTNESS GATE: the `without the band reset` test resurrects the prior
 * transcript (the bug, proving the repro is live), while the `resetCommittedBand`
 * test does not (the fix).
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
const PRIOR = 'PRIOR_SESSION_TRANSCRIPT_LINE';

type Internals = {
  repaint(): void;
  resetCommittedBand(): void;
  committedBand: string[];
};

/**
 * Drive the reported scenario: a prior session committed a transcript line
 * above a tall streaming frame, then `/clear` runs, then the user opens a
 * slash menu (overlay grows) which collapses again (the shrink repaint).
 *
 * @param applyBandReset  when true, simulate the fix: call resetCommittedBand()
 *                        at the /clear point (clearScreen does this before the
 *                        physical wipe).
 */
async function runClearScenario(
  applyBandReset: boolean,
): Promise<{ bandAfterClear: string[]; rendered: string[] }> {
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
  const internals = c as unknown as Internals;

  // 1) Prior session: a committed transcript line painted just above the short
  //    input frame at the bottom — the realistic /clear geometry, where the
  //    last above-frame commit sits LOW (adjacent to the input line), not high
  //    above a tall streaming overlay. A modest later growth keeps it on-screen.
  c.commitAbove(`${PRIOR}\n`);

  // 2) /clear: zero the overlay, (fix) drop the committed band, then perform
  //    the physical screen wipe. This mirrors clearScreen() in bootstrap.ts —
  //    setOverlay('') → resetCommittedBand() → `\x1b[3J\x1b[2J\x1b[H`.
  c.setOverlay('');
  if (applyBandReset) internals.resetCommittedBand();
  const bandAfterClear = [...internals.committedBand];
  stdout.write('\x1b[3J\x1b[2J\x1b[H');

  // 3) The user immediately opens a slash menu (overlay grows a few rows,
  //    pushing the low band up but keeping it in the viewport) which then
  //    collapses as they filter/dismiss. The collapse is the shrink repaint
  //    that re-pins a surviving band onto the just-cleared screen.
  c.setOverlay(['/clear', '/compact', '/help'].join('\n'));
  internals.repaint();
  c.setOverlay('');
  internals.repaint();
  internals.repaint();

  await termWriteSync(term, writes.all());
  const rendered = allLines(term);
  term.dispose();
  c.disarm();
  return { bandAfterClear, rendered };
}

describe('/clear committed-band reset (transcript-resurrection regression)', () => {
  it('WITHOUT the band reset, the prior transcript survives /clear and is re-pinned on the next shrink (the bug)', async () => {
    const { bandAfterClear, rendered } = await runClearScenario(false);
    const dump = rendered.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    // The band survives the clear (no reset called)...
    expect(
      bandAfterClear.some((l) => l.includes(PRIOR)),
      'expected the committed band to survive /clear when no reset is applied',
    ).toBe(true);
    // ...and the surviving band is CUP-painted back onto the cleared screen.
    expect(
      rendered.some((l) => l.includes(PRIOR)),
      `expected the prior transcript to be resurrected (proves the repro is live):\n${dump}`,
    ).toBe(true);
  }, 15_000);

  it('resetCommittedBand drops the band so /clear cannot resurrect the prior transcript (the fix)', async () => {
    const { bandAfterClear, rendered } = await runClearScenario(true);
    const dump = rendered.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    // The band is dropped at the /clear point.
    expect(bandAfterClear, 'resetCommittedBand must empty the committed band').toEqual([]);
    // The prior transcript must NOT reappear after the menu opens and collapses.
    expect(
      rendered.some((l) => l.includes(PRIOR)),
      `prior transcript resurrected after /clear despite the band reset:\n${dump}`,
    ).toBe(false);
  }, 15_000);
});

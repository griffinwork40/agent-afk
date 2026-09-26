/**
 * Content-hug placement (terminal-compositor.content-hug.ts) — whole-buffer
 * gap invariants, checked against a real headless xterm (viewport AND native
 * scrollback), at the 24-row and 62-row sizes the gap was reported on.
 *
 * Invariant under test (the two rules the placement exists to guarantee):
 *   (1) no blank row between the latest committed line and the live frame;
 *   (2) no unintended blank row anywhere in committed history — viewport or
 *       scrollback — i.e. committed lines (which contain no blank lines of
 *       their own here) form one contiguous, exactly-once, in-order run.
 * Plus: rows below the frame are blank (no ghost frame rows left behind).
 *
 * History: #2182 top-shifted a short band and erased the rows between it and
 * the frame (a 36-row gap on a 62-row pane); before it, a bottom-aligned band
 * left blank rows ABOVE itself that became permanent scrollback gaps after a
 * grow-then-shrink. The earlier content-following regime was removed after a
 * first-commit misroute (duplicated echo, lost card body) — the exactly-once
 * checks below guard that failure mode.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 80;

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
function makeScrollRegion(stdout: MockStdout) {
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s\x1b[r\x1b[u');
      try {
        return fn();
      } finally {
        stdout.write(`\x1b[s\x1b[1;${stdout.rows}r\x1b[u`);
      }
    },
    getExtraRows(): number {
      return 0;
    },
  };
}

interface Rig {
  c: TerminalCompositor;
  repaint(): void;
  /** Whole buffer (scrollback + viewport), right-trimmed. */
  lines(): Promise<string[]>;
  viewportTop(): number;
  dispose(): void;
}

async function makeRig(rows: number, opts: { anchorRow?: number; preamble?: string } = {}): Promise<Rig> {
  const stdout = makeStdout(rows);
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));
  if (opts.preamble) stdout.write(opts.preamble);
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    scrollRegion: makeScrollRegion(stdout),
    anchorRow: opts.anchorRow ?? 1,
    contentHug: true,
  });
  await c.arm();
  const term = new HeadlessTerminal({ cols: COLS, rows, scrollback: 2000, allowProposedApi: true, convertEol: true });
  let fed = 0;
  const feed = async (): Promise<void> => {
    const data = chunks.slice(fed).join('');
    fed = chunks.length;
    await new Promise<void>((r) => term.write(data, r));
  };
  return {
    c,
    repaint: () => (c as unknown as { repaint(): void }).repaint(),
    async lines() {
      await feed();
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
      return out;
    },
    viewportTop: () => term.buffer.active.baseY,
    dispose() {
      term.dispose();
      c.disarm();
    },
  };
}

const dumpOf = (lines: string[]): string =>
  lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

/**
 * Assert the gap invariants over the whole buffer. `committed` is every line
 * committed so far, in order. Returns the buffer index of the frame's first row.
 */
function assertNoGaps(lines: string[], committed: string[], frameMarker: string): number {
  const dump = dumpOf(lines);
  const idx = committed.map((m) => lines.findIndex((l) => l.includes(m)));
  committed.forEach((m, i) => {
    expect(idx[i], `committed line ${m} missing:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(lines.filter((l) => l.includes(m)).length, `committed line ${m} not exactly-once:\n${dump}`).toBe(1);
  });
  // (2) contiguous, in order: each committed line directly follows the previous.
  for (let i = 1; i < idx.length; i++) {
    expect(idx[i], `blank/foreign row between ${committed[i - 1]} and ${committed[i]}:\n${dump}`).toBe(idx[i - 1]! + 1);
  }
  // (1) the frame's first row directly follows the last committed line.
  const frameIdx = lines.findIndex((l, i) => i > idx[idx.length - 1]! && l.includes(frameMarker));
  expect(frameIdx, `frame marker ${frameMarker} not found below content:\n${dump}`).toBeGreaterThan(0);
  const lastCommitted = idx[idx.length - 1]!;
  const between = lines.slice(lastCommitted + 1, frameIdx);
  expect(between.every((l) => l.trim() !== ''), `blank row between content and frame:\n${dump}`).toBe(true);
  return frameIdx;
}

const PROMPT = '⎯';

describe.each([24, 62])('content-hug placement (%i rows)', (ROWS) => {
  it('overlay collapse after a commit: committed line hugs the frame, no blank rows above it', async () => {
    const rig = await makeRig(ROWS);
    rig.c.setOverlay(Array.from({ length: 12 }, (_, i) => `stream line ${i}`).join('\n'));
    rig.c.commitAbove('COMMIT-0001\n');
    rig.c.setSpinner({ enabled: true });
    rig.c.setOverlay('');
    rig.repaint();
    rig.repaint();
    const lines = await rig.lines();
    const dump = dumpOf(lines);
    const top = rig.viewportTop();
    // The committed line is the first viewport row: nothing blank above it.
    expect(lines[top] ?? '', `blank rows above the committed line:\n${dump}`).toContain('COMMIT-0001');
    // The frame sits directly below it (spinner row is the frame's first row).
    expect((lines[top + 1] ?? '').trim(), `gap between content and frame:\n${dump}`).not.toBe('');
    rig.dispose();
  });

  it('many commits under a tall overlay, then collapse: exactly-once, contiguous history, zero gap', async () => {
    const rig = await makeRig(ROWS);
    const committed: string[] = [];
    rig.c.setSpinner({ enabled: true });
    for (let n = 0; n < ROWS * 2; n++) {
      // Oscillate the overlay height so the frame repeatedly grows and shrinks.
      const h = (n % 5) * 3;
      rig.c.setOverlay(Array.from({ length: h }, (_, i) => `live ${n}.${i}`).join('\n'));
      const m = `COMMIT-${String(n).padStart(4, '0')}`;
      committed.push(m);
      rig.c.commitAbove(`${m}\n`);
      rig.repaint();
    }
    rig.c.setOverlay('');
    rig.c.setSpinner({ enabled: false });
    rig.repaint();
    rig.repaint();
    const lines = await rig.lines();
    assertNoGaps(lines, committed, PROMPT);
    rig.dispose();
  });

  it('frame shrink leaves blank rows BELOW the prompt, never ghost frame rows', async () => {
    const rig = await makeRig(ROWS);
    rig.c.commitAbove('COMMIT-A\n');
    rig.c.setOverlay(Array.from({ length: 6 }, (_, i) => `GHOST-OVERLAY-${i}`).join('\n'));
    rig.c.setSpinner({ enabled: true });
    rig.repaint();
    rig.c.setOverlay('');
    rig.c.setSpinner({ enabled: false });
    rig.repaint();
    const lines = await rig.lines();
    const dump = dumpOf(lines);
    expect(lines.some((l) => l.includes('GHOST-OVERLAY')), `ghost overlay rows left behind:\n${dump}`).toBe(false);
    assertNoGaps(lines, ['COMMIT-A'], PROMPT);
    rig.dispose();
  });

  it('a block that fills the viewport scrolls into history contiguously, then the frame hugs the rest', async () => {
    const rig = await makeRig(ROWS);
    const committed: string[] = [];
    const block = Array.from({ length: ROWS + 7 }, (_, i) => `BIG-${String(i).padStart(4, '0')}`);
    committed.push(...block);
    rig.c.setSpinner({ enabled: true });
    rig.c.commitAbove(`${block.join('\n')}\n`);
    rig.repaint();
    rig.c.commitAbove('AFTER-0000\n');
    committed.push('AFTER-0000');
    rig.c.setSpinner({ enabled: false });
    rig.repaint();
    const lines = await rig.lines();
    assertNoGaps(lines, committed, PROMPT);
    rig.dispose();
  });

  it('full viewport: a tall overlay grows then collapses and the prompt returns to the bottom (no bobbing)', async () => {
    const rig = await makeRig(ROWS);
    const committed = Array.from({ length: ROWS * 2 }, (_, i) => `FILL-${String(i).padStart(4, '0')}`);
    rig.c.commitAbove(`${committed.join('\n')}\n`);
    rig.repaint();
    // Thinking-preview style cycle: overlay grows upward over the band, then collapses.
    rig.c.setSpinner({ enabled: true });
    rig.c.setOverlay(Array.from({ length: 8 }, (_, i) => `THINK-${i}`).join('\n'));
    rig.repaint();
    // Turn-end order as stream-renderer dispose performs it: spinner off, then overlay.
    rig.c.setSpinner({ enabled: false });
    rig.c.setOverlay('');
    rig.repaint();
    const lines = await rig.lines();
    const frameIdx = assertNoGaps(lines, committed, PROMPT);
    const dump = dumpOf(lines);
    expect(lines.some((l) => l.includes('THINK-')), `ghost overlay rows:\n${dump}`).toBe(false);
    // The prompt sits on the last compositor row (absoluteBottom = rows - 1):
    // hidden-on-growth rows were repainted, so the band still fills the viewport.
    expect(frameIdx - rig.viewportTop(), `prompt left the bottom after collapse:\n${dump}`).toBe(ROWS - 2);
    rig.dispose();
  });

  it('first commit after a banner: banner, committed content and frame are contiguous', async () => {
    const banner = Array.from({ length: 10 }, (_, i) => `BANNER-${i}`);
    const rig = await makeRig(ROWS, { anchorRow: banner.length + 1, preamble: `${banner.join('\r\n')}\r\n` });
    rig.repaint();
    rig.c.commitAbove('ECHO-0000\n');
    rig.c.setSpinner({ enabled: true });
    rig.c.setOverlay(['card 1', 'card 2', 'card 3'].join('\n'));
    rig.repaint();
    rig.c.commitAbove('CARD-0001\nCARD-0002\n');
    rig.c.setOverlay('');
    rig.c.setSpinner({ enabled: false });
    rig.repaint();
    const lines = await rig.lines();
    assertNoGaps(lines, [...banner, 'ECHO-0000', 'CARD-0001', 'CARD-0002'], PROMPT);
    rig.dispose();
  });
});

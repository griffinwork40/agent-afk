/**
 * Issue: in content-hug mode, when a large overlay (e.g. a 5+ subagent fan-out
 * panel) causes the hugging frame to rise over the committed band, the covered
 * band rows go PENDING — hidden from both screen and scrollback — instead of
 * being archived. The user's just-submitted prompt echo vanishes for the whole
 * duration of the fan-out (the hide-on-growth pending-rows invariant in
 * terminal-compositor.content-hug.ts:115-137).
 *
 * Fix: `contentHugBandReserve` subtracts `bandReserveRows` from the overlay
 * budget in `computeViewportLayout` and `computePickerViewportLayout`, keeping
 * the newest committed band rows on screen by shortening the frame.
 *
 * This file contains a compositor-level regression test:
 *   (A) With a 24-row terminal and a 30-line overlay, the committed echo marker
 *       ECHO-MARKER-123 (the user's prompt echo) must remain visible on screen
 *       WHILE the overlay is tall — the fix prevents the frame from rising over
 *       the band row.
 *   (B) After the overlay collapses, ECHO-MARKER-123 must appear exactly once
 *       across scrollback + viewport (no duplication, no loss).
 *
 * Geometry (24 rows, anchorRow=1, no banner, no extraRows):
 *   absoluteBottom=23, fixedRows≈2 (gap+input), avail≈21.
 *   30-line overlay without reserve → frame rises 21 rows → covers the band.
 *   With reserve ≈ max(3, floor(24/4)) = 6 → budget=15, frame is shorter,
 *   newest 6 band rows stay on screen.
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
const ROWS = 24;
const ECHO_MARKER = 'ECHO-MARKER-123';

function makeStdout(): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = ROWS;
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
      try { return fn(); } finally { stdout.write(`\x1b[s\x1b[1;${stdout.rows}r\x1b[u`); }
    },
    getExtraRows(): number { return 0; },
  };
}

interface Rig {
  c: TerminalCompositor;
  repaint(): void;
  lines(): Promise<string[]>;
  viewportTop(): number;
  dispose(): void;
}

async function makeRig(): Promise<Rig> {
  const stdout = makeStdout();
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));

  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    scrollRegion: makeScrollRegion(stdout),
    anchorRow: 1,
    contentHug: true,
  });
  await c.arm();

  const term = new HeadlessTerminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 2000,
    allowProposedApi: true,
    convertEol: true,
  });
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
      for (let i = 0; i < b.length; i++) {
        out.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
      }
      return out;
    },
    viewportTop: () => term.buffer.active.baseY,
    dispose() { term.dispose(); c.disarm(); },
  };
}

const dumpOf = (lines: string[]): string =>
  lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

describe('hug-band-reserve: prompt echo stays visible under a tall overlay (content-hug)', () => {
  it('(A) ECHO-MARKER-123 remains visible on screen while a 30-line overlay is active', async () => {
    const rig = await makeRig();

    // Commit the echo line — simulates the user's prompt echo appearing in the band.
    rig.c.setSpinner({ enabled: true });
    rig.c.commitAbove(`${ECHO_MARKER}\n`);
    rig.repaint();

    // Set a 30-line overlay — without the fix this rises over the 1-row band.
    const tallOverlay = Array.from({ length: 30 }, (_, i) => `◉ subagent-${i} thinking…`).join('\n');
    rig.c.setOverlay(tallOverlay);
    rig.repaint();

    const lines = await rig.lines();
    const dump = dumpOf(lines);
    const viewBase = rig.viewportTop();

    // The echo marker must be visible in the current viewport.
    const echoIdx = lines.findIndex((l) => l.includes(ECHO_MARKER));
    expect(
      echoIdx,
      `${ECHO_MARKER} must be in the viewport (baseY=${viewBase}) while overlay is tall:\n${dump}`,
    ).toBeGreaterThanOrEqual(viewBase);

    rig.dispose();
  });

  it('(B) ECHO-MARKER-123 appears exactly once after overlay collapses', async () => {
    const rig = await makeRig();

    rig.c.setSpinner({ enabled: true });
    rig.c.commitAbove(`${ECHO_MARKER}\n`);
    rig.repaint();

    // Expand: 30-line overlay
    const tallOverlay = Array.from({ length: 30 }, (_, i) => `◉ subagent-${i} thinking…`).join('\n');
    rig.c.setOverlay(tallOverlay);
    rig.repaint();

    // Collapse: fan-out ends
    rig.c.setOverlay('');
    rig.c.setSpinner({ enabled: false });
    rig.repaint();

    const lines = await rig.lines();
    const dump = dumpOf(lines);

    const echoCount = lines.filter((l) => l.includes(ECHO_MARKER)).length;
    expect(
      echoCount,
      `${ECHO_MARKER} must appear exactly once across scrollback+viewport after collapse:\n${dump}`,
    ).toBe(1);

    rig.dispose();
  });
});

/**
 * Repro test for GitHub issue #3207:
 * "TUI: one-row display hole inside a long committed message box after pane resize"
 *
 * Symptom: after committing a multi-row boxed message and simulating a pane
 * SHRINK resize, one row INSIDE the committed band is blank (a "hole"), while
 * the rows above and below it have content.
 *
 * Modelled after terminal-compositor.history-hole.repro.test.ts and
 * terminal-compositor.shrink-gap-ghost.repro.test.ts.
 *
 * The scenario (per the issue):
 *  1. Create compositor with 30 rows, 80 cols (content-hug mode)
 *  2. Commit a multi-row "boxed" message with identifiable rows:
 *     BOX-TOP, BOX-ROW-0, ..., BOX-ROW-N, BOX-BOT
 *  3. Simulate a SHRINK resize (30→24 rows):
 *     a. In bypass mode: change stdout.rows + call repaint() directly
 *     b. In full mode: call handleResizeImmediate + wait for CPR timeout
 *  4. Assert all box rows appear in the terminal output with NO blank row
 *     between them (i.e. no hole inside the band).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

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
  // Use isTTY=false so requestCprOrMarkDirty is never called in the bypass scenario.
  // This is intentional: in the bypass test we directly mutate stdout.rows and call
  // repaint(), so no ResizeBus fires and no CPR is requested.
  s.isTTY = false;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

interface Rig {
  c: TerminalCompositor;
  stdout: MockStdout;
  repaint(): void;
  /** Buffer including scrollback + viewport, right-trimmed. */
  lines(): Promise<string[]>;
  /** Viewport rows only (baseY .. baseY+rows-1), right-trimmed. */
  viewportLines(): Promise<string[]>;
  dispose(): void;
}

async function makeRig(rows: number): Promise<Rig> {
  const stdout = makeStdout(rows);
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));

  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    scrollRegion: {
      withFullScrollRegion<T>(fn: () => T): T {
        stdout.write('\x1b[s\x1b[r\x1b[u');
        try {
          return fn();
        } finally {
          stdout.write(`\x1b[s\x1b[1;${stdout.rows}r\x1b[u`);
        }
      },
      getExtraRows: () => 0,
    },
    anchorRow: 1,
    contentHug: true,
  });
  await c.arm();

  const term = new HeadlessTerminal({
    cols: COLS,
    rows,
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
    stdout,
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
    async viewportLines() {
      await feed();
      const b = term.buffer.active;
      const base = b.baseY;
      const out: string[] = [];
      for (let i = base; i < base + rows; i++) {
        out.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
      }
      return out;
    },
    dispose() {
      term.dispose();
      c.disarm();
    },
  };
}

/**
 * Assert that there is no blank row between any two non-blank rows in the
 * committed band region of the terminal output.
 *
 * Specifically: find the first row matching `topLabel` and the last row
 * matching `botLabel` in the combined scrollback+viewport buffer. Between
 * those two rows, every row must be non-blank. A blank row indicates a
 * "hole" in the committed message box.
 */
function assertNoHoleInBox(
  lines: string[],
  topLabel: string,
  botLabel: string,
): void {
  const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

  const topIdx = lines.indexOf(topLabel);
  const botIdx = lines.lastIndexOf(botLabel);

  expect(
    topIdx,
    `BOX-TOP label "${topLabel}" not found in terminal output:\n${dump}`,
  ).toBeGreaterThanOrEqual(0);

  expect(
    botIdx,
    `BOX-BOT label "${botLabel}" not found in terminal output:\n${dump}`,
  ).toBeGreaterThanOrEqual(0);

  expect(
    topIdx,
    `BOX-TOP must appear before BOX-BOT:\n${dump}`,
  ).toBeLessThan(botIdx);

  // Check every row between topIdx and botIdx is non-blank
  const holeRows: number[] = [];
  for (let i = topIdx + 1; i < botIdx; i++) {
    if ((lines[i] ?? '').trim() === '') {
      holeRows.push(i);
    }
  }

  expect(
    holeRows,
    `One-row hole(s) detected INSIDE the committed message box at row indices ` +
    `${JSON.stringify(holeRows)} (between BOX-TOP at ${topIdx} and BOX-BOT at ${botIdx}):\n${dump}`,
  ).toEqual([]);
}

/**
 * Assert that every label from the committed rows list is present in order
 * with no gaps in the visible output.
 */
function assertNoHoleAllRows(lines: string[], allRows: string[]): void {
  const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

  for (const label of allRows) {
    const count = lines.filter((l) => l === label).length;
    expect(
      count,
      `Label "${label}" not found in terminal output:\n${dump}`,
    ).toBeGreaterThanOrEqual(1);
  }

  // Find extent
  const indices = allRows.map((label) => lines.indexOf(label));
  const first = Math.min(...indices);
  const last = Math.max(...indices.map((i, j) => lines.lastIndexOf(allRows[j] ?? '')));

  // No holes between first and last label
  const holeRows: number[] = [];
  for (let i = first + 1; i <= last; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      holeRows.push(i);
    }
  }
  expect(
    holeRows,
    `Hole row(s) detected inside committed band at indices ${JSON.stringify(holeRows)}:\n${dump}`,
  ).toEqual([]);
}

// Build a boxed message with N interior rows
function buildBoxedMessage(n: number): { lines: string[]; all: string[]; top: string; bot: string } {
  const top = 'BOX-TOP';
  const bot = 'BOX-BOT';
  const interior = Array.from({ length: n }, (_, i) => `BOX-ROW-${String(i).padStart(3, '0')}`);
  return {
    top,
    bot,
    lines: [top, ...interior, bot],
    all: [top, ...interior, bot],
  };
}

describe('issue #3207 — no hole inside committed band after pane resize (SHRINK)', () => {
  describe.each([
    { initialRows: 30, shrinkTo: 24, boxInteriorRows: 8 },
    { initialRows: 30, shrinkTo: 24, boxInteriorRows: 14 },
    { initialRows: 30, shrinkTo: 24, boxInteriorRows: 20 },
    { initialRows: 30, shrinkTo: 20, boxInteriorRows: 8 },
    { initialRows: 30, shrinkTo: 20, boxInteriorRows: 14 },
  ])(
    '$initialRows→$shrinkTo rows, box interior=$boxInteriorRows rows',
    ({ initialRows, shrinkTo, boxInteriorRows }) => {
      let rig: Rig;

      beforeEach(async () => {
        rig = await makeRig(initialRows);
      });

      afterEach(() => {
        rig.dispose();
      });

      it('no hole in viewport after SHRINK (bypass: direct stdout.rows + repaint)', async () => {
        const box = buildBoxedMessage(boxInteriorRows);

        // Step 1: commit the boxed message
        rig.c.commitAbove(`${box.lines.join('\n')}\n`);
        rig.repaint();

        // Verify the box is intact before the resize
        const beforeLines = await rig.lines();
        assertNoHoleInBox(beforeLines, box.top, box.bot);

        // Step 2: simulate SHRINK by directly changing stdout.rows
        // This bypasses ResizeBus/handleResizeImmediate — the compositor sees
        // the new row count only on the next repaint().
        rig.stdout.rows = shrinkTo;

        // Step 3: trigger a repaint as the runtime would after SIGWINCH
        rig.repaint();

        // Step 4: assert no hole in the viewport after the shrink
        const afterViewport = await rig.viewportLines();
        const afterAll = await rig.lines();

        // Primary assertion: no blank row inside the box region visible in viewport
        // (the box may have been partially scrolled to scrollback on a big shrink,
        // but whatever is visible must be contiguous — no hole)
        const viewportBoxRows = box.all.filter((label) => afterViewport.includes(label));
        if (viewportBoxRows.length >= 2) {
          // At least 2 box rows visible — assert they're contiguous in the viewport
          const firstVpIdx = afterViewport.indexOf(viewportBoxRows[0]!);
          const lastVpIdx = afterViewport.lastIndexOf(viewportBoxRows[viewportBoxRows.length - 1]!);
          const holes: number[] = [];
          for (let i = firstVpIdx + 1; i <= lastVpIdx; i++) {
            if ((afterViewport[i] ?? '').trim() === '') {
              holes.push(i);
            }
          }
          const dump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');
          expect(
            holes,
            `One-row hole(s) inside the visible box rows after ${initialRows}→${shrinkTo} shrink ` +
            `at viewport indices ${JSON.stringify(holes)}:\n${dump}`,
          ).toEqual([]);
        }

        // Secondary: all box rows that ARE present appear without holes
        // (covers the scrollback+viewport whole-buffer check)
        const presentLabels = box.all.filter((label) =>
          afterAll.some((l) => l === label),
        );
        if (presentLabels.length >= 2) {
          assertNoHoleAllRows(afterAll, presentLabels);
        }
      });

      it('no hole in viewport after SHRINK (via logUpdate.resetGeometry path)', async () => {
        const box = buildBoxedMessage(boxInteriorRows);

        // Commit the boxed message
        rig.c.commitAbove(`${box.lines.join('\n')}\n`);
        rig.repaint();

        // Simulate the SIGWINCH handler's effect on the renderer geometry:
        // handleResizeImmediate calls logUpdate.resetGeometry() which zeros
        // the renderer's previous frame tracking (previousTopRow = 0).
        // We replicate this by calling it directly.
        const compositor = rig.c as unknown as { logUpdate: { resetGeometry?: () => void } | null };
        compositor.logUpdate?.resetGeometry?.();

        // Also set bandGeometryStale as handleResizeImmediate would
        (rig.c as unknown as { bandGeometryStale: boolean }).bandGeometryStale = true;

        // Shrink the terminal
        rig.stdout.rows = shrinkTo;

        // Repaint — this is what fires after the CPR timeout/reply
        rig.repaint();

        const afterViewport = await rig.viewportLines();
        const afterAll = await rig.lines();

        // Assert no hole in visible box rows
        const viewportBoxRows = box.all.filter((label) => afterViewport.includes(label));
        if (viewportBoxRows.length >= 2) {
          const firstVpIdx = afterViewport.indexOf(viewportBoxRows[0]!);
          const lastVpIdx = afterViewport.lastIndexOf(viewportBoxRows[viewportBoxRows.length - 1]!);
          const holes: number[] = [];
          for (let i = firstVpIdx + 1; i <= lastVpIdx; i++) {
            if ((afterViewport[i] ?? '').trim() === '') {
              holes.push(i);
            }
          }
          const dump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');
          expect(
            holes,
            `One-row hole(s) inside the visible box after resetGeometry + ${initialRows}→${shrinkTo} shrink ` +
            `at viewport indices ${JSON.stringify(holes)}:\n${dump}`,
          ).toEqual([]);
        }

        if (afterAll.filter((l) => box.all.includes(l)).length >= 2) {
          const presentLabels = box.all.filter((label) => afterAll.some((l) => l === label));
          if (presentLabels.length >= 2) {
            assertNoHoleAllRows(afterAll, presentLabels);
          }
        }
      });

      it('no hole after SHRINK followed by a new commit', async () => {
        const box = buildBoxedMessage(boxInteriorRows);

        rig.c.commitAbove(`${box.lines.join('\n')}\n`);
        rig.repaint();

        // Shrink
        rig.stdout.rows = shrinkTo;
        rig.repaint();

        // Commit an additional row
        rig.c.commitAbove('POST-RESIZE-ROW\n');
        rig.repaint();

        const afterAll = await rig.lines();
        const afterViewport = await rig.viewportLines();
        const dump = afterAll.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

        // POST-RESIZE-ROW must be present
        expect(
          afterAll.some((l) => l === 'POST-RESIZE-ROW'),
          `POST-RESIZE-ROW missing after resize + commit:\n${dump}`,
        ).toBe(true);

        // No holes in viewport between visible box rows
        const viewportBoxRows = box.all.filter((label) => afterViewport.includes(label));
        if (viewportBoxRows.length >= 2) {
          const firstVpIdx = afterViewport.indexOf(viewportBoxRows[0]!);
          const lastVpIdx = afterViewport.lastIndexOf(viewportBoxRows[viewportBoxRows.length - 1]!);
          const holes: number[] = [];
          for (let i = firstVpIdx + 1; i <= lastVpIdx; i++) {
            if ((afterViewport[i] ?? '').trim() === '') {
              holes.push(i);
            }
          }
          const vpDump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');
          expect(
            holes,
            `Hole(s) in box after resize + commit at viewport indices ${JSON.stringify(holes)}:\n${vpDump}`,
          ).toEqual([]);
        }
      });
    },
  );

  // Specific scenario from the issue: large box in small terminal (overflow case)
  it('no hole when box overflows the shrunken viewport (only survivors visible)', async () => {
    const INITIAL_ROWS = 30;
    const SHRINK_TO = 20;
    const BOX_ROWS = 22; // larger than shrunken viewport

    const rig = await makeRig(INITIAL_ROWS);
    const box = buildBoxedMessage(BOX_ROWS);

    rig.c.commitAbove(`${box.lines.join('\n')}\n`);
    rig.repaint();

    // Shrink to where the box overflows the viewport
    rig.stdout.rows = SHRINK_TO;
    rig.repaint();

    const afterViewport = await rig.viewportLines();
    const vpDump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    // Find the visible box rows in the viewport
    const visibleBoxRows = box.all.filter((label) => afterViewport.includes(label));

    if (visibleBoxRows.length >= 2) {
      const firstVpIdx = afterViewport.indexOf(visibleBoxRows[0]!);
      const lastVpIdx = afterViewport.lastIndexOf(visibleBoxRows[visibleBoxRows.length - 1]!);
      const holes: number[] = [];
      for (let i = firstVpIdx + 1; i <= lastVpIdx; i++) {
        if ((afterViewport[i] ?? '').trim() === '') {
          holes.push(i);
        }
      }
      expect(
        holes,
        `Hole(s) inside the visible box after overflow shrink at viewport indices ${JSON.stringify(holes)}:\n${vpDump}`,
      ).toEqual([]);
    }

    rig.dispose();
  });

  // The exact scenario from the issue description
  it('exact issue scenario: 30→24 shrink, 10-row boxed message, no interior blank row', async () => {
    const INITIAL_ROWS = 30;
    const SHRINK_TO = 24;

    const rig = await makeRig(INITIAL_ROWS);
    const box = buildBoxedMessage(10); // 12 total rows: BOX-TOP + 10 interior + BOX-BOT

    // Commit the boxed message
    rig.c.commitAbove(`${box.lines.join('\n')}\n`);
    rig.repaint();

    // Verify pre-resize state (sanity check)
    const preLines = await rig.lines();
    assertNoHoleInBox(preLines, box.top, box.bot);

    // Simulate SHRINK
    rig.stdout.rows = SHRINK_TO;
    rig.repaint();

    // Verify post-resize: all box rows are in viewport (band still fits in 24 rows)
    // and no blank row between them
    const postViewport = await rig.viewportLines();
    const postAll = await rig.lines();

    // The box (12 rows) + 1 input row = 13 rows total, fits in 24-row viewport.
    // All box rows must be visible and contiguous.
    assertNoHoleInBox(postAll, box.top, box.bot);

    // Also check viewport specifically
    const vpDump = postViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');
    const topIdx = postViewport.indexOf(box.top);
    const botIdx = postViewport.indexOf(box.bot);
    if (topIdx >= 0 && botIdx > topIdx) {
      const holes: number[] = [];
      for (let i = topIdx + 1; i < botIdx; i++) {
        if ((postViewport[i] ?? '').trim() === '') {
          holes.push(i);
        }
      }
      expect(
        holes,
        `One-row hole inside box in viewport after 30→24 shrink at indices ${JSON.stringify(holes)}:\n${vpDump}`,
      ).toEqual([]);
    }

    rig.dispose();
  });
});

// ---------------------------------------------------------------------------
// CPR-path tests: simulate handleResizeImmediate effects without ResizeBus
// ---------------------------------------------------------------------------
// These tests replicate the key side-effects of handleResizeImmediate on SHRINK
// (logUpdate.resetGeometry, bandGeometryStale=true, CPR shift) without using
// process.stdout.emit('resize') or HeadlessTerminal async writes, so fake timers
// are not needed. We directly mutate compositor internals and call repaint().

describe('issue #3207 — committed band hole: handleResizeImmediate side-effects on SHRINK', () => {
  it('no hole after resetGeometry + delta shift simulating CPR-corrected SHRINK', async () => {
    const INITIAL_ROWS = 30;
    const SHRINK_TO = 24;
    const DELTA = -3; // tmux pushed 3 rows to history

    const rig = await makeRig(INITIAL_ROWS);
    const box = buildBoxedMessage(10); // 12-row box

    rig.c.commitAbove(`${box.lines.join('\n')}\n`);
    rig.repaint();

    // Simulate handleResizeImmediate side-effects for SHRINK:
    // 1. resetGeometry() clears renderer's tracked rows
    const compositor = rig.c as unknown as {
      logUpdate: { resetGeometry?: () => void; topRow?: number } | null;
      bandGeometryStale: boolean;
      committedBandTopRow: number;
      committedBandBottomRow: number;
      lastMeasuredFrameTop: number;
      lastMeasuredFrameBottom: number;
      pendingResizeErase: { top: number; bottom: number } | null;
      anchorRow: number | undefined;
    };
    compositor.logUpdate?.resetGeometry?.();

    // 2. bandGeometryStale = true
    compositor.bandGeometryStale = true;

    // 3. Simulate CPR delta shift (as applyScrollDelta does it)
    const clamp = (r: number, maxR: number): number => Math.max(1, Math.min(r + DELTA, maxR));
    compositor.committedBandTopRow = clamp(compositor.committedBandTopRow, SHRINK_TO);
    compositor.committedBandBottomRow = clamp(compositor.committedBandBottomRow, SHRINK_TO);
    compositor.lastMeasuredFrameTop = compositor.lastMeasuredFrameTop > 0
      ? clamp(compositor.lastMeasuredFrameTop, SHRINK_TO) : 0;
    compositor.lastMeasuredFrameBottom = compositor.lastMeasuredFrameBottom > 0
      ? clamp(compositor.lastMeasuredFrameBottom, SHRINK_TO) : 0;

    // 4. Shrink the terminal
    rig.stdout.rows = SHRINK_TO;

    // 5. Repaint — what fires after CPR reply
    rig.repaint();

    const afterViewport = await rig.viewportLines();
    const afterAll = await rig.lines();

    // All box rows must be present with no blank row between them
    assertNoHoleInBox(afterAll, box.top, box.bot);

    // Viewport check
    const topIdx = afterViewport.indexOf(box.top);
    const botIdx = afterViewport.indexOf(box.bot);
    if (topIdx >= 0 && botIdx > topIdx) {
      const holes: number[] = [];
      for (let i = topIdx + 1; i < botIdx; i++) {
        if ((afterViewport[i] ?? '').trim() === '') holes.push(i);
      }
      const dump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');
      expect(
        holes,
        `One-row hole inside box after resetGeometry + delta shift at viewport indices ` +
        `${JSON.stringify(holes)}:\n${dump}`,
      ).toEqual([]);
    }

    rig.dispose();
  });

  it('no hole when delta shift causes committedBandBottomRow to mismatch targetBottom', async () => {
    // Regression scenario: after applyScrollDelta, committedBandBottomRow may differ
    // from the new targetBottom, causing moved=true in repositionCommittedBand.
    // Verify the repaint produces no hole.
    const INITIAL_ROWS = 30;
    const SHRINK_TO = 24;

    const rig = await makeRig(INITIAL_ROWS);
    const box = buildBoxedMessage(10);

    rig.c.commitAbove(`${box.lines.join('\n')}\n`);
    rig.repaint();

    const compositor = rig.c as unknown as {
      logUpdate: { resetGeometry?: () => void } | null;
      bandGeometryStale: boolean;
      committedBandTopRow: number;
      committedBandBottomRow: number;
    };
    compositor.logUpdate?.resetGeometry?.();
    compositor.bandGeometryStale = true;

    // Set committedBandBottomRow to a value that differs from targetBottom
    // (simulates a large delta that clamped the bottom to a wrong value)
    compositor.committedBandTopRow = 1;
    compositor.committedBandBottomRow = 9; // different from expected 12

    rig.stdout.rows = SHRINK_TO;
    rig.repaint();

    const afterViewport = await rig.viewportLines();
    const vpDump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    const visibleBox = box.all.filter((label) => afterViewport.includes(label));
    if (visibleBox.length >= 2) {
      const firstIdx = afterViewport.indexOf(visibleBox[0]!);
      const lastIdx = afterViewport.lastIndexOf(visibleBox[visibleBox.length - 1]!);
      const holes: number[] = [];
      for (let i = firstIdx + 1; i <= lastIdx; i++) {
        if ((afterViewport[i] ?? '').trim() === '') holes.push(i);
      }
      expect(
        holes,
        `One-row hole inside box when committedBandBottomRow mismatched at viewport indices ` +
        `${JSON.stringify(holes)}:\n${vpDump}`,
      ).toEqual([]);
    }

    rig.dispose();
  });
});

// ---------------------------------------------------------------------------
// GROW-eviction tests: the actual issue scenario
// ---------------------------------------------------------------------------

describe('issue #3207 — committed band hole: GROW eviction (exact issue scenario)', () => {
  it('no hole in viewport after GROW that triggers evict-on-growth archival', async () => {
    const INITIAL_ROWS = 20;
    const GROW_TO = 30;
    const BAND_ROWS = 18;

    const rig = await makeRig(INITIAL_ROWS);
    const labels = Array.from({ length: BAND_ROWS }, (_, i) => `R${String(i).padStart(3, '0')}`);
    rig.c.commitAbove(`${labels.join('\n')}\n`);
    rig.repaint();

    rig.stdout.rows = GROW_TO;
    rig.repaint();

    const afterViewport = await rig.viewportLines();
    const visibleLabels = labels.filter((l) => afterViewport.includes(l));
    if (visibleLabels.length >= 2) {
      const firstVpIdx = afterViewport.indexOf(visibleLabels[0]!);
      const lastVpIdx = afterViewport.lastIndexOf(visibleLabels[visibleLabels.length - 1]!);
      const holes: number[] = [];
      for (let i = firstVpIdx + 1; i <= lastVpIdx; i++) {
        if ((afterViewport[i] ?? '').trim() === '') holes.push(i);
      }
      const vpDump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');
      expect(holes, `Hole after GROW (${INITIAL_ROWS}→${GROW_TO}):\n${vpDump}`).toEqual([]);
    }
    rig.dispose();
  });

  it('no hole in viewport after GROW with boxed message near archive boundary', async () => {
    const INITIAL_ROWS = 20;
    const GROW_TO = 28;

    const rig = await makeRig(INITIAL_ROWS);
    const preamble = Array.from({ length: 5 }, (_, i) => `PRE-${i}`);
    const box = buildBoxedMessage(8);
    const allLabels = [...preamble, ...box.all];
    rig.c.commitAbove(`${allLabels.join('\n')}\n`);
    rig.repaint();

    rig.stdout.rows = GROW_TO;
    rig.repaint();

    const afterViewport = await rig.viewportLines();
    const afterAll = await rig.lines();
    const vpDump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');

    const visibleBoxRows = box.all.filter((l) => afterViewport.includes(l));
    if (visibleBoxRows.length >= 2) {
      const firstVpIdx = afterViewport.indexOf(visibleBoxRows[0]!);
      const lastVpIdx = afterViewport.lastIndexOf(visibleBoxRows[visibleBoxRows.length - 1]!);
      const holes: number[] = [];
      for (let i = firstVpIdx + 1; i <= lastVpIdx; i++) {
        if ((afterViewport[i] ?? '').trim() === '') holes.push(i);
      }
      expect(holes, `Hole inside box after GROW:\n${vpDump}`).toEqual([]);
    }

    const presentLabels = allLabels.filter((l) => afterAll.some((al) => al === l));
    if (presentLabels.length >= 2) {
      assertNoHoleAllRows(afterAll, presentLabels);
    }
    rig.dispose();
  });

  it('no hole after GROW followed by a SHRINK (bounce)', async () => {
    const INITIAL_ROWS = 20;
    const GROW_TO = 30;
    const SHRINK_TO = 24;
    const BAND_ROWS = 18;

    const rig = await makeRig(INITIAL_ROWS);
    const labels = Array.from({ length: BAND_ROWS }, (_, i) => `B${String(i).padStart(3, '0')}`);
    rig.c.commitAbove(`${labels.join('\n')}\n`);
    rig.repaint();

    // Grow
    rig.stdout.rows = GROW_TO;
    rig.repaint();

    // Shrink
    rig.stdout.rows = SHRINK_TO;
    rig.repaint();

    const afterViewport = await rig.viewportLines();
    const visibleLabels = labels.filter((l) => afterViewport.includes(l));
    if (visibleLabels.length >= 2) {
      const firstVpIdx = afterViewport.indexOf(visibleLabels[0]!);
      const lastVpIdx = afterViewport.lastIndexOf(visibleLabels[visibleLabels.length - 1]!);
      const holes: number[] = [];
      for (let i = firstVpIdx + 1; i <= lastVpIdx; i++) {
        if ((afterViewport[i] ?? '').trim() === '') holes.push(i);
      }
      const vpDump = afterViewport.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l)}`).join('\n');
      expect(holes, `Hole after GROW→SHRINK bounce:\n${vpDump}`).toEqual([]);
    }
    rig.dispose();
  });
});

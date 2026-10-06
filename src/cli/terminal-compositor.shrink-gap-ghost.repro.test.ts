/**
 * Failing regression: content-hug blank gap below prompt after tall overlay shrinks.
 *
 * Bug (#2804 / commit f17c7e467): when a tall live overlay grows over a
 * viewport-full committed band, the rows it covered are archived to scrollback
 * (pendingEvictionAllowed fired). When the overlay later SHRINKS to a few rows,
 * the compositor repaint cannot refill the reclaimed above-frame room with
 * committed rows (they are already in scrollback and the band model has shrunk
 * to only the rows that survived archival). The frame therefore "hugs" only the
 * few remaining band rows and a large blank region appears BELOW the input line
 * (above the reserved footer / scroll-region bottom).
 *
 * Desired behavior (all four assertions together):
 *   (a) After the shrink, no run of >1 consecutive blank rows between the input
 *       line and the bottom of the compositor region (i.e. the screen refills).
 *   (b) Every committed row id appears in scrollback-or-screen (no missing rows).
 *   (c) Scrollback alone never contains the same id twice (no duplicates in
 *       scrollback during the transition window; copies on screen are allowed).
 *   (d) After overlay cleared + one further commit + disarm, every committed row
 *       appears in scrollback+screen exactly once, in order.
 *
 * Modelled on terminal-compositor.history-hole.repro.test.ts and
 * terminal-compositor.collapse-void.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
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
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

interface Rig {
  c: TerminalCompositor;
  repaint(): void;
  /** Whole buffer (scrollback + viewport), right-trimmed. */
  lines(): Promise<string[]>;
  /** Viewport only, right-trimmed. */
  viewportLines(): Promise<string[]>;
  viewportTop(): number;
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
          stdout.write(`\x1b[s\x1b[1;${rows}r\x1b[u`);
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
    viewportTop: () => term.buffer.active.baseY,
    dispose() {
      term.dispose();
      c.disarm();
    },
  };
}

function dumpLines(lines: string[]): string {
  return lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');
}

/**
 * Build a scenario state for both heights.
 * Returns { allLines, viewportLines, allIds, rig } after:
 *   1. Commit ROWS+4 uniquely-labelled lines (fill viewport + overflow into scrollback)
 *   2. Set tall overlay (floor(ROWS * 0.6) lines) and repaint
 *   3. Commit 3 more lines while tall overlay is up
 *   4. Shrink overlay to 3 rows and repaint
 */
async function buildShrinkScenario(rows: number): Promise<{
  allLines: string[];
  viewportLines: string[];
  allIds: string[];
  rig: Rig;
}> {
  const rig = await makeRig(rows);
  rig.c.setSpinner({ enabled: true });

  // Step 1: commit enough lines to fill the viewport and push some to scrollback.
  const initCount = rows + 4;
  const initIds = Array.from({ length: initCount }, (_, i) => `R${String(i + 1).padStart(3, '0')}`);
  rig.c.commitAbove(`${initIds.join('\n')}\n`);
  rig.repaint();

  // Step 2: set a tall overlay (taller than half the viewport) and repaint.
  // This causes the compositor to archive covered band rows to scrollback.
  const tallHeight = Math.floor(rows * 0.6);
  const tallOverlay = Array.from({ length: tallHeight }, (_, i) => `LIVE-TALL-${i}`).join('\n');
  rig.c.setOverlay(tallOverlay);
  rig.repaint();

  // Step 3: commit a few more lines while tall overlay is up.
  const midIds = Array.from({ length: 3 }, (_, i) => `M${String(i + 1).padStart(3, '0')}`);
  rig.c.commitAbove(`${midIds.join('\n')}\n`);
  rig.repaint();

  // Step 4: shrink overlay to ~3 rows and repaint.
  // This is where the bug manifests: the frame reclaims above-frame room but
  // cannot refill it with committed rows (they were archived to scrollback).
  const smallOverlay = Array.from({ length: 3 }, (_, i) => `LIVE-SMALL-${i}`).join('\n');
  rig.c.setOverlay(smallOverlay);
  rig.repaint();

  const allIds = [...initIds, ...midIds];
  return {
    allLines: await rig.lines(),
    viewportLines: await rig.viewportLines(),
    allIds,
    rig,
  };
}

const PROMPT_GLYPH = '\u23af'; // ⎯ input rule

describe.each([24, 64])(
  'shrink-gap-ghost repro (content-hug, %i rows)',
  (ROWS) => {
    it(
      '(a) after shrink, no run of >1 blank rows between last committed row and bottom of compositor region',
      async () => {
        const { allLines, rig } = await buildShrinkScenario(ROWS);
        const dump = dumpLines(allLines);

        // Find the input/prompt row (the frame bottom marker).
        const promptIdx = allLines.findIndex((l) => l.includes(PROMPT_GLYPH));
        expect(promptIdx, `prompt not found in buffer:\n${dump}`).toBeGreaterThanOrEqual(0);

        // Count blank rows immediately BELOW the prompt row (still within the
        // compositor scroll region). The bug: after a tall overlay collapses to a
        // short one the screen is not refilled, so the reclaimed rows below the
        // input line stay blank (a large dead zone). A healthy compositor refills
        // them with prior committed rows so at most 0 trailing blank rows appear
        // below the prompt within the scroll region.
        //
        // We scan from promptIdx+1 to the end of the viewport (baseY + rows - 1).
        const viewportBase = rig.viewportTop();
        // The compositor region ends one row above the physical bottom: the last
        // row is reserved for the status line (maxLines = rows - 1 - extraRows in
        // terminal-compositor.frame.layout.ts), so it is blank in this harness
        // even with no overlay at all and is excluded from the scan.
        const viewportEnd = viewportBase + ROWS - 2; // inclusive, 0-based in allLines
        let blankRunBelowPrompt = 0;
        for (let i = promptIdx + 1; i <= viewportEnd && i < allLines.length; i++) {
          if ((allLines[i] ?? '').trim() === '') blankRunBelowPrompt++;
          // Do NOT break on non-blank: a displaced frame line (spinner, status row)
          // can interrupt the blank run, hiding further blank rows from an early exit.
          // Counting all blanks in the region is the correct invariant (#2871.5).
        }

        // When the bug is present, there are many blank rows below the input line.
        // The fix should repaint prior committed rows there so blankRunBelowPrompt === 0.
        expect(
          blankRunBelowPrompt,
          `${blankRunBelowPrompt} blank rows below the prompt row after tall-to-small overlay shrink (screen not refilled):\n${dump}`,
        ).toBe(0);

        rig.dispose();
      },
      20_000,
    );

    it(
      '(b) every committed row id appears in scrollback-or-screen (no missing ids after shrink)',
      async () => {
        const { allLines, allIds, rig } = await buildShrinkScenario(ROWS);
        const dump = dumpLines(allLines);
        const missing: string[] = [];
        for (const id of allIds) {
          if (!allLines.some((l) => l.includes(id))) missing.push(id);
        }
        expect(
          missing,
          `committed ids missing from scrollback+screen after overlay shrink:\n${dump}`,
        ).toEqual([]);
        rig.dispose();
      },
      20_000,
    );

    it(
      '(c) scrollback alone never contains any committed id twice (no duplicates in scrollback)',
      async () => {
        const { rig, allIds } = await buildShrinkScenario(ROWS);
        // Feed everything and read only scrollback (lines above baseY).
        const allL = await rig.lines();
        const vTop = rig.viewportTop();
        const scrollbackLines = allL.slice(0, vTop);
        const dump = dumpLines(allL);
        const dupes: string[] = [];
        for (const id of allIds) {
          const count = scrollbackLines.filter((l) => l.includes(id)).length;
          if (count > 1) dupes.push(`${id}(x${count})`);
        }
        expect(
          dupes,
          `committed ids duplicated in scrollback after overlay shrink:\n${dump}`,
        ).toEqual([]);
        rig.dispose();
      },
      20_000,
    );

    it(
      '(d) after overlay cleared + one more commit + disarm, scrollback+screen contain every id exactly once in order',
      async () => {
        const { rig, allIds } = await buildShrinkScenario(ROWS);

        // Clear the overlay (turn end), commit one more line, then disarm.
        rig.c.setOverlay('');
        rig.c.setSpinner({ enabled: false });
        rig.repaint();
        const finalId = 'FINAL-001';
        rig.c.commitAbove(`${finalId}\n`);
        rig.repaint();
        rig.c.disarm();

        // Feed the final output; disarm writes to stdout.
        const allLines = await rig.lines();
        const dump = dumpLines(allLines);
        const allExpected = [...allIds, finalId];

        // Every id must appear exactly once.
        const dupes: string[] = [];
        const missing: string[] = [];
        for (const id of allExpected) {
          const count = allLines.filter((l) => l.includes(id)).length;
          if (count === 0) missing.push(id);
          else if (count > 1) dupes.push(`${id}(x${count})`);
        }
        expect(missing, `ids absent after disarm:\n${dump}`).toEqual([]);
        expect(dupes, `ids duplicated after disarm:\n${dump}`).toEqual([]);

        // In-order: the line index of each id must be non-decreasing.
        const idxs = allExpected
          .map((id) => allLines.findIndex((l) => l.includes(id)))
          .filter((i) => i >= 0);
        const sorted = [...idxs].sort((a, b) => a - b);
        expect(idxs, `ids out of order after disarm:\n${dump}`).toEqual(sorted);

        // Dispose without calling disarm again (already called above).
        (rig as unknown as { c: { _armed?: boolean } }).c._armed = false;
      },
      20_000,
    );
  },
);

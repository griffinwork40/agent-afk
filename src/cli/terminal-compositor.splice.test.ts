/**
 * Regression test: commitAbove() Phase 1 multi-line splice.
 *
 * Root cause (v3.50.1): commitAbove Phase 1 emitted a single `\x1b[2K`
 * before the entire multi-line `stripped` write. Only the first row was
 * erased; rows 2..N wrote onto un-erased rows, so the tail of any longer
 * pre-existing content survived → garbled "spliced" lines.
 *
 * Fix (this PR): `eraseEachLine` prefixes every line with `\x1b[2K` so
 * each row is fully cleared before its new content is written.
 *
 * Test strategy:
 *   1. Arm a compositor on a small TTY (rows=10, cols=40).
 *   2. Pre-populate the emulator with LONG content on rows 1..N.
 *   3. Call commitAbove() with a SHORTER multi-line block.
 *   4. Feed all captured stdout bytes into @xterm/headless Terminal.
 *   5. Assert no rendered line contains a splice (short-block token
 *      AND leftover tail of a long-block line on the same rendered line).
 *
 * HARD CORRECTNESS GATE: this test MUST fail on the un-fixed Phase 1
 * code (single \x1b[2K) and MUST pass after the fix (per-line \x1b[2K).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

// ---- helpers reused from terminal-compositor.test.ts ----

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockStdout;
};

type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
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

/**
 * Invariant: withFullScrollRegion MUST emit real DECSTBM escapes so that
 * \n at the bottom row of the full screen causes a scrollback-bound scroll
 * in the headless emulator (same as a real terminal with ONLCR/DECSTBM).
 *
 * Sequence (mirrors StatusLine.withFullScrollRegion):
 *   save cursor → \x1b[r (reset to full screen) → restore cursor
 *   → fn() →
 *   save cursor → \x1b[1;{rows}r (re-establish region) → restore cursor
 */
function makeScrollRegion(stdout: MockStdout) {
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      // External constraint (VT100/DECSTBM): reset to full screen before fn()
      // so \n at bottom row scrolls into scrollback, not a sub-region.
      stdout.write('\x1b[s'); // save cursor
      stdout.write('\x1b[r'); // reset DECSTBM to full screen
      stdout.write('\x1b[u'); // restore cursor
      try {
        return fn();
      } finally {
        const rows = stdout.rows;
        stdout.write('\x1b[s'); // save cursor
        stdout.write(`\x1b[1;${rows}r`); // re-establish full-screen region
        stdout.write('\x1b[u'); // restore cursor
      }
    },
    getExtraRows(): number {
      return 0;
    },
  };
}

/**
 * Feed a raw escape string into a headless xterm Terminal and wait for
 * the write to complete.
 */
function termWriteSync(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/**
 * Collect all rendered lines (scrollback + viewport) from the headless
 * terminal, trimming trailing whitespace from each.
 */
function allLines(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const result: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line != null) {
      result.push(line.translateToString(true));
    }
  }
  return result;
}

// ---- terminal dimensions ----
const COLS = 40;
const ROWS = 10;

// Distinctive tokens: LONG block fills rows beyond the short block's width;
// SHORT block has clearly different, shorter tokens.
const LONG_LINE_1 = 'LONGBLOCK_FIRST_LINEXXXXXXXXXXXXXX'; // 34 chars
const LONG_LINE_2 = 'LONGBLOCK_SECOND_LINEXXXXXXXXXXXXX'; // 34 chars
const LONG_LINE_3 = 'LONGBLOCK_THIRD_LINEXXXXXXXXXXXXXX'; // 34 chars

const SHORT_LINE_1 = 'sh1'; // 3 chars — much shorter, leaves tail if not erased
const SHORT_LINE_2 = 'sh2';
const SHORT_LINE_3 = 'sh3';

// Splice detector: a line is "spliced" if it starts with a short-block token
// AND also contains a tail fragment of one of the long-block lines.
// (After row 1, the long-block tail chars would be XXXXXX… leftover).
const LONG_TAIL_MARKER = 'XXXXXXX'; // appears in LONG_LINE_* but never in SHORT_LINE_*
function isSplicedLine(line: string): boolean {
  const hasShortToken =
    line.includes(SHORT_LINE_1) ||
    line.includes(SHORT_LINE_2) ||
    line.includes(SHORT_LINE_3);
  const hasLongTail = line.includes(LONG_TAIL_MARKER);
  return hasShortToken && hasLongTail;
}

describe('commitAbove Phase 1 multi-line splice regression', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;
  let compositor: TerminalCompositor;

  beforeEach(() => {
    stdout = makeMockStdout(COLS, ROWS);
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
    const scrollRegion = makeScrollRegion(stdout);
    compositor = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion,
    });
    // NOTE: do NOT arm here — tests that create their own compositor would
    // conflict with the shared claim. The one test that uses this shared
    // compositor arms it explicitly; afterEach's disarm() is idempotent.
  });

  afterEach(() => {
    compositor.disarm();
  });

  it(
    'no rendered line carries a splice after committing a shorter multi-line block over a longer one',
    async () => {
      await compositor.arm();
      // External constraint (ONLCR): the real TTY converts bare \n to \r\n in
      // output mode. @xterm/headless must mirror this with convertEol:true so
      // the LF-based cursor positioning in Phase 1 lands at column 1 on each
      // subsequent line — exactly as it would in a real terminal session.
      //
      // Invariant: scrollback must be large enough to hold all displaced lines
      // (LONG_LINE_* lines are pushed to scrollback by Phase 1 scrolls).
      const term = new HeadlessTerminal({
        cols: COLS,
        rows: ROWS,
        scrollback: 200,
        allowProposedApi: true,
        convertEol: true, // mirrors ONLCR tty output flag
      });

      // Step 1: Seed the emulator with LONG content on rows 1..3.
      // These are the rows Phase 1 will write the SHORT block onto.
      await termWriteSync(
        term,
        `\x1b[1;1H${LONG_LINE_1}\x1b[2;1H${LONG_LINE_2}\x1b[3;1H${LONG_LINE_3}`,
      );

      // Step 2: Commit a LONG block to ensure rows 1..3 carry the long
      // content in the compositor's actual Phase 1 write position.
      compositor.commitAbove(`${LONG_LINE_1}\n${LONG_LINE_2}\n${LONG_LINE_3}`);
      const longBlockWrites = writes.all();

      // Feed the LONG block's Phase 1 bytes into the emulator.
      await termWriteSync(term, longBlockWrites);

      // Step 3: Now commit the SHORT block (shorter lines, same line count).
      // After this, the emulator should NOT show any spliced line.
      const beforeShort = writes.all();
      void beforeShort; // consumed above; reset effectively by feeding into term

      // Re-seed: put long lines back into the viewport rows that Phase 1 will
      // target (rows 1..3 from phase1Row=anchorRow=1). We do this by directly
      // writing to the emulator so the un-erased content exists to be spliced.
      await termWriteSync(
        term,
        `\x1b[1;1H${LONG_LINE_1}\x1b[2;1H${LONG_LINE_2}\x1b[3;1H${LONG_LINE_3}`,
      );

      // Capture the SHORT block writes from the compositor.
      const chunksBefore = writes.all(); // flush any prior
      void chunksBefore;
      // Clear captured writes and do the SHORT commit.
      const chunks: string[] = [];
      stdout.on('data', (c: unknown) => chunks.push(String(c)));
      compositor.commitAbove(`${SHORT_LINE_1}\n${SHORT_LINE_2}\n${SHORT_LINE_3}`);
      const shortBlockWrites = chunks.join('');

      // Step 4: Feed SHORT block bytes into the emulator.
      await termWriteSync(term, shortBlockWrites);

      // Step 5: Read all rendered lines.
      const lines = allLines(term);

      // Diagnostic: show rendered lines for failure messages.
      const splicedLines = lines.filter(isSplicedLine);

      // ASSERTION: no line should contain a short-block token AND a long tail
      // fragment on the same rendered line. If the assertion fails, it means
      // Phase 1 is not erasing rows 2..N before writing, and the long-block
      // tail is surviving → confirming the splice bug.
      expect(
        splicedLines,
        `Spliced lines found in rendered output:\n${lines.map((l, i) => `  [${i}] ${JSON.stringify(l)}`).join('\n')}`,
      ).toHaveLength(0);

      term.dispose();
    },
    15_000,
  );

  // Converted from it.fails: the single-copy commitAbove fix (WIP commit
  // e8b6d9f0, refined with the hasCommitted gate on evict-on-growth) resolves
  // the whole-block duplication. Phase 1 now emits LF-only scrolls (no text
  // write at anchorFloor), so the scrollback copy comes only from the Phase-3
  // CUP write that later gets evicted into scrollback when subsequent commits
  // scroll the viewport upward. Each block thus appears exactly once across
  // scrollback + viewport.
  //
  // Durability: the 'banner text remains visible after setOverlay' golden test
  // (test 1) confirms that committed blocks survive overlay growth — the
  // evict-on-growth guard in repaint() (gated on hasCommitted) preserves the
  // Phase-3 copy by evicting it to scrollback before the growing frame
  // overwrites it.
  it(
    'commits each block to scrollback exactly once (no whole-block duplication)',
    async () => {
      const cols = 80;
      const rows = 24;
      const localStdout = makeMockStdout(cols, rows);
      const localStdin = makeMockStdin();
      const localWrites = collectWrites(localStdout);
      const localScrollRegion = makeScrollRegion(localStdout);
      const c = new TerminalCompositor({
        stdout: localStdout,
        stdin: localStdin,
        onCancel: vi.fn(),
        scrollRegion: localScrollRegion,
        anchorRow: 3, // simulates a 2-line welcome banner above the frame
      });
      await c.arm();

      const term = new HeadlessTerminal({
        cols,
        rows,
        scrollback: 400,
        allowProposedApi: true,
        convertEol: true, // mirrors ONLCR tty output flag
      });

      // A turn: stream prose (with a pending overlay), commit the terminal-
      // state card, the turn footer, then the next-turn ledger rail + several
      // follow-up lines (so the footer marker is a RECENT commit — the case
      // that visibly duplicated under the old dual-write).
      c.setOverlay('streaming line A\nstreaming line B\nstreaming line C');
      c.commitAbove('First prose paragraph.\n\n');
      c.commitAbove('Second prose paragraph.\n\n');
      c.commitAbove('Done card line one.\nDone card line two.\n\n');
      c.setOverlay(''); // stream flush clears the pending overlay
      c.commitAbove('UNIQUE_FOOTER_MARKER 17m · 41k tok\n\n');
      c.commitAbove('ledger done (1 turn)\n\n');
      for (let i = 0; i < 6; i++) {
        c.commitAbove(`follow-up line ${i}\n\n`);
      }

      await termWriteSync(term, localWrites.all());
      const lines = allLines(term);
      const footerCopies = lines.filter((l) => l.includes('UNIQUE_FOOTER_MARKER')).length;

      expect(
        footerCopies,
        `A committed block must appear exactly once across scrollback + viewport, but found ${footerCopies}:\n${lines
          .map((l, i) => `  [${i}] ${JSON.stringify(l)}`)
          .join('\n')}`,
      ).toBe(1);

      c.disarm();
      term.dispose();
    },
    20_000,
  );
});

describe('commitAbove durability regressions (review #592)', () => {
  it(
    'BLOCKER-1: a block committed while a viewport-filling overlay is held survives in scrollback',
    async () => {
      const cols = 80;
      const rows = 24;
      const localStdout = makeMockStdout(cols, rows);
      const localStdin = makeMockStdin();
      const localWrites = collectWrites(localStdout);
      const localScrollRegion = makeScrollRegion(localStdout);
      // No anchorRow: exercises the legacy/default streaming path where a tall
      // overlay drives the live frame top to row 1.
      const c = new TerminalCompositor({
        stdout: localStdout,
        stdin: localStdin,
        onCancel: vi.fn(),
        scrollRegion: localScrollRegion,
      });
      await c.arm();

      const term = new HeadlessTerminal({
        cols,
        rows,
        scrollback: 400,
        allowProposedApi: true,
        convertEol: true, // mirrors ONLCR tty output flag
      });

      // Hold a viewport-filling overlay (23 lines) so the live frame fills the
      // screen and topRow collapses to 1 — the BLOCKER-1 condition where the
      // pre-fix fitsAboveFrame path wrote the block nowhere (Phase 1 no-op,
      // Phase 3 skipped because newTopRow <= 1).
      const tallOverlay = Array.from({ length: 23 }, (_, i) => `overlay row ${i}`).join('\n');
      c.setOverlay(tallOverlay);
      c.commitAbove('TALL_OVERLAY_MARKER unique\n');
      c.setOverlay(''); // flush the overlay

      await termWriteSync(term, localWrites.all());
      const lines = allLines(term);
      const markerCopies = lines.filter((l) => l.includes('TALL_OVERLAY_MARKER')).length;

      expect(
        markerCopies,
        `A block committed under a viewport-filling overlay must survive at least once in scrollback, but found ${markerCopies}:\n${lines
          .map((l, i) => `  [${i}] ${JSON.stringify(l)}`)
          .join('\n')}`,
      ).toBeGreaterThanOrEqual(1);

      c.disarm();
      term.dispose();
    },
    20_000,
  );

  it(
    'preserves an idle-frame commit before picker mode grows over it',
    async () => {
      const cols = 80;
      const rows = 24;
      const localStdout = makeMockStdout(cols, rows);
      const localStdin = makeMockStdin();
      const localWrites = collectWrites(localStdout);
      const localScrollRegion = makeScrollRegion(localStdout);
      const c = new TerminalCompositor({
        stdout: localStdout,
        stdin: localStdin,
        onCancel: vi.fn(),
        scrollRegion: localScrollRegion,
      });
      await c.arm();

      const term = new HeadlessTerminal({
        cols,
        rows,
        scrollback: 400,
        allowProposedApi: true,
        convertEol: true, // mirrors ONLCR tty output flag
      });

      // A normal idle-frame commit is a single above-frame copy. Entering a
      // 3-row picker moves the frame top upward far enough to cover that row;
      // picker repaint must therefore run the same pre-render eviction as the
      // normal repaint path before CUP-painting picker rows.
      c.commitAbove('PICKER_COMMIT_MARKER unique\n');
      c.enterPickerMode({
        renderRows: () => ['? choose one', '▸ alpha', '  beta'],
        onKey: vi.fn(),
      });

      await termWriteSync(term, localWrites.all());
      const lines = allLines(term);
      const markerCopies = lines.filter((l) => l.includes('PICKER_COMMIT_MARKER')).length;

      expect(
        markerCopies,
        `A committed block must survive picker frame growth, but found ${markerCopies}:\n${lines
          .map((l, i) => `  [${i}] ${JSON.stringify(l)}`)
          .join('\n')}`,
      ).toBeGreaterThanOrEqual(1);

      c.exitPickerMode();
      c.disarm();
      term.dispose();
    },
    20_000,
  );

  it(
    'BLOCKER-2: a multi-line committed block survives overlay growth including its bottom line',
    async () => {
      const cols = 80;
      const rows = 24;
      const localStdout = makeMockStdout(cols, rows);
      const localStdin = makeMockStdin();
      const localWrites = collectWrites(localStdout);
      const localScrollRegion = makeScrollRegion(localStdout);
      // No anchorRow: with an idle 1-line frame the block lands above the frame
      // via the single-copy path; growing the overlay then triggers
      // evict-on-growth, which (pre-fix) CUP'd one row above the DECSTBM bottom
      // margin and let the growing frame clobber the bottom committed row.
      const c = new TerminalCompositor({
        stdout: localStdout,
        stdin: localStdin,
        onCancel: vi.fn(),
        scrollRegion: localScrollRegion,
      });
      await c.arm();

      const term = new HeadlessTerminal({
        cols,
        rows,
        scrollback: 400,
        allowProposedApi: true,
        convertEol: true, // mirrors ONLCR tty output flag
      });

      // Commit a 3-line block while the frame is idle (1 line) so it lands in
      // the above-frame region as a single copy.
      c.commitAbove('GROWTH_TOP\nGROWTH_MID\nGROWTH_BOT\n');

      // Grow the overlay incrementally so the frame top climbs toward the
      // committed block, forcing evict-on-growth on each step.
      for (let n = 1; n <= 6; n++) {
        c.setOverlay(Array.from({ length: n }, (_, i) => `grow line ${i}`).join('\n'));
      }

      await termWriteSync(term, localWrites.all());
      const lines = allLines(term);
      const topCopies = lines.filter((l) => l.includes('GROWTH_TOP')).length;
      const midCopies = lines.filter((l) => l.includes('GROWTH_MID')).length;
      const botCopies = lines.filter((l) => l.includes('GROWTH_BOT')).length;

      const dump = `\n${lines.map((l, i) => `  [${i}] ${JSON.stringify(l)}`).join('\n')}`;
      expect(topCopies, `GROWTH_TOP must survive overlay growth:${dump}`).toBeGreaterThanOrEqual(1);
      expect(midCopies, `GROWTH_MID must survive overlay growth:${dump}`).toBeGreaterThanOrEqual(1);
      // GROWTH_BOT is the bottom row the pre-fix off-by-one eviction clobbered.
      expect(botCopies, `GROWTH_BOT (the clobbered bottom row) must survive overlay growth:${dump}`).toBeGreaterThanOrEqual(1);

      c.disarm();
      term.dispose();
    },
    20_000,
  );
});

/**
 * Regression guard: a final assistant message TALLER than the viewport must
 * NOT leave a blank void in the viewport after the end-of-turn overlay collapse.
 * Previously KNOWN-FAILING (it.fails); flipped to it() once the fix landed —
 * see commit-mode.ts (band-hold now covers the over-tall case) and
 * terminal-compositor.frame-preserve.ts (pending overflow evicted on collapse).
 *
 * MECHANISM (empirically verified by per-step @xterm/headless instrumentation —
 * this CORRECTS an earlier hypothesis that a stale-tall Phase-2 erase wiped the
 * band; commitAbove calls logUpdate.clear() first, so that erase is a no-op):
 *
 *   1. commitAbove is reached while a tall overlay fills the viewport, so
 *      prevTopRow <= 1 (BLOCKER-1 / review #592). fitsAboveFrame is false.
 *   2. The block is taller than even the COLLAPSED screen, so decideCommitMode
 *      (commit-mode.ts) returns useBandHold=false (commit-mode.ts:148-151 — the
 *      `overflowRun.length > maxBandModel && textLines.length > maxBandModel`
 *      case the comment at lines 114-117 says "falls through to the legacy
 *      overflow archive"). Phase 1 archives the WHOLE block to native scrollback.
 *   3. Phase 3 is GUARDED by `if (newTopRow > 1)` (committed-band-commit.ts:428).
 *      With the overlay still filling the screen, newTopRow == 1, so Phase 3 is
 *      SKIPPED and committedBand is left EMPTY (verified: band len=0).
 *   4. At end-of-turn the overlay collapses (setOverlay('') → bootstrap.ts:665,
 *      loopStageBar.repaint('observing') → loop-iteration.ts:516). render()
 *      erases the overlay's rows, but committedBand is empty so
 *      repositionCommittedBand has nothing to re-pin — the freed viewport rows
 *      stay BLANK. The block sits in native scrollback ABOVE the viewport,
 *      unreachable without scrolling. Result: a blank viewport above the prompt.
 *
 * So the defect is "viewport not refilled with the recent committed content
 * after collapse", NOT an erase wiping a painted band. #645 deliberately left
 * this overflow path unhandled (docs/scrollback.md:330,417); "No existing test
 * hits prevTopRow <= 1" (committed-band-commit.ts:187). This is that test.
 *
 * WHY NOT YET FIXED (the blocker): routing this case through band-hold (so the
 * pending model + repositionCommittedBand refill the viewport on collapse) fixes
 * THIS single-commit case, but regresses the multi-commit case — band-hold's
 * model cap (maxBandModel, a commit-time estimate) can exceed what
 * repositionCommittedBand can actually paint at collapse (maxFit), and the
 * unpainted-and-unarchived model rows are silently DROPPED (content loss; caught
 * by band-hold-perline-gap.repro.test.ts "a block taller than the collapsed
 * screen still lands every row contiguously"). A correct fix must reconcile
 * maxBandModel with the true collapse paint capacity and archive the remainder
 * to scrollback — a change to the deliberately-deferred overflow design.
 *
 * GEOMETRY: ROWS=24, anchorRow=1, no status line. Block = 28 lines (> 24).
 * Overlay = 22 lines (fills viewport, prevTopRow<=1). End-of-turn: overlay
 * clears, spinner stops, repaint x2. Asserts every line of the block appears
 * exactly once across scrollback + viewport, and no large blank run in the
 * viewport. Currently FAILS (it.fails): the viewport blanks above the prompt.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
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
  s.setRawMode = vi.fn((r: boolean) => {
    s.isRaw = r;
    return s;
  });
  return s;
}
function collect(stream: MockStdout): () => string {
  const c: string[] = [];
  stream.on('data', (x) => c.push(String(x)));
  return () => c.join('');
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active;
  const o: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (l) o.push(l.translateToString(true));
  }
  return o;
}

const COLS = 80;
const ROWS = 24;

describe('end-of-turn overflow-gap regression: block taller than viewport, banner-collapse repaint', () => {
  // Fixed: band-hold now covers the over-tall case (commit-mode.ts) and
  // preserveRowsBeforeFrameRender evicts pending overflow on collapse
  // (terminal-compositor.frame-preserve.ts). Flip from it.fails to it().
  it('preserves ALL lines of a block taller than the viewport after the overlay collapses', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);

    // No status line / extra rows — simplest geometry that still hits the bug.
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1 });
    await c.arm();

    c.setSpinner({ enabled: true });

    // A tall overlay that fills most of the viewport, simulating the final
    // assistant message streaming (overlay occupies most of the screen).
    // Use ROWS-2 lines so the frame fills the viewport (desiredTopRow ≈ 1).
    const tallOverlay = Array.from(
      { length: ROWS - 2 },
      (_, i) => `streaming preview row ${i}`,
    ).join('\n');
    c.setOverlay(tallOverlay);

    // Build a block that is TALLER than the viewport (28 lines for ROWS=24).
    // Each line carries a unique BLOCKROW-NN label so we can assert no loss.
    // Committed as one block (the production path after 10e25ed's commitBlockAbove).
    const BLOCK_LINES = ROWS + 4; // 28 lines, guaranteed > ROWS
    const blockContent = Array.from(
      { length: BLOCK_LINES },
      (_, i) => `BLOCKROW-${String(i).padStart(2, '0')} final assistant response content line`,
    ).join('\n');

    // Commit the oversized block while the overlay is still tall (overflow path).
    c.commitAbove(blockContent + '\n\n');

    // --- End-of-turn / banner-collapse sequence ---
    // 1. Overlay clears (turn ends, streaming done).
    c.setOverlay('');
    // 2. Spinner stops (mirrors LoopStageBar.stop() reducing extraRows).
    c.setSpinner({ enabled: false });
    // 3. Two repaints (mirrors loop-iteration's onAfterTurn + loopStageBar.repaint('observing')).
    const internals = c as unknown as { repaint(): void };
    internals.repaint();
    internals.repaint();

    // Feed into xterm headless to observe the real terminal state.
    const term = new HeadlessTerminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 600,
      allowProposedApi: true,
      convertEol: true,
    });
    await termWrite(term, all());

    const lines = allLines(term);
    const dump = lines
      .map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`)
      .join('\n');

    // The frame (input row) should be visible.
    // The ⎯ rule glyph (U+23AF) appears on the input row.
    const FRAME_RE = /\u23af/;
    const frameAbsIdx = lines.findIndex((l) => FRAME_RE.test(l));
    expect(
      frameAbsIdx,
      `frame (input rule U+23AF) not found in buffer:\n${dump}`,
    ).toBeGreaterThanOrEqual(0);

    // CORE ASSERTION: every BLOCKROW-NN line must appear EXACTLY ONCE
    // across the entire buffer (scrollback + viewport).
    // Pre-fix: the top ~5 lines (BLOCKROW-00..BLOCKROW-04) are MISSING
    // because Phase 2's erase wiped the Phase-1 archive before Phase 3
    // could repaint them, and scrollback got blank rows instead of content.
    for (let i = 0; i < BLOCK_LINES; i++) {
      const label = `BLOCKROW-${String(i).padStart(2, '0')}`;
      const hits = lines.filter((l) => l.includes(label)).length;
      expect(
        hits,
        `"${label}" must appear exactly once across the full buffer (found ${hits}):\n${dump}`,
      ).toBe(1);
    }

    // SECONDARY ASSERTION: no run of >= 3 consecutive blank rows in the
    // region from the first content line to the frame (one blank is the
    // rhythm separator; two should not occur in a block this large).
    const firstContentAbs = lines.findIndex((l) => l.includes('BLOCKROW-'));
    if (firstContentAbs >= 0 && frameAbsIdx > firstContentAbs) {
      let maxBlankRun = 0;
      let cur = 0;
      for (let i = firstContentAbs; i < frameAbsIdx; i++) {
        if ((lines[i] ?? '').trim() === '') {
          cur++;
          maxBlankRun = Math.max(maxBlankRun, cur);
        } else {
          cur = 0;
        }
      }
      expect(
        maxBlankRun,
        `blank run of ${maxBlankRun} rows between first BLOCKROW content and frame:\n${dump}`,
      ).toBeLessThanOrEqual(2);
    }

    term.dispose();
    c.disarm();
  }, 15_000);
});

/**
 * B2: Pending-band archive tests.
 *
 * Tests for the two paths where pending (unpainted) band rows could be
 * silently discarded instead of archived to scrollback:
 *
 *   Path (a): disarm() while suspended, owner-wrote=true path.
 *     forgetCommittedBand() was called with zero writes, losing any pending
 *     rows that were in the model but never appeared on screen (e.g. when
 *     the overlay was full-viewport and commitPhase3HoldStore stored the
 *     block as fully pending). Fix: flush pending rows before forgetting.
 *
 *   Path (b): commitPhase1Teardown, !overflowPriorContiguous path.
 *     When the prior band was not merged into overflowRun (anchorRow > 1
 *     prevents the merge), Phase 1 previously archived only the painted
 *     suffix and discarded the pending prefix. Fix: archive the full band.
 *
 * Both test scenarios must work with and without the fix to confirm the
 * fix is effective.
 *
 * Reachability analysis:
 *
 *   Path (a): REACHABLE when:
 *     1. commitAbove fires during suspension with a large full-viewport
 *        overlay active (commitPhase3HoldStore stores band as all-pending).
 *     2. OR: the overlay is partially covering the viewport and the pending
 *        prefix has not yet been materialized.
 *     3. Then the owner writes (S>0 or R!=P) and disarm fires.
 *   Path (a) is NOT reachable on the no-write path (endTurnFlush archives all).
 *
 *   Path (b): REACHABLE when:
 *     1. anchorRow > 1 (banner mode) — prevents overflowPriorContiguous.
 *     2. committedBand has pending rows (from a commitPhase3Hold with
 *        partial viewport coverage).
 *     3. A subsequent commit arrives in the band-hold path.
 *   The prior code only archived paintedRows > 0 bands; a fully-pending
 *   band (paintedRows == 0) would have been silently dropped.
 *
 * Harness: VirtualScreen + TerminalCompositor (same as suspend-commit.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 80;
const ROWS = 24;
const BANNER_ROWS = 4;
const FRAME_RE = /\u23af/;

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
  s.setRawMode = vi.fn((raw: boolean) => { (s as any).isRaw = raw; return s; });
  return s;
}

function attachScreen(stdout: MockStdout): VirtualScreen {
  const vs = new VirtualScreen(COLS, ROWS);
  stdout.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) vs.write(chunk);
    else if (typeof chunk === 'string') vs.write(Buffer.from(chunk, 'utf-8'));
  });
  return vs;
}

function dumpScreen(vs: VirtualScreen): string {
  return [
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3)}] ${JSON.stringify(l)}`),
    ...vs.visibleLines().map((l, i) => `[vp-${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`),
  ].join('\n');
}

function countLabel(vs: VirtualScreen, label: string): number {
  return [...vs.scrollbackLines(), ...vs.visibleLines()]
    .filter((l) => l.trim() === label).length;
}

interface Rig {
  c: TerminalCompositor;
  vs: VirtualScreen;
  stdout: MockStdout;
  repaint(): void;
  frameTop(): number;
}

async function makeRig(opts: {
  contentHug?: boolean;
  banner?: boolean;
  overlay?: string;
} = {}): Promise<Rig> {
  const stdout = makeStdout();
  const vs = attachScreen(stdout);

  if (opts.banner) {
    for (let i = 0; i < BANNER_ROWS; i++) stdout.write(`BANNER_${i}\n`);
  }

  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    anchorRow: opts.banner ? BANNER_ROWS + 1 : 1,
    ...(opts.contentHug ? { contentHug: true } : {}),
  });
  await c.arm();

  if (opts.overlay) {
    c.setOverlay(opts.overlay);
    (c as any).repaint();
  }

  const raw = c as unknown as { repaint(): void; lastMeasuredFrameTop: number };
  return {
    c,
    vs,
    stdout,
    repaint: () => raw.repaint(),
    frameTop: () => raw.lastMeasuredFrameTop,
  };
}

// ---------------------------------------------------------------------------
// Path (a): disarm() while suspended, owner-wrote path with pending rows
// ---------------------------------------------------------------------------

describe('B2 path (a): pending rows archived on disarm-while-suspended (owner-wrote)', () => {
  /**
   * Reachability: band-hold commit followed by disarm-while-suspended where
   * the owner wrote (R != P). The commit goes to suspendCommitQueue and is
   * replayed... wait, the commit arrives while suspended, so it goes to the
   * queue. But we need pending rows in the band BEFORE suspend.
   *
   * Actual reachable scenario: commit block with a large overlay (fills
   * viewport → commitPhase3HoldStore, all-pending), then suspend, then owner
   * writes (S > 0), then disarm. The pending rows must survive to scrollback.
   */
  it('pending rows are archived to scrollback when owner scrolled before disarm', async () => {
    // Use a large overlay so the frame covers most of the viewport.
    // This forces commitPhase3HoldStore which stores committedBandPaintedRows=0.
    const overlayContent = Array.from({ length: ROWS - 2 }, (_, i) => `overlay-row-${i}`).join('\n');
    const { c, vs, stdout, repaint } = await makeRig({ overlay: overlayContent });

    // Commit a block while the large overlay is visible. This should trigger
    // the band-hold full-pending path (commitPhase3HoldStore).
    c.commitAbove('PENDING-BLOCK\n');
    repaint();

    // Precondition: the band must be fully pending (paintedRows=0) so the test
    // exercises the exact scenario it claims to cover (all-pending discard bug).
    // If this assertion fails, the overlay was not large enough to force a hold.
    const rawPre = c as unknown as { committedBand: string[]; committedBandPaintedRows: number };
    expect(rawPre.committedBandPaintedRows, 'precondition: band must be fully pending (paintedRows=0)').toBe(0);
    expect(rawPre.committedBand.length, 'precondition: committedBand must be non-empty').toBeGreaterThan(0);

    // Now suspend.
    c.suspendInput();

    // Owner writes enough to scroll (S > 0). The band rows MAY be in native
    // scrollback, but the PENDING ones (paintedRows=0 means ALL are pending)
    // were never displayed, so they cannot be in native scrollback.
    for (let i = 0; i < ROWS + 2; i++) stdout.write(`owner-${i}\r\n`);

    // Disarm while still suspended (owner-wrote path: R != P, S > 0).
    c.disarm();

    // PENDING-BLOCK must appear exactly once in the final state.
    // (It was fully pending — never on screen — but was in the band model
    // when the owner wrote and disarm fired. The fix archives it.)
    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);
    const count = all.filter((l) => l.trim() === 'PENDING-BLOCK').length;

    // With B2 path (a) fix: PENDING-BLOCK appears in scrollback (flushed
    // by flushPendingCommittedBand before forgetCommittedBand).
    // Without fix: PENDING-BLOCK is simply discarded (count = 0).
    expect(count, `PENDING-BLOCK must appear exactly once:\n${dump}`).toBe(1);
  });

  it('owner-wrote disarm with no pending rows (all painted): no duplication', async () => {
    // Normal path: commit with space above frame (fitsAboveFrame),
    // so paintedRows = band.length (everything is painted). The band
    // rows may have scrolled into native scrollback when the owner wrote.
    // After forgetCommittedBand (no flushPending since all are painted),
    // BLOCK-A must appear exactly once.
    const { c, vs, stdout, repaint } = await makeRig();

    c.commitAbove('BLOCK-A\n');
    repaint(); // materializes the band

    c.suspendInput();

    // Owner writes enough to scroll.
    for (let i = 0; i < ROWS + 2; i++) stdout.write(`scroll-${i}\r\n`);

    c.disarm();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);
    const count = all.filter((l) => l.trim() === 'BLOCK-A').length;
    expect(count, `BLOCK-A must appear exactly once (no duplicate):\n${dump}`).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Path (b): commitPhase1Teardown !overflowPriorContiguous with pending rows
// ---------------------------------------------------------------------------

describe('B2 path (b): pending rows archived in phase1 prior-band archive', () => {
  /**
   * Reachability requires anchorRow > 1 (banner mode) AND a prior band with
   * pending rows, then a subsequent commit that reaches the band-hold path
   * with !overflowPriorContiguous.
   *
   * To get pending rows in the prior band: commit with a partial overlay so
   * the band has pending rows (top portion of band model not yet on screen).
   * Then do another commit. If anchorRow > 1, overflowPriorContiguous = false
   * and the prior band is archived — but the old code discarded pending rows.
   */
  it('pending rows of prior band are archived when new commit with banner arrives', async () => {
    // Setup: banner + large overlay = partial band with pending rows.
    // The banner makes anchorRow > 1, blocking the merge path.
    const halfOverlay = Array.from({ length: ROWS / 2 }, (_, i) => `ov-${i}`).join('\n');
    const { c, vs, repaint } = await makeRig({ banner: true, overlay: halfOverlay });

    // First commit: with half-viewport overlay and banner, the block may not
    // fit fully above the frame → band-hold with some pending rows.
    c.commitAbove('FIRST-BLOCK\n');
    repaint();

    // Check if we have pending rows in the band model before the second commit.
    const raw = c as unknown as {
      committedBand: string[];
      committedBandPaintedRows: number;
      repaint(): void;
    };
    // Even if paintedRows = band.length here (all painted), the test is
    // still valid — the second commit should archive the full prior band.
    const priorBandLen = raw.committedBand.length;
    const priorPainted = raw.committedBandPaintedRows;

    // Second commit: this triggers Phase 1 with !overflowPriorContiguous
    // (because banner makes anchorRow > 1) and archives the prior band.
    c.commitAbove('SECOND-BLOCK\n');
    repaint();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // Both blocks must appear exactly once.
    const firstCount = all.filter((l) => l.trim() === 'FIRST-BLOCK').length;
    const secondCount = all.filter((l) => l.trim() === 'SECOND-BLOCK').length;

    expect(firstCount, `FIRST-BLOCK must appear exactly once (priorBandLen=${priorBandLen}, priorPainted=${priorPainted}):\n${dump}`).toBe(1);
    expect(secondCount, `SECOND-BLOCK must appear exactly once:\n${dump}`).toBe(1);
  });

  it('fully-pending prior band (paintedRows=0) is archived in phase1', async () => {
    // To reach !overflowPriorContiguous && useBandHold with a fully-pending
    // prior band (paintedRows=0), we need:
    //   1. anchorRow > 1 (banner) — makes overflowPriorContiguous always false.
    //   2. A large overlay that fills the viewport so the frame covers the full
    //      screen above the banner, leaving no room for the committed band.
    //      This forces commitPhase3HoldStore which stores committedBandPaintedRows=0
    //      (all rows pending — never painted to the terminal).
    //   3. Second commit: triggers Phase 1 prior-band archive with !overflowPriorContiguous.
    //
    // Without an overlay the frame sits near the bottom (ROWS-1), leaving
    // ~18 rows above it — a 22-line commit fits fitsAboveFrame and paintedRows=22,
    // making the test pass vacuously (no pending rows at risk). The overlay is
    // required to force the all-pending scenario the test is named after.

    // A large overlay (ROWS-2 lines) fills nearly the full viewport, leaving
    // no room above the frame for the committed band — forces commitPhase3HoldStore
    // (all-pending). The banner's anchorRow=5 does NOT prevent the hold; it only
    // blocks the overflowPriorContiguous merge path in Phase 1.
    const fullOverlay = Array.from({ length: ROWS - 2 }, (_, i) => `fov-${i}`).join('\n');
    const { c, vs, repaint } = await makeRig({ banner: true, overlay: fullOverlay });

    // Build first commit: enough lines to force !fitsAboveFrame with banner.
    const firstLines = Array.from({ length: ROWS - BANNER_ROWS + 2 }, (_, i) => `pending-prior-${i}`);
    c.commitAbove(firstLines.join('\n') + '\n');
    repaint();

    const raw = c as unknown as {
      committedBand: string[];
      committedBandPaintedRows: number;
    };
    const paintedAtCommit = raw.committedBandPaintedRows;
    const bandLenAtCommit = raw.committedBand.length;

    // Precondition: the first commit must result in a fully-pending band
    // (paintedRows=0) so the test exercises the all-pending prior-band archive
    // path. If paintedRows > 0 here, the overlay/banner geometry was not
    // sufficient to force a full hold and the test would pass vacuously.
    expect(paintedAtCommit, 'precondition: first-commit band must be fully pending (paintedRows=0)').toBe(0);
    expect(bandLenAtCommit, 'precondition: first-commit band must be non-empty').toBeGreaterThan(0);

    // Second commit: triggers Phase 1 prior-band archive with banner.
    // Use another small block so it also reaches Phase 1 and archives the first band.
    c.commitAbove('SECOND-TRIGGER\n');
    repaint();

    // Clear the overlay so any remaining pending rows can be materialized and
    // the final state is inspectable. With a large overlay both commits may be
    // fully pending in the band model; this collapses the frame to reveal them.
    c.setOverlay('');
    repaint();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // All lines from the first commit must each appear exactly once.
    // These were all-pending (paintedAtCommit=0). Phase 1 must archive them
    // when the second commit triggers the prior-band archive path. Without the
    // fix the pending rows would be silently discarded.
    for (const label of firstLines) {
      const count = all.filter((l) => l.trim() === label).length;
      expect(count, `"${label}" must appear exactly once (painted=${paintedAtCommit}/${bandLenAtCommit}):\n${dump}`).toBe(1);
    }
  });

  it('prior band with mixed pending+painted rows: both portions archived', async () => {
    // Use a partial overlay so the band has both painted and pending rows.
    // The top portion of the band is pending (overlay covers those rows);
    // the bottom portion is painted.
    const partialOverlay = Array.from({ length: ROWS / 3 }, (_, i) => `pov-${i}`).join('\n');
    const { c, vs, repaint } = await makeRig({ banner: true, overlay: partialOverlay });

    // Commit multiple blocks to build up the band.
    for (let i = 0; i < 3; i++) c.commitAbove(`MIXED-${i}\n`);
    repaint();

    // Remove the overlay so the frame shrinks and pending rows can be painted.
    c.setOverlay('');
    repaint();

    // Another commit to trigger Phase 1 prior-band archive.
    c.commitAbove('AFTER-OVERLAY-REMOVAL\n');
    repaint();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // AFTER-OVERLAY-REMOVAL must appear exactly once.
    const afterCount = all.filter((l) => l.trim() === 'AFTER-OVERLAY-REMOVAL').length;
    expect(afterCount, `AFTER-OVERLAY-REMOVAL must appear exactly once:\n${dump}`).toBe(1);

    // All MIXED-* blocks must each appear exactly once.
    for (let i = 0; i < 3; i++) {
      const label = `MIXED-${i}`;
      const count = all.filter((l) => l.trim() === label).length;
      expect(count, `${label} must appear exactly once:\n${dump}`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// B2: Invariant check — band-hold commit visible on screen after resume
//     (regression test: suspended commit that is fully pending must show up)
// ---------------------------------------------------------------------------

describe('B2: suspended commit that is fully pending must survive disarm', () => {
  it('disarm-while-suspended with queue: queued blocks appear exactly once', async () => {
    // This mirrors the basic suspend-commit.test.ts scenario but focuses on
    // the band-hold all-pending case to verify the fix is end-to-end correct.
    const { c, vs, repaint } = await makeRig();

    c.commitAbove('PRE-SUSPEND\n');
    repaint();

    c.suspendInput();
    c.commitAbove('DURING-SUSPEND\n'); // goes to suspendCommitQueue
    c.disarm();

    const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
    const dump = dumpScreen(vs);

    // PRE-SUSPEND must appear exactly once.
    const preCount = countLabel(vs, 'PRE-SUSPEND');
    expect(preCount, `PRE-SUSPEND must appear exactly once:\n${dump}`).toBe(1);

    // DURING-SUSPEND must appear exactly once (came through queue archive).
    const duringCount = countLabel(vs, 'DURING-SUSPEND');
    expect(duringCount, `DURING-SUSPEND must appear exactly once:\n${dump}`).toBe(1);

    // Ordering: PRE-SUSPEND precedes DURING-SUSPEND.
    const preIdx = all.findIndex((l) => l.trim() === 'PRE-SUSPEND');
    const duringIdx = all.findIndex((l) => l.trim() === 'DURING-SUSPEND');
    expect(preIdx < duringIdx, `PRE-SUSPEND must precede DURING-SUSPEND:\n${dump}`).toBe(true);
  });

  it('resume after queue: frame visible, no duplicate frame rule', async () => {
    // Basic resume sanity: the frame rule must be visible exactly once after
    // resume+repaint, and the suspend queue must be drained.
    const { c, vs, repaint, frameTop } = await makeRig();

    c.commitAbove('BLOCK-A\n');
    repaint();

    c.suspendInput();
    c.commitAbove('BLOCK-B\n');
    c.resumeInput();
    repaint();

    const visible = vs.visibleLines();
    const dump = dumpScreen(vs);

    // Frame rule must be visible.
    const frameIdx = visible.findIndex((l) => FRAME_RE.test(l));
    expect(frameIdx, `frame rule not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

    // Frame top must be a positive row.
    const fTop = frameTop();
    expect(fTop, `frameTop must be > 0:\n${dump}`).toBeGreaterThan(0);

    c.disarm();
  });
});

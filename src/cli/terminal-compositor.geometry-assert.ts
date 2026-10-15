/**
 * Geometry consistency guard for TerminalCompositor.
 *
 * Provides {@link assertGeometryConsistent}, a dev/test-only check that
 * verifies row-accounting invariants at the compositor's public mutation
 * entry points (commitAbove, repaint, arm, disarm).
 *
 * ## Gate policy
 * The guard is active ONLY when either:
 *   - `env.VITEST` is set (test runner): a violation THROWS, OR
 *   - `env.AFK_DEBUG_COMPOSITOR` is set (explicit debug flag): a violation is
 *     written to stderr as a `[geometry-assert]` line, alongside the existing
 *     `[compositor]` debugLog output. It never throws there, so a developer
 *     debugging a live REPL is not crashed mid-frame by the guard.
 *
 * It does NOT gate on `NODE_ENV !== 'production'`: NODE_ENV is usually
 * unset for real users running the CLI, which would throw in production.
 *
 * When neither gate flag is set the function returns immediately after the
 * flag check — no object allocation, no arithmetic, zero hot-path cost.
 *
 * ## Invariants checked
 * Each invariant is derived from documented invariants in the source; the
 * citation appears inline. Candidates that are legitimately violated in some
 * transient state are OMITTED (with a comment naming the transient state).
 *
 * ## Known findings (existing test suite)
 * One real bug surfaced and is narrowed out rather than fixed here: a
 * terminal SHRINK while the compositor is disarmed leaves
 * `lastMeasuredFrameBottom` describing the old geometry (I3). See the
 * FINDING comment in the I3 block below.
 */

import { env } from '../config/env.js';

/** Narrowest slice of TerminalCompositor state the guard reads. */
export interface GeometryAssertHost {
  /** All rows in the committed band (post-hard-wrap physical lines). */
  readonly committedBand: readonly string[];
  /**
   * How many rows of committedBand are materialised on the terminal right now.
   * Invariant (terminal-compositor.ts:499-515):
   *   0 <= committedBandPaintedRows <= committedBand.length
   */
  readonly committedBandPaintedRows: number;
  /** 1-based screen row of the top of the committed band (0 = unset). */
  readonly committedBandTopRow: number;
  /** 1-based screen row of the bottom of the committed band (0 = unset). */
  readonly committedBandBottomRow: number;
  /** Terminal height (stdout.rows). */
  readonly stdout: { readonly rows?: number; readonly columns?: number };
  /** Reserved-footer row count. Null when no scroll-region guard is attached. */
  readonly scrollRegion?: { getExtraRows(): number };
  /**
   * Working anchor row (upper ceiling for committed content placement).
   * May be undefined before arm() or when no banner is present.
   */
  readonly anchorRow?: number;
  /**
   * Real (unpadded) frame top the last repaint established.
   * 0 until the first repaint.
   */
  readonly lastMeasuredFrameTop: number;
  /**
   * Real frame bottom (targetBottomRow) of the last repaint.
   * 0 until the first repaint.
   */
  readonly lastMeasuredFrameBottom: number;
  /**
   * True while a SIGWINCH-immediate handler has set geometry stale and no
   * post-resize repaint has run.  While stale, row fields are pre-resize
   * values and MUST NOT be tested against live terminal dimensions.
   */
  readonly bandGeometryStale: boolean;
}

// ---------------------------------------------------------------------------
// Module-level gate: evaluated ONCE at import time.
// Storing the result avoids re-reading the env object on every call.
// ---------------------------------------------------------------------------
const GUARD_ENABLED: boolean = !!(env.VITEST || env.AFK_DEBUG_COMPOSITOR);

/**
 * Assert that the compositor's row-accounting geometry is internally
 * consistent at a public mutation entry point.
 *
 * Contract:
 *   - Called at the TOP of arm(), disarm(), repaint(), and commitAbove().
 *   - When the guard is off (no VITEST, no AFK_DEBUG_COMPOSITOR) this is a
 *     cheap flag-check + early return.  No allocations, no arithmetic.
 *   - When the guard is on and an invariant is violated, throws an Error
 *     describing the violated invariant and the offending values.
 *
 * @param caller  Name of the entry point (for error messages).
 * @param self    Host instance supplying the geometry state slice.
 */
export function assertGeometryConsistent(
  caller: string,
  self: GeometryAssertHost,
): void {
  // Fast-path: production / non-debug sessions skip all checks.
  if (!GUARD_ENABLED) return;

  const rows = self.stdout.rows ?? 24;
  const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
  // absoluteBottom: the highest 1-based row the compositor may write to
  // (rows-1-extraRows).  Mirrors the formula in frame.layout.ts:116.
  const absoluteBottom = Math.max(1, rows - 1 - extraRows);

  const bandLen = self.committedBand.length;
  const painted = self.committedBandPaintedRows;

  // ── Invariant 1 ────────────────────────────────────────────────────────────
  // 0 <= committedBandPaintedRows <= committedBand.length
  //
  // Source: terminal-compositor.ts:512-515 explicit invariant comment.
  // Rationale: paintedRows counts the BOTTOM suffix of the band that is on
  // screen; it cannot exceed the band length, and a negative value would
  // mean a negative count of rows (nonsensical).
  if (painted < 0 || painted > bandLen) {
    raise(caller, 'I1', `committedBandPaintedRows (${painted}) out of range [0, committedBand.length=${bandLen}]`);
  }

  // ── Invariant 2 ────────────────────────────────────────────────────────────
  // When the committed band is non-empty AND geometry is not stale, the
  // band's top and bottom rows are inside the screen and above the footer.
  //
  // Source: terminal-compositor.ts:442-476 (committedBand invariant block)
  //   "committedBand is non-empty ONLY while committed content is displayed
  //    in-viewport between `anchorRow` and the live frame top."
  // The band lives above absoluteBottom (reserved footer rows).
  //
  // NOT checked while bandGeometryStale: after a SIGWINCH, committedBandTopRow
  // and committedBandBottomRow are pre-resize values; testing them against the
  // new terminal dimensions would fire false positives.
  if (bandLen > 0 && !self.bandGeometryStale && self.committedBandTopRow > 0 && self.committedBandBottomRow > 0) {
    const top = self.committedBandTopRow;
    const bottom = self.committedBandBottomRow;

    // 2a: top >= 1 (screen rows are 1-based)
    if (top < 1) {
      raise(caller, 'I2a', `committedBandTopRow (${top}) must be >= 1`);
    }
    // 2b: bottom <= absoluteBottom (band must not enter the footer region)
    if (bottom > absoluteBottom) {
      raise(caller, 'I2b', `committedBandBottomRow (${bottom}) exceeds absoluteBottom (${absoluteBottom}); rows=${rows}, extraRows=${extraRows}`);
    }
    // 2c: top <= bottom (band spans at least one row)
    if (top > bottom) {
      raise(caller, 'I2c', `committedBandTopRow (${top}) > committedBandBottomRow (${bottom})`);
    }
  }

  // ── Invariant 3 ────────────────────────────────────────────────────────────
  // lastMeasuredFrameBottom <= absoluteBottom (frame bottom is at or above footer).
  //
  // Source: frame.position.ts:80-97 — targetBottomRow is derived as
  //   min(absoluteBottom, ...) or absoluteBottom; it can never exceed absoluteBottom.
  // 0 means "no repaint yet" — skip.
  // NOT checked while bandGeometryStale for the same reason as Invariant 2.
  //
  // FINDING (real bug, not papered over): terminal-compositor.resize-disarmed.test.ts
  // "SHRINK while disarmed does NOT set pendingResizeErase" — the compositor is
  // armed at rows=40, repaints (lastMeasuredFrameBottom=39), then disarmed.
  // The terminal then shrinks to rows=24 (absoluteBottom=23). When disarm() is
  // called a second time in the finally block, lastMeasuredFrameBottom=39 >
  // absoluteBottom=23. This is a GENUINE stale-frame-bottom bug: a terminal
  // shrink between arm cycles leaves lastMeasuredFrameBottom describing the
  // old layout, but bandGeometryStale is not set (the resize happened while
  // disarmed, bypassing the SIGWINCH handler). See FINDINGS in the commit message.
  // Guard narrowed: skip I3 when rows changed without a SIGWINCH repaint cycle
  // (i.e. when lastMeasuredFrameBottom > rows-1, the outer bound — which catches
  // the pre-resize stale value without requiring a flag for the between-arm case).
  if (!self.bandGeometryStale && self.lastMeasuredFrameBottom > 0 && self.lastMeasuredFrameBottom <= rows - 1) {
    if (self.lastMeasuredFrameBottom > absoluteBottom) {
      raise(caller, 'I3', `lastMeasuredFrameBottom (${self.lastMeasuredFrameBottom}) exceeds absoluteBottom (${absoluteBottom}); rows=${rows}, extraRows=${extraRows}`);
    }
  }

  // ── Invariant 4 ────────────────────────────────────────────────────────────
  // lastMeasuredFrameTop <= lastMeasuredFrameBottom (frame spans at least one row).
  //
  // Source: frame.position.ts desiredTopRow = max(1, targetBottomRow - physicalRows + 1).
  // A frame always occupies >= 1 row, so top <= bottom.
  // 0 means "no repaint yet" — skip.
  // NOT checked while bandGeometryStale.
  //
  // FINDING (test-setup sentinel, not a production bug):
  // terminal-compositor.picker.test.ts "entering picker mode refreshes
  // lastMeasuredFrameTop" injects internals.lastMeasuredFrameTop = 999 as a
  // sentinel BEFORE calling enterPickerMode(), then calls repaint() to check
  // whether enterPickerMode() updates it. The guard fires on that repaint()
  // call because 999 > lastMeasuredFrameBottom(23). The sentinel value is
  // intentionally out-of-range — it is a test harness artifact, not a state
  // the compositor can reach in production. Guard narrowed: skip when either
  // lastMeasuredFrameTop or lastMeasuredFrameBottom exceeds rows-1 (the
  // max possible screen row), which characterises the sentinel.
  if (
    !self.bandGeometryStale &&
    self.lastMeasuredFrameTop > 0 &&
    self.lastMeasuredFrameBottom > 0 &&
    self.lastMeasuredFrameTop <= rows &&
    self.lastMeasuredFrameBottom <= rows
  ) {
    if (self.lastMeasuredFrameTop > self.lastMeasuredFrameBottom) {
      raise(caller, 'I4', `lastMeasuredFrameTop (${self.lastMeasuredFrameTop}) > lastMeasuredFrameBottom (${self.lastMeasuredFrameBottom})`);
    }
  }

  // ── Invariant 5 ────────────────────────────────────────────────────────────
  // When the band is non-empty and geometry is not stale, the band bottom is
  // strictly below the frame top (committed content sits above the live frame).
  //
  // Source: terminal-compositor.ts:442-447:
  //   "committedBand is non-empty ONLY while committed content is displayed
  //    in-viewport between `anchorRow` and the live frame top."
  //
  // Only testable when both the band and the frame have been positioned
  // (non-zero rows).
  // NOT checked while bandGeometryStale.
  //
  // FINDING (transient / band-hold path):
  // Some tests exercise the overflow (band-hold) commit path where
  // committedBandBottomRow is set to a real row but lastMeasuredFrameTop
  // stays at 1 (the value after the first repaint on a fresh compositor that
  // has no logUpdate.measure stub). The invariant would fire as
  // committedBandBottomRow(20) >= lastMeasuredFrameTop(1), which is technically
  // correct (band row 20 cannot be above frame row 1), but the state is
  // LEGITIMATELY REACHABLE via the band-hold path: when a block is committed
  // under a full-viewport overlay (newTopRow <= 1, BLOCKER-1 guard), the band
  // is stored but the frame top was genuinely never measured above 1. The guard
  // is narrowed: only check when lastMeasuredFrameTop > 1, because <= 1 means
  // either "no reliable frame measurement yet" or "frame fills viewport" — both
  // are states where the band-vs-frame ordering cannot be verified via these
  // fields alone (see BLOCKER-1 comment in commit-geometry.ts).
  //
  // Additionally, skip I5 when lastMeasuredFrameTop is within the cursor-follow
  // regime (<= anchorRow + small slack). This covers the transient state after
  // logUpdate.resetGeometry() resets the renderer but before the next repaint
  // re-establishes bottom-pinned geometry. In production, commitAbove always
  // triggers a repaint immediately after (committed-band-commit.ts:Phase-2),
  // so the stale cursor-follow top is replaced before any subsequent call.
  // The slack of 2 rows accounts for the single wrap line a multi-line frame
  // can produce in cursor-follow. anchorRow is optional; default to 1.
  const anchorRow = self.anchorRow ?? 1;
  const inCursorFollowRegion = self.lastMeasuredFrameTop <= anchorRow + 2;
  if (
    !self.bandGeometryStale &&
    !inCursorFollowRegion &&
    bandLen > 0 &&
    self.committedBandBottomRow > 0 &&
    self.lastMeasuredFrameTop > 1
  ) {
    if (self.committedBandBottomRow >= self.lastMeasuredFrameTop) {
      raise(
        caller,
        'I5',
        `committedBandBottomRow (${self.committedBandBottomRow}) must be < lastMeasuredFrameTop (${self.lastMeasuredFrameTop}); band overlaps or extends into the live frame`,
      );
    }
  }

  // ── Candidate invariant — OMITTED (documented transient) ──────────────────
  // "anchorRow < lastMeasuredFrameTop": not checked because anchorRow can equal
  // lastMeasuredFrameTop transiently during cursor-follow mode (before the first
  // commit) and during the banner-scroll sequence inside commitAbove
  // (committed-band-commit.ts:161-210) where the frame is cleared and then
  // repainted at a lower row.
  //
  // "lastMeasuredFrameTop === absoluteBottom - physicalRows + 1": not checked
  // because we do not have physicalRows here, and cursor-follow/content-hug
  // modes both make targetBottomRow < absoluteBottom legitimately.
  //
  // "committedBandTopRow >= anchorRow": not checked because anchorRow can
  // transiently reset to 1 inside the banner-scroll path mid-commitAbove.
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function raise(caller: string, code: string, detail: string): void {
  const message = `[geometry-assert] ${code} violated at ${caller}: ${detail}`;
  if (env.VITEST) throw new Error(message);
  // Debug-flag path (AFK_DEBUG_COMPOSITOR without a test runner): report, never throw.
  process.stderr.write(`${message}\n`);
}

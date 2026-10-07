/**
 * CPR (Cursor Position Report) — tmux-shift delta correction.
 *
 * When a tmux pane grows taller, tmux pulls up to `growth` lines of
 * scrollback history back onto the screen, shifting all visible content AND
 * the cursor DOWN by `delta` rows (equal to the number of history lines
 * pulled). The compositor's absolute row tracking (logUpdate.topRow,
 * committedBandTopRow, pendingResizeErase, etc.) becomes stale — the frame is
 * still painted at the OLD rows while the real content (including the frozen
 * pre-resize copy) now sits `delta` rows lower, causing the visible duplicate.
 *
 * Fix: on a row-count-changing SIGWINCH, emit ESC[6n (Device Status Report
 * — Report Cursor Position). The terminal (and tmux) echoes back ESC[row;colR
 * with the REAL cursor row, which has moved by exactly `delta` rows along
 * with the content. delta = reportedRow − originalExpectedRow. We then shift
 * every tracked absolute row by delta before the next repaint.
 *
 * Safety contracts:
 *   1. The CPR reply MUST be consumed before readline's `keypress` listener
 *      sees it — otherwise `ESC[NN;NNR` leaks into the prompt as literal text.
 *      We install a one-shot `data` listener on stdin BEFORE emitKeypressEvents
 *      can emit the bytes as a keypress. The listener is removed once the reply
 *      arrives or the timeout fires.
 *   2. A short timeout (~120ms) falls back to the existing behaviour when the
 *      terminal does not answer (non-answering terminals, pipes, tests). On
 *      timeout we ALWAYS repaint so the frame reflows to the new geometry.
 *   3. Repaints are suppressed while the CPR is pending so the old stale-row
 *      repaint cannot race the delta correction.
 *   4. A stray/late CPR reply that arrives after the timeout already cleared
 *      the `armed` flag is silently discarded by the data listener guard.
 *
 * Burst correctness — "measure until quiescent" (Tasks 1 & 2):
 *   When a SIGWINCH arrives while a CPR is already in-flight:
 *     • `dirty` is set on the in-flight burst context.
 *     • grow/shrink totals are accumulated (for the plausibility range).
 *     • `currentRows` is updated to the latest terminal row count.
 *     • `originalExpectedRow` is NEVER changed — no render has happened since
 *       the first CPR was requested, so the cursor has only been shifted by
 *       the terminal and `originalExpectedRow` still identifies the pre-burst
 *       cursor position in content-space.
 *   When a CPR reply arrives:
 *     • If `dirty` (a newer SIGWINCH arrived): clear dirty, emit a FRESH CPR
 *       (keeping originalExpectedRow and accumulators), do NOT apply/repaint.
 *       Re-queries are capped at CPR_MAX_REQUERY (8); on cap, fall back + repaint.
 *     • If not dirty (terminal is quiescent): compute
 *       delta = reportedRow − originalExpectedRow, validate plausibility, apply
 *       (if non-zero), then ALWAYS repaint so the frame reflows to the new
 *       geometry (the debounced resize repaint may have been suppressed while
 *       cprPending was true).
 *
 * This eliminates three defects from the earlier "requeue geometry" design:
 *   ✗ Double-shift: old design applied first-reply delta then re-applied the
 *     cumulative second delta on top. New: single apply from originalExpectedRow.
 *   ✗ Mid-burst paint: old design repainted after each reply. New: repaint
 *     only after the quiescent reply.
 *   ✗ Lost repaint: old design skipped repaint when delta==0. New: always
 *     repaint after the final reply so the frame reflows to the new row count.
 *
 * Plausibility guard (Task 2):
 *   tmux can shift content by at most the sum of all GROW steps or sum of all
 *   SHRINK steps in the burst since the last render. Plausible range:
 *     delta ∈ [−shrinkTotal, +growTotal]
 *   If the measured delta falls outside this range the cursor was not where we
 *   assumed — discard the delta, fall back, repaint. Under AFK_DEBUG_COMPOSITOR
 *   a one-line stderr diagnostic is written.
 */

import { env } from '../config/env.js';

/** Regex that matches a complete CPR response: ESC [ row ; col R */
export const CPR_REPLY_RE = /^\x1b\[(\d+);(\d+)R$/;

/**
 * Parse a CPR reply and return { row, col } (1-based), or null when the
 * string is not a well-formed CPR response.
 */
export function parseCprReply(s: string): { row: number; col: number } | null {
  const m = CPR_REPLY_RE.exec(s);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const row = parseInt(m[1], 10);
  const col = parseInt(m[2], 10);
  // Row and col are 1-based in the ANSI spec; 0 indicates a malformed reply.
  if (!Number.isFinite(row) || !Number.isFinite(col) || row < 1 || col < 1) return null;
  return { row, col };
}

/** CPR request sequence (ANSI DSR — Device Status Report). */
export const CPR_REQUEST = '\x1b[6n';

/** Milliseconds to wait for a CPR reply before falling back to legacy behaviour. */
export const CPR_TIMEOUT_MS = 120;

/**
 * Maximum number of re-queries issued within one burst before giving up.
 * Guards against a pathological burst that never quiesces.
 */
export const CPR_MAX_REQUERY = 8;

/**
 * Narrowest host slice needed by the CPR sub-system.
 * All absolute-row fields that must be shifted on a tmux EXPAND or SHRINK.
 */
export interface CprHost {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly armed: boolean;

  /** Whether a CPR is in-flight; suppresses repaints while true. */
  cprPending: boolean;

  /**
   * Burst-tracking context for the "measure until quiescent" algorithm.
   *
   * Created by `requestCprOrMarkDirty` when the first CPR of a burst is
   * requested, and cleared once the burst resolves (quiescent reply, cap
   * reached, or timeout). While a CPR is in-flight, subsequent SIGWINCHes
   * update this context (dirty=true, accumulate totals, update currentRows)
   * instead of emitting a second CPR.
   *
   * Fields:
   *   dirty              — true when a SIGWINCH arrived since the last CPR emit.
   *   originalExpectedRow — cursor row at the START of this burst; never changes.
   *   currentRows        — latest terminal row count.
   *   growTotal          — sum of all positive row-count deltas since last render.
   *   shrinkTotal        — sum of absolute negative row-count deltas since last render.
   *   requeryCt          — number of mid-burst re-queries issued (cap: CPR_MAX_REQUERY).
   *
   * `null` when no burst is in progress.
   */
  cprBurst: {
    dirty: boolean;
    originalExpectedRow: number;
    currentRows: number;
    growTotal: number;
    shrinkTotal: number;
    requeryCt: number;
  } | null;

  // Absolute rows to translate on CPR reply.
  lastMeasuredFrameTop: number;
  lastMeasuredFrameBottom: number;
  committedBandTopRow: number;
  committedBandBottomRow: number;
  pendingResizeErase: { top: number; bottom: number } | null;
  logUpdate: { topRow?: number; resetGeometry?: () => void } | null;
  anchorRow: number | undefined;

  /** Trigger an immediate repaint after the delta is applied. */
  repaint(): void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called by handleResizeImmediate on every SIGWINCH that changes row count.
 *
 * If no CPR is in-flight: starts a fresh measurement burst.
 * If a CPR is in-flight: marks the burst dirty and accumulates the geometry
 *   change — a fresh CPR will be emitted once the in-flight one resolves.
 *
 * @param expectedRow  lastMeasuredFrameBottom at the time this SIGWINCH fired.
 *                     Used as `originalExpectedRow` only when seeding a new
 *                     burst (no CPR in-flight).
 * @param newRows      stdout.rows after this SIGWINCH.
 * @param rowDelta     newRows − prevRows for this specific step: positive for
 *                     GROW, negative for SHRINK.
 */
export function requestCprOrMarkDirty(
  self: CprHost,
  expectedRow: number,
  newRows: number,
  rowDelta: number,
): void {
  if (!self.cprPending) {
    // No CPR in-flight — seed a fresh burst and start measuring.
    self.cprBurst = {
      dirty: false,
      originalExpectedRow: expectedRow,
      currentRows: newRows,
      growTotal: rowDelta > 0 ? rowDelta : 0,
      shrinkTotal: rowDelta < 0 ? -rowDelta : 0,
      requeryCt: 0,
    };
    _requestCpr(self);
    return;
  }

  // CPR in-flight — update burst context, do NOT emit a second CPR now.
  if (self.cprBurst === null) {
    // Defensive: pending but no context (e.g. direct test call). Create one.
    self.cprBurst = {
      dirty: true,
      originalExpectedRow: expectedRow,
      currentRows: newRows,
      growTotal: rowDelta > 0 ? rowDelta : 0,
      shrinkTotal: rowDelta < 0 ? -rowDelta : 0,
      requeryCt: 0,
    };
  } else {
    self.cprBurst.dirty = true;
    self.cprBurst.currentRows = newRows;
    if (rowDelta > 0) self.cprBurst.growTotal += rowDelta;
    else if (rowDelta < 0) self.cprBurst.shrinkTotal += -rowDelta;
  }
}

/**
 * Legacy entry point for direct test usage. Seeds a burst context with a
 * single-step rowDelta and calls _requestCpr. New callers should use
 * requestCprOrMarkDirty.
 */
export function requestCprAndApplyDelta(
  self: CprHost,
  expectedRow: number,
  newRows: number,
  rowDelta: number,
): void {
  if (self.cprPending) return;
  self.cprBurst = {
    dirty: false,
    originalExpectedRow: expectedRow,
    currentRows: newRows,
    growTotal: rowDelta > 0 ? rowDelta : 0,
    shrinkTotal: rowDelta < 0 ? -rowDelta : 0,
    requeryCt: 0,
  };
  _requestCpr(self);
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

/**
 * Emit a CPR request and install a one-shot stdin `data` listener that
 * intercepts the reply BEFORE readline emits it as a keypress.
 *
 * Reads self.cprBurst for all burst context (originalExpectedRow, dirty, etc.).
 * Must be called with self.cprPending === false.
 */
function _requestCpr(self: CprHost): void {
  self.cprPending = true;

  // Accumulation buffer: the CPR reply is usually a single chunk but may
  // arrive split across multiple data events on a slow/remote PTY.
  let buf = '';

  // Timeout handle so we can cancel it when the reply arrives early.
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (listener: (chunk: Buffer | string) => void): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    self.stdin.removeListener('data', listener);
    self.cprPending = false;
  };

  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    // Runaway-buffer guard: a CPR reply is ~12 bytes; anything over 64
    // means junk is accumulating — abandon and let the timeout clean up.
    if (buf.length > 64) {
      cleanup(onData);
      if (self.armed) { self.cprBurst = null; self.repaint(); }
      return;
    }

    // A CPR reply is always terminated by 'R'. Scan forward; we may have
    // received an ESC[nn;nnR embedded among other bytes emitted simultaneously
    // (rare but possible on a remote PTY with buffered keystrokes).
    const escIdx = buf.indexOf('\x1b[');
    if (escIdx === -1) return; // no ESC[ yet — keep accumulating

    // Slice from ESC[ and look for the terminating 'R'.
    const sub = buf.slice(escIdx);
    const rIdx = sub.indexOf('R');
    if (rIdx === -1) return; // incomplete — keep accumulating

    const candidate = sub.slice(0, rIdx + 1);
    const parsed = parseCprReply(candidate);
    if (!parsed) {
      // Not a well-formed CPR — discard this candidate and keep looking.
      // Advance past only the ESC character to preserve remaining bytes.
      buf = buf.slice(escIdx + 1);
      return;
    }

    cleanup(onData);

    // ── Re-emit unconsumed bytes so keystrokes are not swallowed ──────────
    const consumedEnd = escIdx + candidate.length;
    const before = buf.slice(0, escIdx);
    const after = buf.slice(consumedEnd);
    const unconsumed = before + after;
    if (unconsumed.length > 0) {
      self.stdin.unshift(Buffer.from(unconsumed));
    }

    if (!self.armed) {
      // Disarmed between request and reply — discard and clear burst.
      self.cprBurst = null;
      return;
    }

    const burst = self.cprBurst;

    // ── Burst check: re-query if terminal is not yet quiescent ────────────
    if (burst?.dirty) {
      if (burst.requeryCt >= CPR_MAX_REQUERY) {
        // Hit the cap — give up, fall back, ALWAYS repaint.
        if (env.AFK_DEBUG_COMPOSITOR) {
          process.stderr.write(
            `[afk/cpr] re-query cap (${CPR_MAX_REQUERY}) reached — falling back + repainting\n`,
          );
        }
        self.cprBurst = null;
        self.repaint();
        return;
      }
      // More SIGWINCHes arrived — re-query, keeping originalExpectedRow and accumulators.
      burst.dirty = false;
      burst.requeryCt += 1;
      _requestCpr(self);
      return;
    }

    // ── Quiescent reply — compute delta from originalExpectedRow ──────────
    const expectedRow = burst?.originalExpectedRow ?? parsed.row; // fallback: delta=0
    const currentRows = burst?.currentRows ?? (self.stdout.rows ?? 24);
    const growTotal = burst?.growTotal ?? 0;
    const shrinkTotal = burst?.shrinkTotal ?? 0;

    const delta = parsed.row - expectedRow;

    // ── Plausibility guard ────────────────────────────────────────────────
    // Accumulated range since the last render: delta ∈ [−shrinkTotal, +growTotal].
    // Any measured delta outside this range indicates the cursor moved for
    // reasons we don't model — discard the delta, fall back, repaint.
    const lo = -shrinkTotal;
    const hi = growTotal;
    if (delta < lo || delta > hi) {
      if (env.AFK_DEBUG_COMPOSITOR) {
        process.stderr.write(
          `[afk/cpr] plausibility guard: delta=${delta} outside [${lo},${hi}]` +
          ` (growTotal=${growTotal}, shrinkTotal=${shrinkTotal},` +
          ` originalExpectedRow=${expectedRow}, reportedRow=${parsed.row})` +
          ` — discarding CPR delta, falling back + repainting\n`,
        );
      }
      self.cprBurst = null;
      self.repaint(); // ALWAYS repaint even when discarding
      return;
    }

    if (env.AFK_DEBUG_COMPOSITOR) {
      process.stderr.write(
        `[afk/cpr] apply delta=${delta} range=[${lo},${hi}] expectedRow=${expectedRow}` +
        ` reportedRow=${parsed.row} rows=${currentRows} requeries=${burst?.requeryCt ?? 0}\n`,
      );
    }
    // Apply the delta (may be 0 on a net-zero burst — still repaint below).
    if (delta !== 0) {
      applyScrollDelta(self, delta, currentRows);
    }
    self.cprBurst = null;
    // ALWAYS repaint after the quiescent reply so the frame reflows to the
    // new geometry — even when delta==0, because the debounced resize repaint
    // may have been suppressed while cprPending was true.
    self.repaint();
  };

  // Contract (interception ordering): readline's `emitKeypressEvents` installs
  // a 'data' listener that processes bytes and emits 'keypress' events. If we
  // used `stdin.on('data', ...)` (append), our listener would fire AFTER the
  // keypress listener, meaning the CPR reply would reach dispatchKey before we
  // could consume it — defeating the interception. Using `prependListener`
  // places our listener FIRST in the data chain, so we see the CPR bytes
  // before readline's keypress decoder, and the dispatchKey guard is a
  // belt-and-suspenders fallback rather than the primary line of defence.
  self.stdin.prependListener('data', onData);

  timer = setTimeout(() => {
    cleanup(onData);
    // Timeout: terminal did not answer — fall back to existing behaviour AND
    // ALWAYS repaint so the frame reflows to the new geometry. The
    // pendingResizeErase snapshot (if any) is already set; the repaint will
    // proceed without a delta correction (correct for terminals that do not
    // shift history on resize).
    if (env.AFK_DEBUG_COMPOSITOR) {
      process.stderr.write(`[afk/cpr] timeout after ${CPR_TIMEOUT_MS}ms — falling back + repainting\n`);
    }
    self.cprBurst = null;
    self.repaint();
  }, CPR_TIMEOUT_MS);

  // Emit the CPR request AFTER installing the listener so we cannot miss a
  // same-tick synchronous reply (pathological but safe).
  try {
    self.stdout.write(CPR_REQUEST);
  } catch {
    // stdout closed — clean up immediately.
    cleanup(onData);
    self.cprBurst = null;
  }
}

/**
 * Translate every tracked absolute row by `delta` rows (positive = shift down,
 * negative = shift up). Clamps values to [1, newRows].
 *
 * This corrects for the tmux history-pull: when the pane grows, tmux shifts
 * all on-screen content and the cursor DOWN by delta rows. Our frame/band row
 * pointers must move with them so erases and repaints target the correct rows.
 */
function applyScrollDelta(self: CprHost, delta: number, newRows: number): void {
  const clamp = (r: number): number => Math.max(1, Math.min(r + delta, newRows));

  if (self.lastMeasuredFrameTop > 0) {
    self.lastMeasuredFrameTop = clamp(self.lastMeasuredFrameTop);
  }
  if (self.lastMeasuredFrameBottom > 0) {
    self.lastMeasuredFrameBottom = clamp(self.lastMeasuredFrameBottom);
  }
  if (self.committedBandTopRow > 0) {
    self.committedBandTopRow = clamp(self.committedBandTopRow);
  }
  if (self.committedBandBottomRow > 0) {
    self.committedBandBottomRow = clamp(self.committedBandBottomRow);
  }
  if (self.pendingResizeErase) {
    self.pendingResizeErase = {
      top: clamp(self.pendingResizeErase.top),
      bottom: clamp(self.pendingResizeErase.bottom),
    };
  }
  if (self.logUpdate && typeof self.logUpdate.topRow === 'number' && self.logUpdate.topRow > 0) {
    self.logUpdate.topRow = clamp(self.logUpdate.topRow);
  }
  if (self.anchorRow !== undefined && self.anchorRow > 0) {
    self.anchorRow = clamp(self.anchorRow);
  }
}

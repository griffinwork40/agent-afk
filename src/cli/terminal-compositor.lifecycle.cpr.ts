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
import { armCprKeypressGuard, disarmCprKeypressGuard, CPR_KEYPRESS_GRACE_MS } from './input/emit-keypress.js';
import { CPR_REPLY_RE as _CPR_REPLY_RE_LEAF } from './input/cpr-reply-re.js';

/**
 * Regex that matches a complete CPR response: ESC [ row ; col R
 *
 * Re-exported from the shared leaf module `src/cli/input/cpr-reply-re.ts`
 * so callers that import from this public API continue to work unchanged.
 */
export const CPR_REPLY_RE: RegExp = _CPR_REPLY_RE_LEAF;

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

/**
 * Baseline milliseconds to wait for a CPR reply on the first request.
 * The adaptive timeout supersedes this once an RTT sample is available.
 */
export const CPR_TIMEOUT_MS = 120;

/**
 * Scale factor applied to the measured round-trip time to derive an adaptive
 * timeout.  A factor of 4 gives the terminal three extra RTTs of slack (likely
 * enough for jitter on most SSH/mosh links).
 */
export const CPR_RTT_SCALE = 4;

/**
 * Hard ceiling for the adaptive timeout in milliseconds.  Even on a very slow
 * link we do not want to suppress repaints indefinitely.
 */
export const CPR_TIMEOUT_CEILING_MS = 1500;

/**
 * Maximum number of re-queries issued within one burst before giving up.
 * Guards against a pathological burst that never quiesces.
 */
export const CPR_MAX_REQUERY = 8;

// ---------------------------------------------------------------------------
// Adaptive timeout — module-level RTT sample
// ---------------------------------------------------------------------------
//
// We keep one exponentially-smoothed RTT sample across all CPR requests in
// the process lifetime.  When the first reply arrives, _measuredRttMs is set.
// Each subsequent reply updates it with a simple EWA (α=0.25).  The timeout
// for each new CPR request is min(max(sample * CPR_RTT_SCALE, CPR_TIMEOUT_MS),
// CPR_TIMEOUT_CEILING_MS) — i.e. at least the baseline, at most the ceiling.
//
// This is process-global (not per-compositor) because the PTY round-trip time
// is a property of the connection, not of the compositor instance.

let _measuredRttMs: number | null = null;

function _computeTimeout(): number {
  if (_measuredRttMs === null) return CPR_TIMEOUT_MS;
  // Intentionally retain the 120 ms baseline floor even for fast local PTYs:
  // a tiny RTT sample must not eliminate slack for scheduling jitter. Slow
  // links can expand the timeout up to CPR_TIMEOUT_CEILING_MS.
  const adaptive = Math.round(_measuredRttMs * CPR_RTT_SCALE);
  return Math.min(Math.max(adaptive, CPR_TIMEOUT_MS), CPR_TIMEOUT_CEILING_MS);
}

function _updateRtt(sampleMs: number): void {
  if (_measuredRttMs === null) {
    _measuredRttMs = sampleMs;
  } else {
    _measuredRttMs = _measuredRttMs * 0.75 + sampleMs * 0.25;
  }
}

/**
 * Test helper: reset the adaptive RTT sample.
 * Must only be called from tests.
 */
export function __resetCprRttForTests(): void {
  _measuredRttMs = null;
}

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
  rttObserver?: (rttMs: number) => void,
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
    _requestCpr(self, rttObserver);
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
 *
 * @param rttObserver  Optional callback invoked with the measured round-trip
 *                     time (in ms) each time an RTT sample is recorded.
 *                     Provides a test seam for observing RTT without a
 *                     test-only export.
 */
export function requestCprAndApplyDelta(
  self: CprHost,
  expectedRow: number,
  newRows: number,
  rowDelta: number,
  rttObserver?: (rttMs: number) => void,
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
  _requestCpr(self, rttObserver);
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

/**
 * Contract: called when a CPR request times out (no reply within `timeoutMs`).
 *
 * 1. Seeds the RTT sample with `timeoutMs` as a floor estimate so the next
 *    request uses an adaptive timeout (timeoutMs × CPR_RTT_SCALE) instead of
 *    the 120 ms baseline.  On slow SSH/mosh links the first reply always
 *    arrives after the baseline, keeping _measuredRttMs null forever.  Treating
 *    the timeout itself as an observed lower-bound RTT (real RTT ≥ timeoutMs)
 *    lets the adaptive path engage on the very next request.  No delta is
 *    applied — any stale reply is discarded by the keypress guard.
 * 2. Re-arms the keypress guard for the grace window so a reply that slips
 *    past after the data listener is removed cannot leak into the idle-prompt
 *    reader.
 * 3. Falls back to the existing paint so the frame reflows to the new geometry.
 *
 * CPR_TIMEOUT_MS (120 ms) is a conservative floor calibrated for local PTY
 * round-trips (same machine, sub-millisecond actual latency).  On slow links
 * the adaptive sample quickly grows past this floor.  See _computeTimeout().
 */
function _onCprTimeout(self: CprHost, timeoutMs: number): void {
  _updateRtt(timeoutMs);
  armCprKeypressGuard(self.stdin, CPR_KEYPRESS_GRACE_MS);
  if (env.AFK_DEBUG_COMPOSITOR) {
    process.stderr.write(
      `[afk/cpr] timeout after ${timeoutMs}ms — falling back + repainting` +
      ` (rtt bootstrapped to ${timeoutMs}ms; keypress guard extended by ${CPR_KEYPRESS_GRACE_MS}ms)\n`,
    );
  }
  self.cprBurst = null;
  self.repaint();
}

/**
 * Emit a CPR request and install a one-shot stdin `data` listener that
 * intercepts the reply BEFORE readline emits it as a keypress.
 *
 * Reads self.cprBurst for all burst context (originalExpectedRow, dirty, etc.).
 * Must be called with self.cprPending === false.
 *
 * Adaptive timeout: the first request uses CPR_TIMEOUT_MS (120 ms).  Once a
 * reply has been observed, subsequent requests use min(rtt * CPR_RTT_SCALE,
 * CPR_TIMEOUT_CEILING_MS) so slow SSH/mosh links are handled without a blanket
 * ceiling increase that would delay repaints on fast local terminals.
 *
 * CPR keypress guard (Gap 2): before emitting the request we arm the shared
 * keypress guard for the full expected window (timeout + grace).  If the reply
 * arrives after the data listener times out, the guard ensures the decoded
 * keypress is dropped by any active keypress consumer (reader.ts, compositor)
 * before it can insert stray characters into the prompt buffer.
 */
function _requestCpr(self: CprHost, rttObserver?: (rttMs: number) => void): void {
  self.cprPending = true;

  // Compute the adaptive timeout for this request.
  const timeoutMs = _computeTimeout();

  // Arm the shared keypress guard for the full window so a late reply that
  // slips past the data listener (after timeout) is dropped at the keypress
  // layer too.  We arm for timeout + grace; armCprKeypressGuard extends the
  // deadline if already active (safe to call multiple times for a burst).
  armCprKeypressGuard(self.stdin, timeoutMs + CPR_KEYPRESS_GRACE_MS);

  // Accumulation buffer: the CPR reply is usually a single chunk but may
  // arrive split across multiple data events on a slow/remote PTY.
  let buf = '';

  // Timestamp of the CPR emit (for RTT measurement).
  let emitAt = 0;

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

    // ── RTT sample ────────────────────────────────────────────────────────
    // Update the smoothed RTT so the next CPR uses an adaptive timeout.
    if (emitAt > 0) {
      const sample = Date.now() - emitAt;
      _updateRtt(sample);
      rttObserver?.(sample);
    }

    cleanup(onData);
    // Disarm the keypress guard after the current EventEmitter.emit dispatch
    // stack unwinds.  Node snapshots all listeners at the start of emit(), so
    // readline's keypress 'data' listener is still queued to fire for this
    // same chunk even though we just removed our own listener.  If we disarm
    // synchronously here, a fragmented CPR reply whose last chunk is a printable
    // character (e.g. the trailing 'R') would reach handleKeypress with an
    // inactive guard, potentially inserting the character into the prompt
    // buffer.  setImmediate defers the disarm to the next iteration, after all
    // same-tick 'data' handlers (including readline's) have completed.
    setImmediate(disarmCprKeypressGuard);

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
      _requestCpr(self, rttObserver);
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
        ` reportedRow=${parsed.row} rows=${currentRows} requeries=${burst?.requeryCt ?? 0}` +
        ` timeout=${timeoutMs}ms rtt=${_measuredRttMs !== null ? Math.round(_measuredRttMs) : 'n/a'}ms\n`,
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
    _onCprTimeout(self, timeoutMs);
  }, timeoutMs);
  // Unref the CPR timeout so it does not keep the event loop alive after
  // process exit.  The timeout handler calls repaint() / fallback; if the
  // process is already shutting down there is nothing to repaint into.
  // Without unref the timer can hold the loop for up to CPR_TIMEOUT_CEILING_MS
  // (~1500ms) past the last real task.  The timer handle is cancelled by
  // cleanup(onData) when a reply arrives, so unref only matters on the
  // timeout path and only when the process exits mid-flight.
  timer.unref();

  // Emit the CPR request AFTER installing the listener so we cannot miss a
  // same-tick synchronous reply (pathological but safe).
  try {
    emitAt = Date.now();
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

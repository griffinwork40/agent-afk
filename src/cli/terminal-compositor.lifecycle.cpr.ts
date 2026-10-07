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
 * Fix: on a row-count-increasing SIGWINCH, emit ESC[6n (Device Status Report
 * — Report Cursor Position). The terminal (and tmux) echoes back ESC[row;colR
 * with the REAL cursor row, which has moved DOWN by exactly `delta` rows along
 * with the content. delta = reportedRow - expectedRow. We then shift every
 * tracked absolute row by delta before the next repaint.
 *
 * Safety contracts:
 *   1. The CPR reply MUST be consumed before readline's `keypress` listener
 *      sees it — otherwise `ESC[NN;NNR` leaks into the prompt as literal text.
 *      We install a one-shot `data` listener on stdin BEFORE emitKeypressEvents
 *      can emit the bytes as a keypress. The listener is removed once the reply
 *      arrives or the timeout fires.
 *   2. A short timeout (~120ms) falls back to the existing behaviour when the
 *      terminal does not answer (non-answering terminals, pipes, tests).
 *   3. Repaints are suppressed while the CPR is pending so the old stale-row
 *      repaint cannot race the delta correction.
 *   4. A stray/late CPR reply that arrives after the timeout already cleared
 *      the `armed` flag is silently discarded by the data listener guard.
 */

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
 * Narrowest host slice needed by the CPR sub-system.
 * All absolute-row fields that must be shifted on a tmux EXPAND.
 */
export interface CprHost {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly armed: boolean;

  /** Whether a CPR is in-flight; suppresses repaints while true. */
  cprPending: boolean;

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

/**
 * Emit a CPR request and install a one-shot stdin `data` listener that
 * intercepts the reply BEFORE readline emits it as a keypress.
 *
 * @param self           The compositor host (must be armed when called).
 * @param expectedRow    The compositor's expected cursor row = `lastMeasuredFrameBottom`
 *                       at the time handleResizeImmediate fired. CupFrameRenderer parks
 *                       the cursor at the LAST content row (frame bottom = targetBottomRow)
 *                       after each render — NOT at the frame top. tmux shifts this cursor
 *                       downward together with the on-screen content by `delta` rows.
 * @param newRows        The new terminal row count (post-SIGWINCH stdout.rows).
 */
export function requestCprAndApplyDelta(
  self: CprHost,
  expectedRow: number,
  newRows: number,
): void {
  if (self.cprPending) return; // already in-flight — skip
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
      buf = buf.slice(escIdx + candidate.length);
      return;
    }

    cleanup(onData);

    if (!self.armed) return; // disarmed between request and reply — discard

    const delta = parsed.row - expectedRow;
    if (delta !== 0) {
      applyScrollDelta(self, delta, newRows);
      self.repaint();
    }
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
    // Timeout: terminal did not answer — fall back to existing behaviour.
    // The pendingResizeErase snapshot (if any) is already set; the next
    // repaint will proceed without a delta correction (correct for terminals
    // that do not shift history on grow).
  }, CPR_TIMEOUT_MS);

  // Emit the CPR request AFTER installing the listener so we cannot miss a
  // same-tick synchronous reply (pathological but safe).
  try {
    self.stdout.write(CPR_REQUEST);
  } catch {
    // stdout closed — clean up immediately.
    cleanup(onData);
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

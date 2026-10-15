/**
 * Suspend write observer — counted handoff for suspendInput/resumeInput.
 *
 * Installs a monkey-patch on a NodeJS.WriteStream's `write` method that
 * tracks cursor-row movement while the compositor is suspended. This lets
 * resumeInput know where the owner left the cursor (row R) and how many
 * screen-scroll events occurred (scroll count S), so the compositor can
 * decide whether the pre-suspend band geometry is still valid.
 *
 * Generalises the newline-counting pattern from
 * {@link ../../cli/commands/interactive/interactive.pty-setup.ts} to also
 * track soft-wraps, carriage-returns, and alt-screen entry/exit.
 *
 * Algorithm (per-chunk, state machine in suspend-observer.process.ts):
 *  • ESC sequences — parsed by a 4-state machine (Normal/Esc/Csi/AltScreen).
 *  • CSI cursor sequences (CUU/CUD/CUP/CHA/VPA/CNL/CPL/HVP, CSI s/u) update
 *               row and col directly so selector-style rewinds (CUU N + reprint)
 *               leave R at the true cursor position rather than inflating it.
 *  • ESC 7/8   — save/restore cursor (row + col).
 *  • ESC M/D/E — reverse index / IND / NEL row adjustments.
 *  • \r        — reset visual column to 0.
 *  • \n        — advance cursor row; if row would exceed the terminal floor,
 *               increment the scroll counter instead (the screen scrolled).
 *  • Printable character — advance visual column by 1; if it reaches the
 *               terminal width, wrap: col ← 0, advance cursor row as above.
 *  • CSI overflow — sequences whose parameter section exceeds CSI_BUF_MAX
 *               bytes are discarded: the state machine swallows all remaining
 *               bytes until the final byte (0x40–0x7E), then returns to Normal.
 *  • ESC[?1049h — enter alt-screen; suspend column/row tracking (writes to
 *               the alternate buffer do not affect the main cursor).
 *  • ESC[?1049l — leave alt-screen; resume tracking.
 *
 * Chunk-processing pipeline extracted to:
 *   {@link ./terminal-compositor.lifecycle.suspend-observer.process.ts}
 *
 * Design constraints:
 *  • The patch is always removed in a paired call to {@link removeObserver}.
 *    Never leaks even if resumeInput or disarm is called out of order.
 *  • Read-only cursor-position queries are lock-free (no I/O).
 *  • Not re-entrant: a single suspended session owns one observer at a time.
 *    Re-entrancy guard is the `suspended` flag on LifecycleHost.
 */

import {
  type ObserverState,
  ObserverEscState,
  processChunk,
} from './terminal-compositor.lifecycle.suspend-observer.process.js';

/** State captured by the observer for resumeInput to act on. */
export interface SuspendObserverState {
  /** Cursor row at resume time (1-based). Equals P when no newlines were written. */
  readonly cursorRow: number;
  /** Number of full-screen scrolls that occurred while suspended. */
  readonly scrollCount: number;
}

/**
 * Handle returned by {@link installObserver}. Call {@link remove} exactly once
 * to uninstall the patch and collect final state.
 */
export interface SuspendObserverHandle {
  remove(): SuspendObserverState;
}

/**
 * Install a write observer on `stream`. The observer intercepts every
 * `stream.write(chunk, …)` call to track cursor-row movement.
 *
 * @param stream  The WriteStream to observe (compositor's stdout).
 * @param startRow The 1-based cursor row immediately after the frame was
 *                  cleared (P = lastMeasuredFrameTop). Tracking begins here.
 * @param terminalRows  Number of terminal rows (stdout.rows); used as fallback
 *                  when the stream's live rows are unavailable.
 * @param terminalCols  Number of terminal columns (stdout.columns); used as
 *                  fallback when the stream's live columns are unavailable.
 */
export function installObserver(
  stream: NodeJS.WriteStream,
  startRow: number,
  terminalRows: number,
  terminalCols: number,
): SuspendObserverHandle {
  // L3: read live dimensions from the stream so a SIGWINCH while suspended
  // is reflected in advanceRow() and soft-wrap detection. Fall back to the
  // snapshot values when the stream does not expose them (e.g. PassThrough
  // mocks that intentionally test fixed-dimension behavior).
  const getRows = (): number => Math.max(1, stream.rows ?? terminalRows);
  const getCols = (): number => Math.max(1, stream.columns ?? terminalCols);

  const st: ObserverState = {
    row: Math.max(1, Math.min(startRow, getRows())),
    col: 0,
    scrolls: 0,
    savedRow: Math.max(1, Math.min(startRow, getRows())),
    savedCol: 0,
    state: ObserverEscState.Normal,
    csiBuf: '',
  };

  const origWrite = stream.write.bind(stream);

  // Contract (type-safe patch): stream.write has multiple overloads; we
  // satisfy them all by forwarding `...args` with explicit any cast. The
  // original write is called synchronously before our bookkeeping so the
  // VirtualScreen (in tests) sees writes in the same order the observer does.
  // Store the wrapper reference so remove() can verify our layer is still
  // installed before restoring origWrite (L1: reference equality check).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapper = (chunk: unknown, ...rest: unknown[]): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (origWrite as any)(chunk, ...rest) as boolean;
    processChunk(chunk, st, getRows, getCols);
    return result;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = wrapper;

  return {
    remove(): SuspendObserverState {
      // L1: only restore origWrite if our wrapper is still installed. If
      // someone installed another observer after us, leave their wrapper in
      // place — we must not remove a layer we did not install. If remove()
      // was already called (double-call), stream.write is already origWrite
      // and we must not re-assign (idempotent guard).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((stream as any).write === wrapper) {
        stream.write = origWrite;
      }
      return { cursorRow: st.row, scrollCount: st.scrolls };
    },
  };
}

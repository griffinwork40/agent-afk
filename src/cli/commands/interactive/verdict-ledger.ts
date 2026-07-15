/**
 * Verdict ledger — a small per-session ring buffer of recent terminal states.
 *
 * The single verdict card (see `verdict-card.ts`) tells the user what
 * happened on the most recent turn. The ledger tells them the *trajectory*:
 * is the session converging on `Done`, oscillating on `Asking`, or stuck on
 * `Blocked`? That trajectory is the second-most-important question an
 * asynchronous reviewer has, after "what state is it in right now?"
 *
 * Rendered as a pinned one-line footer row above the status line:
 *
 *     ledger  ✓ done · ? asking · ✓ done · ⊘ blocked   (turn 7)
 *
 * The footer occupies its own DECSTBM-reserved row immediately above the
 * status line (at `totalRows - 1`). BackgroundStatusBar floats above it,
 * offset by the verdict row count via its `getAdjacentRows` option. Both
 * painters contribute to the sum passed to `StatusLine.setExtraRows`.
 * When the ledger is empty (no turns yet, or after /clear) the row is
 * released — `rowCount` drops to 0 and `onRowCountChange(0)` fires so
 * StatusLine collapses the reservation.
 *
 * Constraints:
 *   - Bounded ring buffer (default 8 entries) — the rail fits on one row for
 *     any reasonable terminal width.
 *   - Pure in-memory; no persistence. If the user runs `/clear` we reset.
 *   - Paints nothing when empty (rowCount stays 0, no reserved row).
 */

import type { TerminalKind, TerminalState } from './terminal-state.js';
import { palette } from '../../palette.js';
import { displayWidth, truncateDisplayWidth } from '../../display.js';
import { getTerminalWidth, ResizeBus } from '../../terminal-size.js';
import { isPlainOutputRequested } from '../../../config/env.js';

/** Compact glyph + tone for a terminal kind on the ledger rail. */
const KIND_PILL: Record<TerminalKind, { glyph: string; color: (s: string) => string; label: string }> = {
  done: { glyph: '✓', color: palette.success, label: 'done' },
  blocked: { glyph: '⊘', color: palette.error, label: 'blocked' },
  asking: { glyph: '?', color: palette.warning, label: 'asking' },
  // Interrupted is a neutral terminal state — the user stopped the agent.
  // Use meta-grey, not info-sky: it's not an informational event, it's a
  // low-salience "the user halted me" marker.
  interrupted: { glyph: '⏸', color: palette.meta, label: 'interrupted' },
};

export interface VerdictLedger {
  /** Append a new verdict. Drops oldest when the buffer is full. */
  push(state: TerminalState): void;
  /** Drop all entries — called on /clear. Repaints (clears the pinned row). */
  reset(): void;
  /**
   * Render the rail as a single line, or `null` when the ledger is empty.
   * Used internally by the painter; also available for tests.
   */
  render(): string | null;
  /** Read-only access for tests. */
  entries(): readonly TerminalKind[];

  // ── Painter lifecycle ──────────────────────────────────────────────────────

  /**
   * Register a callback to invoke when the occupied row count changes (0 or 1).
   * The callback should call `statusLine.setExtraRows(bgBarRows + n)` — the
   * caller must aggregate with any other reservations (e.g. BackgroundStatusBar).
   */
  setRowCountChangeHandler(handler: (rows: number) => void): void;

  /**
   * Start the pinned-footer painter: subscribe to ResizeBus and do an initial
   * paint pass. Must be called after StatusLine has started its scroll region.
   */
  start(opts: VerdictLedgerStartOpts): void;

  /** Stop the painter: unsubscribe from ResizeBus and clear the reserved row. */
  stop(): void;

  /**
   * Force an immediate repaint (e.g. after a push or reset while started).
   * No-op when not started or not on a TTY.
   */
  repaint(): void;
}

export interface VerdictLedgerStartOpts {
  /** Output stream. Defaults to `process.stdout`. */
  stream?: NodeJS.WriteStream;
  /**
   * Returns the number of rows owned by painters that sit *below* this row
   * (between the verdict rail and the status line). In practice this is always
   * `() => 0` in production because the verdict rail is the lowest footer
   * painter (immediately above the status line). The parameter exists for
   * completeness and test scenarios where another row might sit below.
   *
   * The verdict row is computed as:
   *   `totalRows - 1 (status) - getAdjacentRows()`
   *
   * Default: `() => 0` (verdict rail at `totalRows - 1`).
   */
  getAdjacentRows?: () => number;
}

export interface VerdictLedgerOptions {
  /** Max entries kept on the rail. Default 8. */
  capacity?: number;
}

export function createVerdictLedger(opts: VerdictLedgerOptions = {}): VerdictLedger {
  const capacity = Math.max(2, opts.capacity ?? 8);
  let kinds: TerminalKind[] = [];

  // Painter state — populated by start(), cleared by stop().
  let stream: NodeJS.WriteStream | null = null;
  let getAdjacentRows: () => number = () => 0;
  let started = false;
  let rowCount = 0; // 0 or 1
  let onRowCountChange: ((rows: number) => void) | undefined;
  let resizeUnsub: (() => void) | null = null;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function currentTotalRows(): number {
    const r = stream?.rows;
    return typeof r === 'number' && r > 0 ? r : 24;
  }

  function paintRow(totalRows: number): number {
    // One row for status line, then bg-bar rows above it, then this row above those.
    const adjacentRows = getAdjacentRows();
    return Math.max(1, totalRows - 1 - adjacentRows);
  }

  function doRepaint(): void {
    if (!started || !stream?.isTTY) return;

    const line = renderRail();
    const totalRows = currentTotalRows();
    const newRowCount = line !== null && totalRows > 1 ? 1 : 0;

    if (newRowCount !== rowCount) {
      if (rowCount > 0) doClearRow();
      rowCount = newRowCount;
      onRowCountChange?.(rowCount);
    }

    if (newRowCount === 0) return;

    const row = paintRow(totalRows);
    stream!.write('\x1b[s');
    stream!.write(`\x1b[${row};1H`);
    stream!.write('\x1b[2K');
    stream!.write(line!);
    stream!.write('\x1b[u');
  }

  function doClearRow(): void {
    if (!stream?.isTTY) return;
    const totalRows = currentTotalRows();
    const row = paintRow(totalRows);
    stream!.write('\x1b[s');
    stream!.write(`\x1b[${row};1H`);
    stream!.write('\x1b[2K');
    stream!.write('\x1b[u');
  }

  // ── Rail content renderer ────────────────────────────────────────────────────

  function renderRail(): string | null {
    if (kinds.length === 0) return null;

    const header = palette.dim('  ledger  ');
    const sep = palette.dim(' · ');
    const cells = kinds.map((k) => {
      const pill = KIND_PILL[k];
      return pill.color(`${pill.glyph} ${pill.label}`);
    });
    const tail = palette.dim(`   (${kinds.length} turn${kinds.length === 1 ? '' : 's'})`);

    const composed = header + cells.join(sep) + tail;
    const maxW = Math.max(20, getTerminalWidth() - 2);
    // If the rail overflows, fall back to glyphs-only — the colors carry
    // enough signal at a glance.
    if (displayWidth(composed) <= maxW) return composed;

    const compact =
      header +
      kinds.map((k) => KIND_PILL[k].color(KIND_PILL[k].glyph)).join(palette.dim(' ')) +
      tail;
    return truncateDisplayWidth(compact, maxW);
  }

  // ── Public interface ─────────────────────────────────────────────────────────

  return {
    push(state) {
      kinds.push(state.kind);
      if (kinds.length > capacity) kinds = kinds.slice(kinds.length - capacity);
      // Trigger a repaint so the pinned row updates immediately after each turn.
      doRepaint();
    },

    reset() {
      kinds = [];
      // The ledger is empty — clear the reserved row and release the reservation.
      if (started && rowCount > 0) {
        doClearRow();
        rowCount = 0;
        onRowCountChange?.(0);
      }
    },

    entries() {
      return kinds;
    },

    render() {
      return renderRail();
    },

    setRowCountChangeHandler(handler) {
      onRowCountChange = handler;
    },

    start(startOpts) {
      if (started) return;
      // AFK_PLAIN_OUTPUT / --plain is a full render opt-out: stay inert so a
      // --plain TTY behaves like a non-TTY surface — no reserved row, no
      // ResizeBus subscription, no CUP paint (push/repaint/reset are all gated
      // on `started`). Mirrors the status-line/compositor/renderer/input gates
      // on `isPlainOutputRequested` (config/env.ts).
      if (isPlainOutputRequested()) return;
      started = true;
      stream = startOpts.stream ?? process.stdout;
      getAdjacentRows = startOpts.getAdjacentRows ?? (() => 0);
      rowCount = 0;

      // Subscribe to terminal resize so we reposition on geometry changes.
      resizeUnsub = ResizeBus.subscribe(() => doRepaint());

      // Initial paint — if we already have entries (e.g. after a session swap
      // that re-arms the painter), show them immediately.
      doRepaint();
    },

    stop() {
      if (!started) return;
      started = false;

      if (resizeUnsub !== null) {
        resizeUnsub();
        resizeUnsub = null;
      }

      if (rowCount > 0) {
        doClearRow();
        rowCount = 0;
        onRowCountChange?.(0);
      }

      stream = null;
    },

    repaint() {
      doRepaint();
    },
  };
}

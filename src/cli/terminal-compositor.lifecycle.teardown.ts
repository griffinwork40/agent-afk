/**
 * Teardown flush helpers — extracted from terminal-compositor.lifecycle.ts (#2108).
 *
 * Contains the two committed-band flush functions that run during or before
 * compositor teardown:
 *
 *   • {@link endTurnFlush} — Stage 3 end-of-turn flush. Called BEFORE disarm().
 *     Erases the on-screen painted band suffix, archives the full band to
 *     scrollback, then zeros the band state so flushPendingCommittedBand() in
 *     disarm() is a guaranteed no-op.
 *
 *   • {@link flushPendingCommittedBand} — disarm()-internal flush. Archives only
 *     the genuinely-unpainted prefix of the band (the rows that were committed
 *     but never materialized to screen). No-op when all rows are painted (the
 *     common case when endTurnFlush ran first).
 *
 * Both functions are "soft" best-effort: a throwing stdout write is swallowed
 * so teardown continues. They share the same C1 (scrollback append-only)
 * contract — every row is written to scrollback exactly once.
 */

import { scrollbackFlushLines, buildScrollbackArchiveEscape, eraseAndPaintRow } from './terminal-compositor.scrollback.js';
import type { LifecycleHost } from './terminal-compositor.lifecycle.js';

/**
 * Stage 3 (#540 — single end-of-turn flush): commit the ENTIRE retained band
 * (painted rows + pending rows) to native scrollback as one contiguous write
 * at turn finalization, while geometry is stable (overlay cleared, spinner off).
 *
 * Unlike {@link flushPendingCommittedBand} (which only archives the in-model
 * prefix that was never painted), this function also handles the on-screen
 * PAINTED suffix — erasing it from the viewport (CUP+EL, no scroll, C1-safe)
 * before archiving the whole band, so the terminal's scrollback holds one
 * clean, complete, contiguous copy of all committed content from this turn.
 *
 * After the flush, `clearCommittedBand()` zeros the band state, making
 * `flushPendingCommittedBand` in `disarm()` a guaranteed no-op.
 *
 * Ordering: MUST be called before `disarm()` — disarm's `logUpdate.clear()`
 * will erase the live frame; endTurnFlush must run before that so the painted
 * band rows are explicitly archived (not silently erased) and `clearCommittedBand`
 * zeros the state before `flushPendingCommittedBand` checks it.
 *
 * C1 (scrollback is append-only) contract:
 *   • Painted rows are in the VIEWPORT, not scrollback — erasing them (CUP+EL)
 *     does NOT touch C1; the archive write is the first and only scrollback
 *     operation for these rows.
 *   • Pending rows were never painted — archive is their first and only write.
 *   • The archive uses `buildScrollbackArchiveEscape` (paint-at-floor + scroll),
 *     which is C1-safe by construction (same as Phase-1 and frame-preserve paths).
 *
 * No-op when: not armed, no logUpdate, or band is empty. Best-effort on
 * stdout write failure (terminal may have closed during teardown).
 */
export function endTurnFlush(self: LifecycleHost): void {
  if (!self.armed || !self.logUpdate || self.committedBand.length === 0) return;
  // Stale-guard: skip the redraw entirely when no commit has landed since the
  // last flush. Mirrors the bandGeometryStale check in commit-geometry.ts:109.
  if (!self.lifecycleStateDirty) return;

  const rows = Math.max(1, self.stdout.rows ?? 24);
  const cols = Math.max(1, self.stdout.columns ?? 80);
  const anchorFloor = Math.max(self.anchorRow ?? 1, 1);
  const bandLen = self.committedBand.length;

  // Step 1: Erase the on-screen painted suffix (CUP+EL, NO \n — C1-safe).
  // The painted suffix occupies rows [paintedTop, committedBandBottomRow].
  // Only fired when there IS a painted suffix (paintedCount > 0 and a known
  // screen position). Without this, the archive below would write the same
  // content to scrollback while it is also on-screen, violating the
  // single-copy invariant on the NEXT turn's eviction pass — the on-screen
  // copy would scroll into scrollback AGAIN when the next commit's
  // preserveRowsBeforeFrameRender runs.
  const paintedCount = self.committedBandPaintedRows;
  if (paintedCount > 0 && self.committedBandTopRow > 0) {
    // Erase from the ACTUAL visual top of the painted band to committedBandBottomRow.
    // committedBandTopRow tracks the real paint start — under the short-terminal
    // blank-gap cap (#2182) this may be ABOVE targetBottom-paintedCount+1
    // (the uncapped position), so using committedBandTopRow avoids erasing the
    // wrong rows when the cap shifted the band upward from its bottom-aligned
    // position. committedBandBottomRow is the full above-frame region bottom
    // (targetBottom = desiredTopRow-1); erasing up to it clears both the painted
    // rows and any gap rows between the visual band bottom and the frame top.
    const paintedTop = self.committedBandTopRow;
    let eraseOut = '\x1b[?25l';
    for (let r = Math.max(1, paintedTop); r <= self.committedBandBottomRow; r++) {
      eraseOut += eraseAndPaintRow(r); // CUP+EL, no line content, no \n
    }
    try {
      self.stdout.write(eraseOut);
    } catch {
      /* terminal closed mid-erase — carry on to archive so nothing is lost */
    }
  }

  // Step 2: Archive the FULL band (all rows, painted + pending) to scrollback
  // as soft-wrappable logical lines via the shared archive path. `scrollbackFlushLines`
  // with count === bandLen emits the whole band; `buildScrollbackArchiveEscape`
  // paints it top-aligned at anchorFloor and scrolls it into scrollback.
  const allLines = scrollbackFlushLines(self.committedBand, self.committedBandMeta, bandLen);
  const archiveEscape = buildScrollbackArchiveEscape(allLines, anchorFloor, rows, cols);
  if (archiveEscape.length > 0) {
    const write = (): void => { self.stdout.write(archiveEscape); };
    try {
      if (self.scrollRegion) {
        self.scrollRegion.withFullScrollRegion(write);
      } else {
        write();
      }
    } catch {
      /* stdout closed mid-archive — disarm will clean up from here */
    }
  }

  // Step 3: Zero the band state. flushPendingCommittedBand in disarm() is now
  // a no-op (pendingCount = 0 - 0 = 0); repositionCommittedBand will not fire
  // (band empty); evict-on-growth in preserveRowsBeforeFrameRender will not
  // treat viewport rows as band content.
  self.clearCommittedBand();
}

/**
 * Flush the genuinely-unpainted prefix of the committed band to scrollback as
 * REAL content, so a disarm before repositionCommittedBand materializes a
 * band-hold model does not lose the committed block from screen AND history.
 *
 * Pending rows are the PREFIX `committedBand[0 .. length - committedBandPaintedRows)`
 * (every paint site materializes the BOTTOM suffix — see committedBandPaintedRows
 * on the class). When all rows are painted (the common teardown: overlay
 * collapsed → repositionCommittedBand painted everything → painted === length)
 * this is a no-op and the on-screen rows are left exactly as they are — never
 * re-emitted (HARD CONSTRAINT #1: no duplicate in scrollback).
 *
 * Mechanism (#540 axis-2 logical-line flush): the pending prefix is archived as
 * SOFT-WRAPPABLE logical lines, not pre-hard-wrapped physical rows, so a later
 * width resize reflows this scrolled-off content cleanly. scrollbackFlushLines
 * maps the `pendingCount` physical rows to logical lines — reading the FULL
 * band + meta (not just the prefix) so a logical line STRADDLING the
 * pending/painted boundary emits its pending rows verbatim rather than
 * duplicating the on-screen (painted) tail. buildScrollbackArchiveEscape writes
 * each line at the physical bottom margin with autowrap ON + a trailing `\n`,
 * so the TERMINAL owns the wrap and the `\n` scrolls it into history; the
 * terminal re-derives the same per-line physical-row count, so a pending run
 * taller than the terminal still archives every row (each line scrolls at the
 * bottom margin independently). Wrapped in `withFullScrollRegion` (no-op when no
 * status line is started) so the `\n` produces a FULL-screen scroll that enters
 * scrollback rather than a DECSTBM sub-region scroll that silently drops the
 * displaced top line. Best-effort: a throwing stdout means the process is
 * exiting anyway and the next teardown step tears us down.
 */
export function flushPendingCommittedBand(self: LifecycleHost): void {
  const pendingCount = self.committedBand.length - self.committedBandPaintedRows;
  if (pendingCount <= 0) return;
  const rows = Math.max(1, self.stdout.rows ?? 24);
  const cols = Math.max(1, self.stdout.columns ?? 80);
  const anchorFloor = Math.max(self.anchorRow ?? 1, 1);
  const archiveLines = scrollbackFlushLines(self.committedBand, self.committedBandMeta, pendingCount);
  const escape = buildScrollbackArchiveEscape(archiveLines, anchorFloor, rows, cols);
  if (escape.length === 0) return;
  const write = (): void => {
    self.stdout.write(escape);
  };
  try {
    if (self.scrollRegion) {
      self.scrollRegion.withFullScrollRegion(write);
    } else {
      write();
    }
  } catch {
    /* stdout closed mid-flush (process exiting) — nothing more we can do */
  }
}

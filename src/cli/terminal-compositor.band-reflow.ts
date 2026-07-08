/**
 * Invariant (retained-logical-source reflow — "strings wrapped at width W are
 * only valid at width W"): committed-band reflow re-wraps retained band rows
 * at the CURRENT terminal width before any paint site reads them. Shared by
 * commitAbove (committed-band-commit.ts, which merges the PRIOR band into a
 * new commit) and repaint (frame.ts, which feeds both
 * preserveRowsBeforeFrameRender's eviction paints and
 * repositionCommittedBand's re-pin from the SAME `self.committedBand`).
 *
 * External constraint (DECAWM autowrap semantics): terminal-compositor.
 * committed-band-commit.ts hard-wraps committed text to `stdout.columns` ONCE,
 * at commit time (`hardWrapToWidth(l, cols)`), and every downstream paint
 * site used to CUP-paint those retained rows VERBATIM regardless of how many
 * resizes happened since. A row wrapped at 160 cols is invalid at 64 cols —
 * the terminal's own DECAWM autowrap (on by default, never disabled elsewhere
 * in this codebase) then hard-wraps it AGAIN at the hardware level, inserting
 * an unaccounted phantom row that desyncs every subsequent CUP/erase
 * computation from the compositor's row model (ghost frames, mid-word
 * truncation, corrupted geometry). The fix mirrors the industry-standard
 * "reflow from model" approach (ratatui, Codex): never trust a previously-
 * wrapped string at a new width — re-derive physical rows from the retained
 * content at the width they are about to be painted at.
 *
 * `reflowBandSplit` is pure (no `this`, no I/O) so it is unit-testable in
 * isolation; `reflowCommittedBandToWidth` is the narrow mutate-self wrapper
 * matching this module family's free-functions-on-host convention.
 */

import { hardWrapToWidth } from './wrap.js';

/**
 * Invariant (painted/pending boundary survives reflow): `committedBand`'s
 * BOTTOM `committedBandPaintedRows` rows are the ones physically on screen
 * right now; the complementary TOP prefix is held only in this in-memory
 * model (see the field doc on TerminalCompositor.committedBandPaintedRows).
 * Naively re-wrapping the WHOLE array and leaving the row-count unchanged
 * would desync that boundary the instant reflow changes the row count (e.g.
 * a narrowing resize splits one row into two) — `decideCommitMode`'s
 * `overflowHasPending`, `preserveRowsBeforeFrameRender`'s `hasPending`, and
 * `flushPendingCommittedBand`'s flush-count all read `committedBandPaintedRows`
 * against `committedBand.length` and would misfire (spurious eviction, or a
 * disarm flushing already-on-screen rows as if they were unpainted). Reflow
 * therefore splits the band into its pending PREFIX and painted SUFFIX,
 * re-wraps each independently, and reports the new suffix's row count as the
 * new `committedBandPaintedRows` — the boundary moves with the content it
 * describes instead of staying pinned to a row index that no longer means
 * the same thing once the row count has changed.
 */
export interface BandReflowResult {
  rows: string[];
  paintedRows: number;
}

/**
 * Re-wrap `band` at `width`, preserving the pending/painted boundary at
 * `paintedRows` (see the Invariant above). Content-preserving and idempotent
 * across arbitrary sequences of width changes — hardWrapToWidth only
 * relocates line-break positions, it never drops characters, and re-wrapping
 * an already-`width`-fitting row at the SAME width returns it unchanged (so a
 * steady-width repeat call is a no-op even without the cache in
 * {@link reflowCommittedBandToWidth}).
 */
export function reflowBandSplit(
  band: readonly string[],
  paintedRows: number,
  width: number,
): BandReflowResult {
  if (band.length === 0) return { rows: [], paintedRows: 0 };
  const clampedPainted = Math.max(0, Math.min(paintedRows, band.length));
  const pendingPrefix = band.slice(0, band.length - clampedPainted);
  const paintedSuffix = band.slice(band.length - clampedPainted);
  const reflow = (lines: readonly string[]): string[] =>
    lines.flatMap((line) => hardWrapToWidth(line, width).split('\n'));
  const reflowedSuffix = reflow(paintedSuffix);
  const rows = [...reflow(pendingPrefix), ...reflowedSuffix];
  return { rows, paintedRows: reflowedSuffix.length };
}

/**
 * Memoizes the last reflow call so a steady-width repaint is a no-op. A hit
 * requires the CURRENT `self.committedBand` reference and
 * `self.committedBandPaintedRows` value to both still equal what this cache
 * entry was produced from (see {@link reflowCommittedBandToWidth}).
 */
export interface BandReflowCache {
  readonly band: readonly string[];
  readonly paintedRows: number;
  readonly width: number;
}

/** Narrowest state slice {@link reflowCommittedBandToWidth} touches. */
export interface BandReflowHost {
  committedBand: string[];
  committedBandPaintedRows: number;
  bandReflowCache: BandReflowCache | null;
}

/**
 * Contract: re-wrap `self.committedBand` at `width` IN PLACE (mutating both
 * the band array and its painted-count boundary — see {@link reflowBandSplit})
 * and update the memoization cache. Call this at every band paint/merge site
 * — commitAbove, before it reads the prior band to merge or route through
 * band-hold; and repaint()/repaintPickerFrame(), before
 * preserveRowsBeforeFrameRender and repositionCommittedBand read the band —
 * so no consumer ever sees rows wrapped at a stale width. A no-op when the
 * band is empty (cache cleared to null) so an empty-band steady state never
 * pays even a cache-comparison cost.
 *
 * Two independent things can invalidate the cache even when `width` is
 * unchanged: (1) a commit reassigns `committedBand` to a new array reference
 * (Phase 3's merge/cap), and (2) `repositionCommittedBand` or a
 * preserveRowsBeforeFrameRender eviction updates `committedBandPaintedRows`
 * ALONE, without touching `committedBand`'s reference (a row moves from
 * pending to painted with no content change). Both are covered by comparing
 * against the cache's recorded `band`/`paintedRows`, not just `width`.
 */
export function reflowCommittedBandToWidth(self: BandReflowHost, width: number): void {
  if (self.committedBand.length === 0) {
    self.bandReflowCache = null;
    return;
  }
  const cache = self.bandReflowCache;
  if (
    cache !== null &&
    cache.band === self.committedBand &&
    cache.paintedRows === self.committedBandPaintedRows &&
    cache.width === width
  ) {
    return; // already reflowed to this width from this exact band+boundary
  }
  const { rows, paintedRows } = reflowBandSplit(self.committedBand, self.committedBandPaintedRows, width);
  self.committedBand = rows;
  self.committedBandPaintedRows = paintedRows;
  self.bandReflowCache = { band: rows, paintedRows, width };
}

// DECAWM (autowrap) private-mode escapes.
const DECAWM_OFF = '\x1b[?7l';
const DECAWM_ON = '\x1b[?7h';

/**
 * Invariant (DECAWM autowrap semantics — belt-and-braces second layer): run
 * `paint` with terminal autowrap DISABLED, guaranteeing it is re-enabled
 * afterward even if `paint` throws. Defends against width-MEASUREMENT
 * mismatches (ambiguous-width glyphs — ×, —, ╭ box-drawing — where this
 * codebase's displayWidth() can disagree by ±1 column with a specific
 * terminal's actual rendering): with autowrap off, an under-measured row can
 * only be CLIPPED at the terminal's right edge, never spill into an
 * unaccounted phantom row that corrupts the compositor's CUP/erase row math
 * the way DEFECT 1 did. The reflow above (wrapping at the CURRENT width) is
 * the primary correctness fix; this is a defensive second layer for the
 * residual measurement-gap case reflow cannot rule out by construction.
 *
 * Teardown before setup: the `restore` closure (DECAWM_ON) is declared BEFORE
 * `DECAWM_OFF` is written, and fires from a `finally` clause, so a throwing
 * `paint` (e.g. a closed stdout mid-repaint) can never leave autowrap
 * permanently disabled for the rest of the session.
 */
export function withAutowrapDisabled(stream: NodeJS.WriteStream, paint: () => void): void {
  const restore = (): void => {
    try {
      stream.write(DECAWM_ON);
    } catch {
      /* terminal already gone — nothing more to restore */
    }
  };
  try {
    stream.write(DECAWM_OFF);
  } catch {
    return; // terminal already gone — skip the paint; nothing to restore either
  }
  try {
    paint();
  } finally {
    restore();
  }
}

/**
 * Seam-aware scrollback helpers for compositor tests.
 *
 * Contract (the one sanctioned duplicate): under content-hug, rows a tall
 * overlay covered are archived to native scrollback AND retained in the band
 * model as the archived prefix (`committedBandArchivedPrefix`), so a later
 * frame shrink re-shows them instead of leaving a blank gap below the prompt.
 * While re-shown, each such row exists twice in the terminal buffer: once at
 * the tail of scrollback and once on screen. It is never WRITTEN to scrollback
 * twice. Tests that assert "every committed row exactly once" across
 * scrollback + viewport must therefore discount exactly that overlap, and
 * nothing else.
 *
 * Strictness: the allowed overlap is not inferred from the buffer. It is the
 * number of PAINTED archived-prefix rows the compositor itself reports
 * ({@link reshownArchivedRows}); the scrollback tail of that length must match
 * a contiguous run of viewport rows, or the helper fails. A real
 * double-write at the seam (the #2382 bug class) either changes no compositor
 * state (overlap 0, so the duplicate still fails the caller's exactly-once
 * check) or produces a tail that does not match. Full account:
 * docs/scrollback.md "Fixed: blank gap below prompt after tall overlay
 * collapses (content-hug)".
 */

import { expect } from 'vitest';

interface ArchivedPrefixState {
  committedBand: string[];
  committedBandPaintedRows: number;
  committedBandArchivedPrefix?: number;
}

/**
 * Archived-prefix rows currently painted on screen. Painted rows are the band
 * SUFFIX, so pending rows (`band.length - painted`) are hidden first; any
 * archived rows beyond them are on screen.
 */
export function reshownArchivedRows(compositor: object): number {
  const s = compositor as unknown as ArchivedPrefixState;
  const pending = s.committedBand.length - s.committedBandPaintedRows;
  return Math.max(0, (s.committedBandArchivedPrefix ?? 0) - pending);
}

/**
 * Return `scrollback` with its tail copy of the `reshown` on-screen archived
 * rows removed, after asserting that tail appears as a contiguous run in
 * `visible`. Viewport indices are untouched, so callers keep using `visible`
 * as-is and only swap in the returned scrollback.
 */
export function dropSeamOverlap(
  scrollback: readonly string[],
  visible: readonly string[],
  reshown: number,
  dump: string,
): string[] {
  if (reshown <= 0) return [...scrollback];
  const norm = (l: string | undefined): string => (l ?? '').trimEnd();
  expect(reshown, `seam overlap ${reshown} exceeds scrollback length:\n${dump}`).toBeLessThanOrEqual(scrollback.length);
  const tail = scrollback.slice(scrollback.length - reshown).map(norm);
  const start = visible.findIndex((_, i) => tail.every((t, j) => norm(visible[i + j]) === t));
  expect(start, `re-shown archived rows (${reshown}) are not the scrollback tail shown on screen:\n${dump}`).toBeGreaterThanOrEqual(0);
  return scrollback.slice(0, scrollback.length - reshown);
}

/**
 * Full-buffer variant for rigs that read `term.buffer.active` as one array:
 * `lines[0, baseY)` is scrollback, `lines[baseY, …)` the viewport. Returns the
 * merged buffer with the seam overlap removed from the scrollback side.
 */
export function mergeSeamBuffer(lines: readonly string[], baseY: number, reshown: number, dump: string): string[] {
  const visible = lines.slice(baseY);
  return [...dropSeamOverlap(lines.slice(0, baseY), visible, reshown, dump), ...visible];
}

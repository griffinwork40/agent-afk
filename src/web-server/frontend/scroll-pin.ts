/**
 * Scroll-pinning predicate for the live transcript.
 *
 * Invariant: a live-tailing view may only auto-scroll when the reader is
 * ALREADY at the bottom. Scrolling unconditionally makes history unreadable —
 * on an active session every arriving event yanks the viewport back to the
 * newest row, so scrolling up to read anything is impossible.
 *
 * The companion invariant lives at the call site: the measurement must be taken
 * BEFORE the re-render, because replacing the container's children resets
 * scrollHeight and destroys the evidence of where the reader was.
 *
 * Kept as a pure function over three numbers (rather than reading a DOM node)
 * so the tolerance semantics are testable without a browser.
 */

/**
 * Slack, in pixels, for treating a scroll container as "at the bottom".
 *
 * Contract: an exact equality test fails in practice — fractional device-pixel
 * ratios and sub-pixel line heights leave a residue even when the view is
 * visually at the bottom. The tolerance also exceeds one transcript row so a
 * reader watching the newest entries stays pinned, while a deliberate scroll
 * upward (which moves much further than one row) does not.
 */
export const PIN_TOLERANCE_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** True when `m` is at — or within {@link PIN_TOLERANCE_PX} of — the bottom. */
export function isPinnedToBottom(m: ScrollMetrics, tolerance = PIN_TOLERANCE_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= tolerance;
}

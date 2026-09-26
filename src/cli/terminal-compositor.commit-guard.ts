import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';

// External constraint (DECSTBM contract): when a StatusLine is active
// the bottom row is reserved via a persistent scroll region. A raw
// `\n` written at the bottom of that sub-region triggers a sub-region
// scroll on xterm/iTerm2/Apple Terminal, and the displaced top line
// silently exits without entering scrollback. Wrapping the inner write
// in `scrollRegion.withFullScrollRegion(...)` makes the `\n` produce a
// full-screen scroll instead, which DOES enter scrollback. No-op when
// scrollRegion is absent or its status line hasn't started.
export function writeWithScrollGuard(
  self: Pick<CommittedBandHost, 'scrollRegion'>,
  write: () => void,
): void {
  if (self.scrollRegion) {
    self.scrollRegion.withFullScrollRegion(write);
  } else {
    write();
  }
}

/**
 * The first-commit banner scroll: scroll `bannerRows` rows into scrollback,
 * then erase the rows the full-screen scroll leaves behind.
 *
 * Invariant (banner-scroll orphans): the first-commit banner scroll runs
 * inside {@link writeWithScrollGuard}, so it scrolls the WHOLE screen —
 * including the reserved footer (status line, health rail, idle/loop rows).
 * Every row that survives on screen after scrolling `bannerRows` rows is
 * stale by construction: the frame was cleared just before, and everything
 * else below the banner was footer, which self-heals at the physical bottom
 * via `flush()` + `afterScrollRestore`. The footer's scrolled-up COPY lands
 * `bannerRows` rows higher, inside the compositor region, where nothing
 * repaints it once the frame sits high (content-hug parks the frame directly
 * under the committed content and never touches the rows below the prompt).
 * So erase the surviving compositor rows here, before the footer repaints.
 * The erase stops at `min(rows - bannerRows, absoluteBottom)`: rows below
 * `rows - bannerRows` are the fresh blank lines the scroll introduced, and
 * rows below absoluteBottom (`rows - 1 - extraRows`) are live footer, which is
 * never erased here. Must run inside writeWithScrollGuard.
 */
export function bannerScrollSequence(rows: number, bannerRows: number, extraRows: number): string {
  let out = `\x1b[${rows};1H${'\n'.repeat(bannerRows)}`;
  const survivingRows = Math.min(rows - bannerRows, rows - 1 - extraRows);
  for (let r = 1; r <= survivingRows; r++) out += `\x1b[${r};1H\x1b[2K`;
  return out;
}

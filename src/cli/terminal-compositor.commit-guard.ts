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

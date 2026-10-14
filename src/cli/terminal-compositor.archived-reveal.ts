/** Content-hug archived-prefix visibility; one contiguous leading slice is hidden.
 * Reveal is sticky for an episode: after a large collapse refills the screen,
 * threshold jitter cannot hide those rows again. Archive, commit and resize
 * start a new episode. Small shrinks leave harmless blank rows below the frame.
 */
import type { FramePlacementMode } from './terminal-compositor.types.js';

interface RevealHost {
  placementMode?: FramePlacementMode;
  committedBand: string[];
  committedBandArchivedPrefix?: number;
  pendingContentRows?: number | null;
  anchorRow?: number;
  stdout?: NodeJS.WriteStream;
}
interface Episode {
  revealed: boolean;
  rows: number;
  cols: number;
  projectedPrefix?: number;
}
const episodes = new WeakMap<object, Episode>();

export function resetArchivedReveal(self: RevealHost, projectedPrefix?: number): void {
  episodes.set(self, {
    revealed: false, rows: self.stdout?.rows ?? 24, cols: self.stdout?.columns ?? 80,
    ...(projectedPrefix === undefined ? {} : { projectedPrefix }),
  });
}

/** Shared visibility plan. Only frame measurement may resolve a reveal; reserve
 * and paint consumers read the same plan without making geometry guesses.
 * During Phase 2 the prefix belongs to the projected post-commit model.
 */
export function hiddenArchivedRows(
  self: RevealHost,
  geometry?: { physicalRows: number; absoluteBottom: number },
  projection?: { length: number; prefix: number },
): number {
  if (self.placementMode !== 'content-hug') return 0;
  const rows = self.stdout?.rows ?? 24;
  const cols = self.stdout?.columns ?? 80;
  let episode = episodes.get(self);
  if (!episode || episode.rows !== rows || episode.cols !== cols) {
    resetArchivedReveal(self);
    episode = episodes.get(self)!;
  }
  const length = projection?.length ?? self.pendingContentRows ?? self.committedBand.length;
  const projected = self.pendingContentRows != null ? episode.projectedPrefix : undefined;
  const prefix = Math.max(0, Math.min(length, projection?.prefix ?? projected ?? self.committedBandArchivedPrefix ?? 0));
  if (prefix === 0) return 0;
  if (geometry && !episode.revealed) {
    const floor = Math.max(1, self.anchorRow ?? 1);
    const gap = geometry.absoluteBottom - (floor + length - prefix + geometry.physicalRows - 1);
    if (gap > Math.max(3, Math.floor(rows / 8))) episode.revealed = true;
  }
  return episode.revealed ? 0 : prefix;
}

/**
 * Public API barrel for the episode synthesis module.
 *
 * @module agent/episodes
 */

export type { EpisodeRecord } from './types.js';
export { buildEpisodeFromFacet } from './facet-bridge.js';
export { writeEpisode, formatEpisodeContent, sanitizeNarrative } from './writer.js';

import { buildEpisodeFromFacet } from './facet-bridge.js';
import { writeEpisode } from './writer.js';
import type { EpisodeRecord } from './types.js';

/**
 * Convenience: build from facet → write in one call.
 * Returns the EpisodeRecord (useful for CLI display), or null when the facet
 * is missing or yields no substance (empty goal and outcome), so callers can
 * distinguish a skipped session from a written one.
 */
export async function synthesizeAndWriteEpisode(sessionId: string): Promise<EpisodeRecord | null> {
  const episode = buildEpisodeFromFacet(sessionId);
  if (!episode || (!episode.goal && !episode.outcome)) return null;
  await writeEpisode(episode);
  return episode;
}

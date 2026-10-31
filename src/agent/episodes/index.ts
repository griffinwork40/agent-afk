/**
 * Public API barrel for the episode synthesis module.
 *
 * @module agent/episodes
 */

export type { EpisodeRecord, EpisodeInput } from './types.js';
export { extractEpisodeInput } from './extract.js';
export { synthesizeEpisode } from './synthesize.js';
export { writeEpisode, formatEpisodeContent, sanitizeNarrative } from './writer.js';

import { extractEpisodeInput } from './extract.js';
import { synthesizeEpisode } from './synthesize.js';
import { writeEpisode } from './writer.js';
import type { EpisodeRecord } from './types.js';

/**
 * Convenience: extract → synthesize → write in one call.
 * Returns the synthesized EpisodeRecord (useful for CLI display).
 */
export async function synthesizeAndWriteEpisode(sessionId: string): Promise<EpisodeRecord> {
  const input = extractEpisodeInput(sessionId);
  const episode = await synthesizeEpisode(input);
  await writeEpisode(episode);
  return episode;
}

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
 *
 * Skips synthesis and write entirely for stub sessions (no real user
 * message and no tool usage) to avoid polluting the fact archive with
 * "Unknown goal" noise from empty or trivial sessions.
 */
export async function synthesizeAndWriteEpisode(sessionId: string): Promise<EpisodeRecord | null> {
  const input = extractEpisodeInput(sessionId);

  // Substance gate: skip sessions with no real user content and no tool usage
  if (!input.firstUserMessage && input.toolsUsed.length === 0) {
    return null;
  }

  const episode = await synthesizeEpisode(input);
  await writeEpisode(episode);
  return episode;
}

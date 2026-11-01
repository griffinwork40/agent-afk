/**
 * Episode writer — stores a synthesized EpisodeRecord in the memory archive.
 *
 * Uses the existing facts table (category: 'learning') so no schema change
 * is required. The narrative is FTS5-sanitized before storage and capped at
 * 2000 chars. Content includes a [episode:<sessionId>] prefix for searchability.
 *
 * @module agent/episodes/writer
 */

import { MemoryStore } from '../memory/memory-store.js';
import type { EpisodeRecord } from './types.js';

const NARRATIVE_CAP = 2_000;

// FTS5 operator characters that break tokenization when they appear in
// stored content and are later used in FTS queries.
// Strip: AND OR NOT " : * ( ) ^
// Uses Unicode-aware lookbehind/lookahead (u flag, ES2018+) so that
// operator tokens embedded in non-ASCII words (e.g. "stANDard") are NOT stripped.
const FTS5_UNSAFE = /(?<!\p{L})AND(?!\p{L})|(?<!\p{L})OR(?!\p{L})|(?<!\p{L})NOT(?!\p{L})|[":*()\^]/gu;

/**
 * Sanitize narrative text for safe FTS5 storage.
 * Strips operator tokens and caps length.
 */
export function sanitizeNarrative(text: string): string {
  return text
    .replace(FTS5_UNSAFE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, NARRATIVE_CAP);
}

/**
 * Format the structured content stored in the facts table.
 * Prefixed with [episode:<sessionId>] for searchability.
 */
export function formatEpisodeContent(episode: EpisodeRecord): string {
  const lines: string[] = [
    `[episode:${episode.sessionId}]`,
    `goal: ${episode.goal}`,
    `approach: ${episode.approach}`,
    `outcome: ${episode.outcome}`,
  ];

  if (episode.pivots.length > 0) {
    lines.push(`pivots: ${episode.pivots.join('; ')}`);
  }
  if (episode.decisions.length > 0) {
    lines.push(`decisions: ${episode.decisions.join('; ')}`);
  }
  if (episode.openQuestions.length > 0) {
    lines.push(`open: ${episode.openQuestions.join('; ')}`);
  }
  if (episode.filesKey.length > 0) {
    lines.push(`files: ${episode.filesKey.join(', ')}`);
  }
  if (episode.tags.length > 0) {
    lines.push(`tags: ${episode.tags.join(', ')}`);
  }

  const safeNarrative = sanitizeNarrative(episode.narrative);
  if (safeNarrative) {
    lines.push(`narrative: ${safeNarrative}`);
  }

  lines.push(`synthesized: ${episode.synthesizedAt}`);

  return lines.join('\n');
}

/**
 * Write the episode to the cross-session memory archive.
 * Uses category 'learning' on the existing facts table (no schema bump).
 */
export async function writeEpisode(
  episode: EpisodeRecord,
  memoryDir?: string,
): Promise<void> {
  const store = new MemoryStore(memoryDir);
  store.storeFact({
    session_id: episode.sessionId,
    category: 'learning',
    content: formatEpisodeContent(episode),
    source_surface: 'episode-synthesis',
    evidence: episode.sessionId,
  });
}

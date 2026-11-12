/**
 * Types for agent episode synthesis.
 *
 * An EpisodeRecord is a compressed episodic summary derived from a session
 * facet, stored in the cross-session memory archive for future recall.
 *
 * @module agent/episodes/types
 */

/** Compressed narrative record of one agent session. */
export interface EpisodeRecord {
  sessionId: string;
  /**
   * Session surface: `'cli' | 'telegram' | 'daemon' | 'web'`.
   * Sourced from `facet.surface` (added in facet v14, #4645) so episode
   * synthesis never needs a separate sidecar read.
   * Optional for back-compat with episodes synthesised before v14.
   */
  source?: 'cli' | 'telegram' | 'daemon' | 'web';
  goal: string;
  approach: string;
  pivots: string[];
  decisions: string[];
  outcome: string;
  openQuestions: string[];
  filesKey: string[];
  tags: string[];
  narrative: string;
  synthesizedAt: string;
}

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

/**
 * Types for agent episode synthesis.
 *
 * An EpisodeRecord is a compressed episodic narrative derived from a sealed
 * session journal, stored in the cross-session memory archive for future recall.
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

/**
 * Extracted input for episode synthesis — structural signals pulled from
 * the sealed journal with a strict token budget (~8K tokens total).
 *
 * Thinking blocks and full tool inputs/outputs are excluded; only names
 * and first-line errors are carried.
 */
export interface EpisodeInput {
  sessionId: string;
  /** First user message text (stripped of preamble/directives). */
  firstUserMessage: string;
  /** Compact mark sequence (compaction, rewind, clear, resume, model_switch). */
  markSequence: string[];
  /** Tool names used (from tool_use blocks — names only, not inputs). */
  toolsUsed: string[];
  /** Tool errors (tool name + first line of error content). */
  toolErrors: string[];
  /** Last assistant message text. */
  lastAssistantMessage: string;
  /** Facet summary fields if available. */
  facetSummary?: string;
  durationMs?: number;
  costUsd?: number;
}

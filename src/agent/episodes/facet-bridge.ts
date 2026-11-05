/**
 * Deterministic facet-to-episode bridge.
 *
 * Reads a derived session facet and produces an EpisodeRecord without any
 * LLM call. Replaces the previous extract.ts + synthesize.ts pipeline that
 * re-read the journal and called Haiku for narrative synthesis.
 *
 * The facet already contains richer data than the old extraction path:
 * underlying_goal, brief_summary, outcome, skills, commands, decisions,
 * evidence_pointers, and duration — all derived from the full session.
 *
 * Design invariants:
 *   - Never throws: returns a minimal stub on any error.
 *   - Zero LLM cost: all fields are derived deterministically from facet data.
 *   - Richer input than journal extraction: facets have the full terminal
 *     state parse, tool counts, subagent summaries, and outcome reasoning.
 *
 * @module agent/episodes/facet-bridge
 */

import { getOrDeriveFacet } from '../facets/store.js';
import type { EpisodeRecord } from './types.js';

/**
 * Build an EpisodeRecord deterministically from facet fields.
 * Returns null when the facet is unavailable or an error occurs, so callers
 * can distinguish a missing episode from an empty one and avoid writing
 * substance-free stubs into the fact archive.
 */
export function buildEpisodeFromFacet(sessionId: string): EpisodeRecord | null {
  try {
    const facet = getOrDeriveFacet(sessionId);
    if (!facet) return null;

    const goal = facet.underlying_goal || facet.first_prompt.slice(0, 200) || 'Unknown goal';
    const outcome = facet.primary_success || facet.outcome || 'Unknown outcome';

    // Build approach from skills, commands, and top tools
    const approachParts: string[] = [];
    if (facet.skills.length > 0) {
      approachParts.push(`Skills: ${facet.skills.join(', ')}`);
    }
    if (facet.commands.length > 0) {
      approachParts.push(`Commands: ${facet.commands.slice(0, 10).join(', ')}`);
    }
    if (approachParts.length === 0) {
      const topTools = Object.entries(facet.tool_counts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([name]) => name);
      if (topTools.length > 0) {
        approachParts.push(`Tools: ${topTools.join(', ')}`);
      }
    }
    const approach = approachParts.join('; ') || 'Conversational session';

    // Tags from goal_categories keys
    const tags = Object.keys(facet.goal_categories).slice(0, 5);

    // Narrative: deterministic combination of goal + approach + outcome
    const narrative = [
      goal.slice(0, 100),
      approach.slice(0, 100),
      outcome.slice(0, 100),
    ].join('. ') + '.';

    return {
      sessionId,
      goal,
      approach,
      pivots: [],
      decisions: facet.decisions,
      outcome,
      openQuestions: [],
      filesKey: facet.evidence_pointers.slice(0, 5),
      tags,
      narrative,
      synthesizedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Trip-observation helpers for the guardrail false-positive aggregator (#3849).
 *
 * Extracted from guardrail-false-positives.ts to stay under the 350-code-line
 * ceiling. Provides the data type and pure functions for collecting and
 * classifying `hook_block_repeat_tripped` session-phase events.
 *
 * @module insights/aggregators/guardrail-false-positives.trips
 */

import { FP_LOOKAHEAD_TOOL_CALLS } from './guardrail-false-positives.js';
import type { TraceEvent, SessionPhasePayload, ToolCallPayload } from '../../agent/trace/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TripObservation {
  /** `subagentId` from the phase metadata, or undefined for root-session trips. */
  actorId: string | undefined;
  /** Index of the trip event in the events array (for lookahead). */
  eventIndex: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all `hook_block_repeat_tripped` phase events from a parsed event
 * array.
 */
export function collectTrips(events: TraceEvent[]): TripObservation[] {
  const trips: TripObservation[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind !== 'session_phase') continue;
    const p = ev.payload as SessionPhasePayload;
    if (p.phase !== 'hook_block_repeat_tripped') continue;
    // metadata.subagentId is present when the trip occurred inside a fork.
    const actorId =
      typeof p.metadata?.['subagentId'] === 'string' ? p.metadata['subagentId'] : undefined;
    trips.push({ actorId, eventIndex: i });
  }
  return trips;
}

/**
 * Classify a single trip: scan forward from `startIndex` in `events` for up
 * to {@link FP_LOOKAHEAD_TOOL_CALLS} completed tool-call events from the same
 * actor. Returns `true` (false positive) if one succeeds, `false` otherwise.
 */
export function classifyTrip(
  events: TraceEvent[],
  startIndex: number,
  actorId: string | undefined,
): boolean {
  let toolCallsSeen = 0;
  for (let j = startIndex + 1; j < events.length && toolCallsSeen < FP_LOOKAHEAD_TOOL_CALLS; j++) {
    const ev = events[j]!;
    if (ev.kind !== 'tool_call') continue;
    const p = ev.payload as ToolCallPayload;
    if (p.phase !== 'completed') continue;
    // Scope to the same actor: undefined = root session.
    if (p.subagentId !== actorId) continue;
    toolCallsSeen++;
    if (!p.isError) return true; // agent continued successfully → FP
  }
  return false; // no success within window → true positive
}

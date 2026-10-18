/**
 * Guardrail false-positive rate aggregator (#3849 — measurement phase).
 *
 * Measures how often the `hook-block-repeat` meta-guard trips unnecessarily —
 * that is, the agent managed to make forward progress with a DIFFERENT approach
 * immediately after being told to stop. A trip is classified as a **false
 * positive** when a successful `tool_call` (completed, no `isError`) from the
 * same actor appears within {@link FP_LOOKAHEAD_TOOL_CALLS} tool-call events
 * after the `hook_block_repeat_tripped` session-phase event.
 *
 * ## Data source
 *
 * Witness trace JSONL files under `~/.afk/state/witness/`. The signal is:
 *
 *   - `session_phase` with `phase: 'hook_block_repeat_tripped'`  → the guard fired.
 *   - A subsequent `tool_call` `completed` event with `isError: false` from the
 *     same actor (matching `subagentId`, or both absent = root) within the
 *     lookahead window → the agent continued successfully → likely false positive.
 *
 * `hook_summary` counts (`PreToolUse` block totals) are also harvested from
 * each trace as context: they let callers express FP trips as a fraction of
 * total block volume.
 *
 * ## What this does NOT retire
 *
 * This is MEASUREMENT ONLY. No guard is weakened, removed, or modified here.
 * The retirement decision (Phase 2 of #3849) must be made by an operator after
 * reviewing measured data. See the issue for the follow-up gate.
 *
 * ## Limitations
 *
 * - Actor attribution uses `subagentId` from the `session_phase` metadata when
 *   present. When absent (root-session trips) attribution defaults to root.
 *   Traces recorded before metadata was added may under-count per-actor FPs.
 * - A "false positive" classification here is a proxy: it proves the agent
 *   continued, not that the originally blocked action was harmless. Operator
 *   review of flagged sessions remains necessary before any retirement.
 * - Tool args are not in the witness trace; whether the follow-up call was
 *   semantically equivalent to the blocked one cannot be determined here.
 *
 * @module insights/aggregators/guardrail-false-positives
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAfkStateDir, getFacetCacheDir } from '../../paths.js';
import { TraceEventSchema } from '../../agent/trace/events.js';
import { listSessionIds, getOrDeriveFacet } from '../../agent/facets/index.js';
import type { InsightsOptions } from '../types.js';
import { parseJsonlLines } from '../../utils/jsonl.js';
import type { TraceEvent, SessionPhasePayload, ToolCallPayload, HookSummaryPayload } from '../../agent/trace/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many completed `tool_call` events to scan forward after a trip before
 * concluding the agent did NOT recover (true positive — the guard correctly
 * stopped a loop).
 *
 * 10 is chosen to be wide enough to capture an immediate pivot (the agent
 * tries one or two recon calls then a different write) while staying tight
 * enough that a genuinely stalled session never misclassifies. Tune against
 * real data after the first measurement window.
 */
export const FP_LOOKAHEAD_TOOL_CALLS = 10;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Statistics for one `hook-block-repeat` meta-guard over the time window. */
export interface GuardrailFalsePositiveAggregates {
  /**
   * Total `hook_block_repeat_tripped` session-phase events observed across all
   * traced sessions in the window. Each event = one guard trip.
   */
  totalTrips: number;

  /**
   * Subset of trips classified as false positives: the agent made a successful
   * tool call within {@link FP_LOOKAHEAD_TOOL_CALLS} tool-call events after the
   * trip — meaning the guard fired but the session continued productively.
   */
  falsePositiveTrips: number;

  /**
   * `falsePositiveTrips / totalTrips` expressed as a fraction (0–1).
   * `null` when `totalTrips` is 0 (no data, division undefined).
   */
  falsePositiveRate: number | null;

  /**
   * Total `PreToolUse` block events (any decision=block) summed from
   * `hook_summary` records across all traced sessions. This is the broader
   * block volume context: the FP trips are a subset of all blocks, so this
   * lets callers say "N of M total blocks led to a repeat-guard trip".
   *
   * Missing `hook_summary` events (crashed sessions, pre-feature traces) are
   * silently skipped — this count is a lower bound, not an exact total.
   */
  totalPreToolUseBlocks: number;

  /**
   * Number of traced sessions that contributed at least one
   * `hook_block_repeat_tripped` event to `totalTrips`.
   */
  sessionsWithTrips: number;

  /**
   * Total traced sessions scanned in the window (regardless of whether they
   * had any trips). Zero when no sessions fell in the window.
   */
  sessionsScanned: number;
}

// ---------------------------------------------------------------------------
// Zero-aggregate factory
// ---------------------------------------------------------------------------

export function zeroGuardrailFalsePositiveAggregates(): GuardrailFalsePositiveAggregates {
  return {
    totalTrips: 0,
    falsePositiveTrips: 0,
    falsePositiveRate: null,
    totalPreToolUseBlocks: 0,
    sessionsWithTrips: 0,
    sessionsScanned: 0,
  };
}

// ---------------------------------------------------------------------------
// Per-trace analysis
// ---------------------------------------------------------------------------

interface TripObservation {
  /** `subagentId` from the phase metadata, or undefined for root-session trips. */
  actorId: string | undefined;
  /** Index of the trip event in the events array (for lookahead). */
  eventIndex: number;
}

/**
 * Extract all `hook_block_repeat_tripped` phase events from a parsed event
 * array.
 */
function collectTrips(events: TraceEvent[]): TripObservation[] {
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
function classifyTrip(
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

/**
 * Sum `PreToolUse` block counts from a `hook_summary` payload.
 * Returns 0 when the event has no PreToolUse counts.
 */
function sumPreToolUseBlocks(payload: HookSummaryPayload): number {
  const byDecision = payload.counts['PreToolUse'];
  if (!byDecision) return 0;
  let total = 0;
  for (const [decision, count] of Object.entries(byDecision)) {
    if (decision === 'block') total += count;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Scan witness traces in the lookback window and return false-positive
 * statistics for the `hook-block-repeat` meta-guard.
 *
 * Never throws — returns zero-aggregate when no sessions are found or when
 * all trace reads fail.
 */
export function aggregateGuardrailFalsePositives(
  options: InsightsOptions,
): GuardrailFalsePositiveAggregates {
  const agg = zeroGuardrailFalsePositiveAggregates();

  const stateDir = options.afkHome
    ? join(options.afkHome, 'state')
    : getAfkStateDir();
  const witnessRoot = join(stateDir, 'witness');
  const sessionsDir = join(stateDir, 'sessions');
  const cacheDir = options.afkHome
    ? join(options.afkHome, 'agent-framework', 'facets')
    : getFacetCacheDir();

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;

  const sessionIds = listSessionIds({ sessionsDir });
  for (const sessionId of sessionIds) {
    const facet = getOrDeriveFacet(sessionId, { sessionsDir, cacheDir });
    if (!facet) continue;
    if (new Date(facet.start_time).getTime() < cutoffMs) continue;

    const traceSessionId = facet.session_id;
    const tracePath = join(witnessRoot, traceSessionId, 'trace.jsonl');
    if (!existsSync(tracePath)) continue;

    let raw: string;
    try {
      raw = readFileSync(tracePath, 'utf-8');
    } catch {
      continue;
    }

    // Parse events; skip malformed lines.
    const events: TraceEvent[] = [];
    for (const parsed of parseJsonlLines(raw)) {
      const result = TraceEventSchema.safeParse(parsed);
      if (result.success) events.push(result.data);
    }

    agg.sessionsScanned++;

    // Collect hook_block_repeat_tripped events.
    const trips = collectTrips(events);

    if (trips.length > 0) {
      agg.sessionsWithTrips++;
      agg.totalTrips += trips.length;

      for (const trip of trips) {
        if (classifyTrip(events, trip.eventIndex, trip.actorId)) {
          agg.falsePositiveTrips++;
        }
      }
    }

    // Harvest PreToolUse block counts from hook_summary.
    for (const ev of events) {
      if (ev.kind !== 'hook_summary') continue;
      agg.totalPreToolUseBlocks += sumPreToolUseBlocks(ev.payload as HookSummaryPayload);
    }
  }

  // Compute rate now that all sessions are processed.
  agg.falsePositiveRate =
    agg.totalTrips > 0 ? agg.falsePositiveTrips / agg.totalTrips : null;

  return agg;
}

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
import { sidecarPredatesWindow } from './session-prescreen.js';
import type { InsightsOptions } from '../types.js';
import { parseJsonlLines } from '../../utils/jsonl.js';
import type { TraceEvent, SessionPhasePayload, ToolCallPayload, HookDecisionPayload, HookSummaryPayload } from '../../agent/trace/types.js';
import { collectTrips, classifyTrip } from './guardrail-false-positives.trips.js';

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

  /**
   * Per-ruleId block counts from `hook_decision` events with
   * `decision: 'block'` and a `ruleId` field set (#3849).
   *
   * Keys are the `ruleId` strings emitted by hooks (e.g.
   * `'readonly-bash.pipe-to-shell'`, `'write-roots.outside'`). Values are
   * the total number of block events for that rule across all traced sessions
   * in the window. Rules that have never fired (or whose hooks predate #3849)
   * do not appear. An empty record means no ruleId-tagged blocks were found.
   */
  byRule: Record<string, number>;

  /**
   * Total completed `tool_call` error rows with `failureClass: 'denial-breaker'`
   * across all traced sessions in the window (#3849 blindspot measurement).
   *
   * This counts tagged failures, NOT distinct breaker trip episodes. Multiple
   * rows can carry the tag for one episode; this cannot measure trip frequency.
   * Non-zero counts can prompt investigation of fork read-root scope.
   */
  denialBreakerTaggedFailures: number;

  /**
   * Total distinct `denial_circuit_breaker_tripped` session-phase events across
   * all traced sessions in the window (#3849 trip-episode count).
   *
   * Each event represents one distinct breaker trip episode (the emitter fires
   * exactly once per trip, at `breaker.count === DENIAL_CIRCUIT_BREAKER_THRESHOLD`).
   * This is the episode count the issue asked to surface alongside the tagged-failure
   * count. `null` means no traces in the window contained the event at all —
   * either no breaker trips occurred, or the traces predate PR #5093 which added
   * the event; callers should render these two cases differently from zero.
   *
   * Zero means the event kind is present in at least one trace but no trips fired.
   */
  denialBreakerTripEpisodes: number | null;
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
    // Rule IDs are hook-provided strings, including prototype property names.
    byRule: Object.create(null) as Record<string, number>,
    denialBreakerTaggedFailures: 0,
    // null = no traces observed the event at all (predate #5093 or no trips).
    denialBreakerTripEpisodes: null,
  };
}

// ---------------------------------------------------------------------------
// Per-trace analysis
// ---------------------------------------------------------------------------
// collectTrips and classifyTrip are in guardrail-false-positives.trips.ts
// (extracted to stay under the 350-code-line ceiling).

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
    // Conservative mtime pre-screen: skip without calling getOrDeriveFacet when
    // the sidecar mtime predates the cutoff. See session-prescreen.ts. (#4913)
    if (sidecarPredatesWindow(sessionId, sessionsDir, cutoffMs)) continue;
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

    // Harvest PreToolUse block counts from hook_summary, per-ruleId counts
    // from hook_decision blocks, denial-breaker-tagged failures, and
    // denial_circuit_breaker_tripped episode counts from tool_call /
    // session_phase events.
    for (const ev of events) {
      if (ev.kind === 'hook_summary') {
        agg.totalPreToolUseBlocks += sumPreToolUseBlocks(ev.payload as HookSummaryPayload);
        continue;
      }

      if (ev.kind === 'hook_decision') {
        const p = ev.payload as HookDecisionPayload;
        if (p.decision === 'block' && typeof p.ruleId === 'string' && p.ruleId.length > 0) {
          agg.byRule[p.ruleId] = (agg.byRule[p.ruleId] ?? 0) + 1;
        }
        continue;
      }

      if (ev.kind === 'session_phase') {
        const p = ev.payload as SessionPhasePayload;
        if (p.phase === 'denial_circuit_breaker_tripped') {
          // Seeing this event kind means the trace was produced by a build that
          // includes #5093. Upgrade null → 0 on first occurrence so callers can
          // distinguish "no trips in a #5093+ trace" from "trace predates the event".
          agg.denialBreakerTripEpisodes = (agg.denialBreakerTripEpisodes ?? 0) + 1;
        }
        continue;
      }

      if (ev.kind === 'tool_call') {
        const p = ev.payload as ToolCallPayload;
        if (p.phase === 'completed' && p.isError && p.failureClass === 'denial-breaker') {
          agg.denialBreakerTaggedFailures++;
        }
      }
    }
  }

  // Compute rate now that all sessions are processed.
  agg.falsePositiveRate =
    agg.totalTrips > 0 ? agg.falsePositiveTrips / agg.totalTrips : null;

  return agg;
}

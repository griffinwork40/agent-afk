/**
 * Detector: anomalous session closure reasons.
 *
 * The runtime writes a terminal `closure` event on every session teardown
 * (`src/agent/session/agent-session.ts:680` emits it; the writer's `seal()`
 * follows). The payload carries a `reason` discriminated union with seven
 * values; six of them indicate something other than a clean end-of-turn
 * stop:
 *
 *   - `budget_exceeded`     — monetary ceiling crossed
 *   - `timeout`             — wall-clock cap fired
 *   - `hook_blocked`        — a hook returned `decision: 'block'`
 *   - `abort`               — explicit cancellation / cascade
 *   - `iteration_cap`       — loop iteration ceiling
 *   - `max_turns_exceeded`  — turn ceiling
 *
 * `model_end_turn` is the only normal exit. Everything else is surfaced
 * as a card. One card per anomalous reason; sessions sharing that reason
 * merge into the same card via the standard slug-keyed merge rules.
 *
 * ## Why aggregate by reason, not by session
 *
 * A reviewer cares about "we keep hitting the budget ceiling," not "this
 * one session at 14:32 hit it." Grouping by reason converts dozens of
 * sessions into one card with N evidence rows.
 *
 * ## Caveats
 *
 *   - As of the runtime version this detector ships against, only
 *     `model_end_turn` is emitted in practice. The other reasons are
 *     declared in `src/agent/trace/types.ts:303–310` and validated by
 *     `ClosureReasonSchema` (`src/agent/trace/events.ts:250–258`) but the
 *     emission sites for `iteration_cap` / `hook_blocked` /
 *     `max_turns_exceeded` are not yet wired (see the closure handler in
 *     `agent-session.ts:690–706`). The detector is correct against the
 *     schema; it will start producing cards as those reasons get wired.
 *   - A single anomalous closure is meaningful but noisy. Default
 *     threshold is 1 — every anomalous closure is flagged — but
 *     `minOccurrences` lifts the bar when desired.
 *
 * @module improve/scan/detectors/closure-anomaly
 */

import type { DetectorResult, FailureEvidence, Severity } from '../../schemas.js';
import type { SessionRead } from '../reader.js';

/** Default minimum sessions sharing a reason before a card fires. */
export const DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES = 1;

/** Closure reasons we treat as anomalous. `model_end_turn` is excluded. */
const ANOMALOUS_REASONS = new Set<string>([
  'budget_exceeded',
  'timeout',
  'hook_blocked',
  'abort',
  'iteration_cap',
  'max_turns_exceeded',
]);

export interface ClosureAnomalyOptions {
  minOccurrences?: number;
}

/** One closure event picked up from a session. */
interface ClosureSighting {
  sessionId: string;
  relativeTracePath: string;
  seq: number;
  rawLine: string;
  reason: string;
  finalCostUsd: number;
  finalTurnCount: number;
}

/**
 * Run the detector. Pure function — no I/O. One {@link DetectorResult} per
 * anomalous closure reason that meets the threshold.
 */
export function detectClosureAnomaly(
  sessions: SessionRead[],
  options: ClosureAnomalyOptions = {},
): DetectorResult[] {
  const minOccurrences = options.minOccurrences ?? DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES;
  if (minOccurrences < 1) {
    throw new Error(`minOccurrences must be >= 1 (got ${minOccurrences})`);
  }

  // Bucket by reason.
  const byReason = new Map<string, ClosureSighting[]>();
  for (const session of sessions) {
    for (const item of session.events) {
      const ev = item.event;
      if (ev.kind !== 'closure') continue;
      const reason = ev.payload.reason;
      if (!ANOMALOUS_REASONS.has(reason)) continue;
      const sighting: ClosureSighting = {
        sessionId: session.sessionId,
        relativeTracePath: session.relativeTracePath,
        seq: ev.seq,
        rawLine: item.rawLine,
        reason,
        finalCostUsd: ev.payload.finalCostUsd,
        finalTurnCount: ev.payload.finalTurnCount,
      };
      const bucket = byReason.get(reason);
      if (bucket) {
        bucket.push(sighting);
      } else {
        byReason.set(reason, [sighting]);
      }
    }
  }

  const results: DetectorResult[] = [];
  for (const [reason, sightings] of byReason.entries()) {
    if (sightings.length < minOccurrences) continue;
    results.push(buildResult(reason, sightings));
  }
  return results;
}

/** Hard cap on evidence rows per card. Same convention as repeated-tool-use. */
const MAX_EVIDENCE_PER_CARD = 8;

function buildResult(reason: string, sightings: ClosureSighting[]): DetectorResult {
  const slug = makeSlug(reason);
  const observedAt = new Date().toISOString();

  // One evidence row per session, capped.
  const capped = sightings.slice(0, MAX_EVIDENCE_PER_CARD);
  const evidence: FailureEvidence[] = capped.map((s) => ({
    sessionId: s.sessionId,
    tracePath: s.relativeTracePath,
    eventIndices: [s.seq],
    excerpt: clampExcerpt(s.rawLine),
    annotation: `closure.reason='${s.reason}' · cost=${formatUsd(s.finalCostUsd)} · turns=${s.finalTurnCount}`,
  }));

  const totalCost = sightings.reduce((acc, s) => acc + s.finalCostUsd, 0);
  const avgTurns = sightings.reduce((acc, s) => acc + s.finalTurnCount, 0) / sightings.length;

  return {
    slug,
    title: `Session closure reason '${reason}' across ${sightings.length} session${sightings.length === 1 ? '' : 's'}`,
    pattern: 'closure-anomaly',
    severity: severityFor(reason, sightings.length),
    observedAt,
    evidence,
    detail: {
      detector: 'closure-anomaly@v1',
      closureReason: reason,
      affectedSessions: sightings.length,
      totalCostUsd: round4(totalCost),
      avgTurnCount: round2(avgTurns),
      maxCostUsd: round4(Math.max(...sightings.map((s) => s.finalCostUsd))),
      sessionIds: sightings.map((s) => s.sessionId),
      seqs: sightings.map((s) => s.seq),
    },
  };
}

/**
 * Severity ladder.
 *
 *   - `budget_exceeded` / `timeout` → high regardless of count (one is bad).
 *   - `hook_blocked` / `iteration_cap` / `max_turns_exceeded` → medium;
 *     escalates to high at ≥3 occurrences.
 *   - `abort` → low by default (often user-initiated), medium at ≥3.
 *
 * The ladder is intentionally conservative; reviewers can escalate via
 * triage notes without re-running the detector.
 */
function severityFor(reason: string, count: number): Severity {
  switch (reason) {
    case 'budget_exceeded':
    case 'timeout':
      return 'high';
    case 'hook_blocked':
    case 'iteration_cap':
    case 'max_turns_exceeded':
      return count >= 3 ? 'high' : 'medium';
    case 'abort':
      return count >= 3 ? 'medium' : 'low';
    default:
      // Shouldn't happen — ANOMALOUS_REASONS gate above — but be safe.
      return 'low';
  }
}

/**
 * Build a stable slug from the closure reason. Underscores are converted
 * to hyphens to satisfy the slug regex on `FailureCardSchema`.
 *
 * Example: `budget_exceeded` → `closure-anomaly-budget-exceeded`.
 */
export function makeSlug(reason: string): string {
  const safe = reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `closure-anomaly-${safe.length > 0 ? safe : 'unknown'}`;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function clampExcerpt(rawLine: string): string {
  if (rawLine.length <= 2000) return rawLine;
  return rawLine.slice(0, 1997) + '...';
}

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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
 *   - Emission is live for every reason this detector groups on. The
 *     reasons are declared in `src/agent/trace/types.ts:303–310` and
 *     validated by `ClosureReasonSchema` (`src/agent/trace/events.ts:250–258`).
 *     `hook_blocked` / `max_turns_exceeded` were wired by 78c40833 and
 *     `iteration_cap` by 1ba29e7e; `timeout` closures began appearing
 *     2026-07-07. An earlier revision of this comment claimed those sites
 *     were "not yet wired" and that only `model_end_turn` was emitted in
 *     practice — that was already false when written, and it kept this
 *     detector opt-in long after it had real signal. Do not re-add that
 *     caveat without re-checking `agent-session.ts` emission sites first.
 *   - A single anomalous closure is meaningful but noisy. Default
 *     threshold is 1 — every anomalous closure is flagged — but
 *     `minOccurrences` lifts the bar when desired.
 *   - `detail` reports TWO granularities on purpose, because a witness trace
 *     file is not one agent. `affectedSessions` / `sessionIds` count WITNESS
 *     TRACE FILES (`SessionRead.sessionId`, the witness directory name);
 *     `closureEventCount`, `totalCostUsd`, `maxCostUsd` and `avgTurnCount`
 *     aggregate every closure EVENT, i.e. every AgentSession instance. A
 *     parent and each child it forked write into the SAME trace file and each
 *     owns a DISJOINT cost accumulator, so summing events recovers that trace
 *     file's true spend while counting them would invent phantom sessions —
 *     see {@link distinctSessionIds}.
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
    // Contract: the THRESHOLD counts sessions — one noisy trace file must not
    // clear a multi-session bar — while the cost/turn aggregates and the
    // evidence rows count EVENTS. See distinctSessionIds and buildResult.
    const sessionIds = distinctSessionIds(sightings);
    if (sessionIds.length < minOccurrences) continue;
    results.push(buildResult(reason, sessionIds, sightings));
  }
  return results;
}

/**
 * Invariant: one entry per WITNESS TRACE FILE per reason — a `sessionId` that
 * emitted N closure events sharing a reason contributes exactly ONE id here.
 *
 * `sessionId` is the witness trace file's directory name (`reader.ts`'s
 * `parseTraceContent` stamps it onto every event parsed from that one
 * `trace.jsonl`), NOT a per-`AgentSession`-instance identity. A parent timeout
 * cascade-cancels every in-flight child and each cancellation writes its own
 * `closure{reason}` event into the SAME trace, because forked subagents share
 * the parent's `TraceWriter` by reference (`subagent.ts`'s
 * `effectiveTraceWriter` resolution). Counting those events as sessions made
 * one trace look like N independent ones and emitted duplicate ids; counting
 * distinct ids fixes that.
 *
 * This governs the session COUNT ONLY. Cost and turn aggregates deliberately do
 * NOT collapse: each instance owns a DISJOINT accumulator, so summing events is
 * the trace file's true spend. `sessionRunningCostUsd` is written in exactly
 * two places (re-zeroed in `initSdkLifecycle()`, and `+= m.totalCostUsd` from
 * that instance's OWN response metadata); a child's spend lands in a SEPARATE
 * accumulator via `recordSubagentCompletion` (`subagentRunningTokens`) and
 * never reaches the parent's. An earlier revision kept only the highest-cost
 * sighting per session, which discarded every other instance's spend and
 * under-reported the card (codex review, PR #847).
 *
 * Returned in first-seen order; `Set` preserves insertion order, so ordering is
 * stable across runs.
 */
function distinctSessionIds(sightings: ClosureSighting[]): string[] {
  return [...new Set(sightings.map((s) => s.sessionId))];
}

/** Hard cap on evidence rows per card. Same convention as repeated-tool-use. */
const MAX_EVIDENCE_PER_CARD = 8;

/**
 * Contract: `sessionIds` is the deduped id list — one entry per witness trace
 * file (see {@link distinctSessionIds}) — and drives the SESSION-scoped
 * figures: `affectedSessions`, `sessionIds`, the title, and the severity
 * ladder. `allSightings` is the raw event list and drives the
 * INSTANCE-scoped figures: `closureEventCount`, `totalCostUsd`, `maxCostUsd`,
 * `avgTurnCount`, and the evidence rows.
 *
 * The two granularities are reported side by side rather than folded together,
 * because a trace file is not one agent: collapsing events would under-report
 * spend and hide a cascade's fan-out, while counting them as sessions would
 * invent sessions that never existed.
 */
function buildResult(
  reason: string,
  sessionIds: string[],
  allSightings: ClosureSighting[],
): DetectorResult {
  const slug = makeSlug(reason);
  const observedAt = new Date().toISOString();

  // One evidence row per closure EVENT, capped — a cascade's distinct child
  // closures ARE the evidence, so collapsing them here would hide the fan-out.
  const capped = allSightings.slice(0, MAX_EVIDENCE_PER_CARD);
  const evidence: FailureEvidence[] = capped.map((s) => ({
    sessionId: s.sessionId,
    tracePath: s.relativeTracePath,
    eventIndices: [s.seq],
    excerpt: clampExcerpt(s.rawLine),
    annotation: `closure.reason='${s.reason}' · cost=${formatUsd(s.finalCostUsd)} · turns=${s.finalTurnCount}`,
  }));

  const totalCost = allSightings.reduce((acc, s) => acc + s.finalCostUsd, 0);
  const avgTurns =
    allSightings.reduce((acc, s) => acc + s.finalTurnCount, 0) / allSightings.length;

  return {
    slug,
    title: `Session closure reason '${reason}' across ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}`,
    pattern: 'closure-anomaly',
    severity: severityFor(reason, sessionIds.length),
    observedAt,
    evidence,
    detail: {
      // @v2: cost/turn aggregates moved from per-session-survivor to per-event
      // after the accumulators were confirmed disjoint. The version bump lets a
      // consumer tell v1's under-reported figures from v2's true totals.
      detector: 'closure-anomaly@v2',
      closureReason: reason,
      affectedSessions: sessionIds.length,
      closureEventCount: allSightings.length,
      totalCostUsd: round4(totalCost),
      avgTurnCount: round2(avgTurns),
      maxCostUsd: round4(Math.max(...allSightings.map((s) => s.finalCostUsd))),
      // Contract: `sessionIds` is deliberately UNCAPPED — its length IS
      // `affectedSessions`, so truncating it would break that equality. `seqs`
      // carries no such invariant: it indexes the evidence rows, so it is
      // capped to the same slice. A wide cascade emits one closure event per
      // cancelled child and would otherwise write an unbounded array into the
      // persisted card (a live card on disk already carries 386 entries).
      sessionIds,
      seqs: capped.map((s) => s.seq),
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

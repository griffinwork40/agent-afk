/**
 * Detector: tool-failure density.
 *
 * Surfaces tools that fail (return `isError: true` from the dispatcher) at
 * a meaningful absolute count AND a meaningful rate across all sessions in
 * the scan window.
 *
 * ## Why both count AND rate
 *
 * Either threshold alone produces false positives:
 *
 *   - Rate-only: a tool invoked 4 times that fails twice (50%) is statistical
 *     noise, not a pattern.
 *   - Count-only: a tool invoked 1000 times that fails 5 times (0.5%) is
 *     well within tolerance; flagging it would bury real signal.
 *
 * Both must clear `minFailures` AND `minFailureRate` for a card to fire.
 *
 * ## Why group by tool, not by session
 *
 * A reviewer cares about "Bash is failing 40% of the time," not "this one
 * session had a bad Bash call." Grouping by `toolName` collapses dozens of
 * sessions into one card per tool with per-session evidence rows.
 *
 * ## Data source
 *
 * The runtime emits a `tool_call completed` event for every dispatched tool
 * (`src/agent/providers/anthropic-direct/loop.ts:461-468`), carrying
 * `isError`, `truncated`, `durationMs`, and `resultBytes` from the
 * dispatcher's `ToolResult`. Schema at
 * `src/agent/trace/events.ts:33-42`. No additional emission wiring needed —
 * the detector reads what's already there.
 *
 * Started-without-completed events (mid-call crashes) are NOT counted as
 * failures here. They're a different signal — covered by closure-anomaly's
 * unsealed-trace coverage gap.
 *
 * ## Caveats
 *
 *   - "Failure" means `isError: true` returned by the dispatcher. The trace
 *     payload now carries a coarse `failureClass` (set at the dispatcher gates
 *     and browser handlers — see {@link ToolFailureClass}). This detector uses
 *     it to EXCLUDE "the system correctly said no" results (policy refusal,
 *     permission denial, hook block, abort) from both the failure count and the
 *     call total — see {@link EXCLUDED_FAILURE_CLASSES}. Failures with no class
 *     (older traces, handler throws, malformed input) still count, preserving
 *     back-compat. The per-class `failureClassBreakdown` and `excludedByClass`
 *     are surfaced in the card detail so a reviewer can see the mix.
 *   - `timeout` is classified but NOT excluded — a high timeout rate can be a
 *     real signal — so it still counts toward the rate, just visibly.
 *   - Tools that return `isError: true` as an unclassified *signal* to the LLM
 *     (e.g. intentional "no results" responses) will still inflate the rate.
 *     Reviewers can suppress via card status: 'deferred'.
 *
 * @module improve/scan/detectors/tool-failure-density
 */

import type { DetectorResult, FailureEvidence, Severity } from '../../schemas.js';
import type { SessionRead } from '../reader.js';
import type { ToolFailureClass } from '../../../agent/trace/types.js';

/**
 * Failure classes that mean "the system correctly said no", not "the tool
 * failed". A domain-policy refusal, a permission denial, a PreToolUse hook
 * block, or an aborted call all return `isError: true` so the model sees the
 * refusal — but counting them as tool failures inflated the signal and
 * manufactured false-positive cards (e.g. `browser_open` looking 50% broken
 * when half its calls were policy refusals working exactly as designed).
 *
 * Results in this set are excluded from BOTH the failure count and the call
 * total. `timeout` is deliberately NOT excluded — a high timeout rate can be a
 * real problem (too-tight a deadline, a systematically slow target) — but it IS
 * surfaced in the per-class breakdown so a reviewer can judge.
 *
 * Back-compat: traces written before the `failureClass` field existed carry no
 * class, so historical failures are never excluded — they count exactly as they
 * did before. Only post-upgrade traces benefit.
 */
const EXCLUDED_FAILURE_CLASSES: ReadonlySet<ToolFailureClass> = new Set([
  'policy-refusal',
  'permission-denied',
  'hook-block',
  'abort',
]);

/** Minimum absolute failure count for a tool before a card fires. */
export const DEFAULT_TOOL_FAILURE_MIN_FAILURES = 3;

/**
 * Minimum failure rate (failures / total calls) for a tool before a card
 * fires. Default 0.25 — a quarter of calls failing is unambiguously a
 * pattern worth surfacing.
 */
export const DEFAULT_TOOL_FAILURE_MIN_RATE = 0.25;

/** Hard cap on evidence rows per card. Same convention as the other detectors. */
const MAX_EVIDENCE_PER_CARD = 8;

export interface ToolFailureDensityOptions {
  minFailures?: number;
  minFailureRate?: number;
}

/** A single failure picked up from a session. */
interface FailureSighting {
  sessionId: string;
  relativeTracePath: string;
  seq: number;
  rawLine: string;
  resultBytes: number;
  durationMs: number;
  truncated: boolean;
  /** Coarse failure class from the trace event, when present. */
  failureClass?: ToolFailureClass;
}

/** Aggregated stats per tool name across all sessions. */
interface ToolStats {
  toolName: string;
  totalCalls: number;
  failures: FailureSighting[];
  /** Distinct sessionIds that had at least one failure on this tool. */
  affectedSessions: Set<string>;
  /** How many failures were also truncated (often signals a separate bug). */
  truncatedFailureCount: number;
  /** Count of results excluded as "system said no" (see EXCLUDED_FAILURE_CLASSES),
   *  keyed by class. Surfaced in the card detail for transparency. */
  excludedByClass: Map<ToolFailureClass, number>;
}

/**
 * Run the detector. Pure function — no I/O. One {@link DetectorResult} per
 * tool whose failure count and rate both meet the thresholds.
 */
export function detectToolFailureDensity(
  sessions: SessionRead[],
  options: ToolFailureDensityOptions = {},
): DetectorResult[] {
  const minFailures = options.minFailures ?? DEFAULT_TOOL_FAILURE_MIN_FAILURES;
  const minFailureRate = options.minFailureRate ?? DEFAULT_TOOL_FAILURE_MIN_RATE;

  if (minFailures < 1) {
    throw new Error(`minFailures must be >= 1 (got ${minFailures})`);
  }
  if (minFailureRate <= 0 || minFailureRate > 1) {
    throw new Error(`minFailureRate must be in (0, 1] (got ${minFailureRate})`);
  }

  // Aggregate by tool name across every session.
  const byTool = new Map<string, ToolStats>();
  for (const session of sessions) {
    for (const item of session.events) {
      const ev = item.event;
      if (ev.kind !== 'tool_call') continue;
      if (ev.payload.phase !== 'completed') continue;
      // Skip synthetic circuit-breaker blocks — not real tool outcomes.
      if (ev.payload.circuitBreaker === true) continue;

      const stats = getOrInit(byTool, ev.payload.name);
      const failureClass = ev.payload.failureClass;

      // "System said no" — exclude from BOTH numerator and denominator so a
      // policy/permission/hook/abort refusal can never manufacture a card.
      // Recorded separately for reviewer transparency.
      if (failureClass !== undefined && EXCLUDED_FAILURE_CLASSES.has(failureClass)) {
        stats.excludedByClass.set(failureClass, (stats.excludedByClass.get(failureClass) ?? 0) + 1);
        continue;
      }

      stats.totalCalls += 1;
      if (ev.payload.isError) {
        stats.failures.push({
          sessionId: session.sessionId,
          relativeTracePath: session.relativeTracePath,
          seq: ev.seq,
          rawLine: item.rawLine,
          resultBytes: ev.payload.resultBytes,
          durationMs: ev.payload.durationMs,
          truncated: ev.payload.truncated,
          ...(failureClass !== undefined ? { failureClass } : {}),
        });
        stats.affectedSessions.add(session.sessionId);
        if (ev.payload.truncated) stats.truncatedFailureCount += 1;
      }
    }
  }

  const results: DetectorResult[] = [];
  for (const stats of byTool.values()) {
    if (stats.failures.length < minFailures) continue;
    const rate = stats.failures.length / stats.totalCalls;
    if (rate < minFailureRate) continue;
    results.push(buildResult(stats, rate));
  }
  // Deterministic order: by tool name.
  results.sort((a, b) => a.slug.localeCompare(b.slug));
  return results;
}

function getOrInit(map: Map<string, ToolStats>, toolName: string): ToolStats {
  let stats = map.get(toolName);
  if (!stats) {
    stats = {
      toolName,
      totalCalls: 0,
      failures: [],
      affectedSessions: new Set<string>(),
      truncatedFailureCount: 0,
      excludedByClass: new Map<ToolFailureClass, number>(),
    };
    map.set(toolName, stats);
  }
  return stats;
}

function buildResult(stats: ToolStats, rate: number): DetectorResult {
  const slug = makeSlug(stats.toolName);
  const observedAt = new Date().toISOString();

  const capped = stats.failures.slice(0, MAX_EVIDENCE_PER_CARD);
  const evidence: FailureEvidence[] = capped.map((f) => ({
    sessionId: f.sessionId,
    tracePath: f.relativeTracePath,
    eventIndices: [f.seq],
    excerpt: clampExcerpt(f.rawLine),
    annotation: `isError=true${f.failureClass ? ` · class=${f.failureClass}` : ''} · resultBytes=${f.resultBytes} · durationMs=${f.durationMs}${f.truncated ? ' · truncated' : ''}`,
  }));

  const totalDuration = stats.failures.reduce((acc, f) => acc + f.durationMs, 0);
  const avgFailureDurationMs = totalDuration / stats.failures.length;

  // Per-class breakdown of the COUNTED failures (unclassified = no failureClass,
  // e.g. a handler throw or malformed input — the pre-classification default).
  const failureClassBreakdown: Record<string, number> = {};
  for (const f of stats.failures) {
    const key = f.failureClass ?? 'unclassified';
    failureClassBreakdown[key] = (failureClassBreakdown[key] ?? 0) + 1;
  }
  // Refusals excluded from the stats entirely, for reviewer transparency.
  const excludedByClass: Record<string, number> = {};
  for (const [cls, n] of stats.excludedByClass) excludedByClass[cls] = n;

  return {
    slug,
    title: buildTitle(stats.toolName, stats.failures.length, stats.totalCalls, rate),
    pattern: 'tool-failure-density',
    severity: severityFor(stats.failures.length, rate),
    observedAt,
    evidence,
    detail: {
      detector: 'tool-failure-density@v2',
      toolName: stats.toolName,
      totalCalls: stats.totalCalls,
      failureCount: stats.failures.length,
      failureRate: round4(rate),
      affectedSessionCount: stats.affectedSessions.size,
      truncatedFailureCount: stats.truncatedFailureCount,
      avgFailureDurationMs: round2(avgFailureDurationMs),
      failureClassBreakdown,
      excludedByClass,
      sessionIds: Array.from(stats.affectedSessions),
      seqs: stats.failures.map((f) => f.seq),
    },
  };
}

/**
 * Severity ladder.
 *
 *   - 100% failure rate → high (something structural is broken, regardless of count).
 *   - ≥50% rate → high.
 *   - ≥25% rate → medium, escalates to high at ≥10 failures.
 *   - <25% rate (only reachable when caller lowered the threshold) → low.
 *
 * The ladder is conservative; reviewers can override via triage notes.
 */
function severityFor(failureCount: number, rate: number): Severity {
  if (rate >= 1.0) return 'high';
  if (rate >= 0.5) return 'high';
  if (rate >= 0.25) return failureCount >= 10 ? 'high' : 'medium';
  return failureCount >= 10 ? 'medium' : 'low';
}

function buildTitle(
  toolName: string,
  failures: number,
  total: number,
  rate: number,
): string {
  const pct = (rate * 100).toFixed(1);
  return `'${toolName}' tool failed ${failures}/${total} calls (${pct}%)`;
}

/**
 * Build a stable slug from the tool name. Sanitized to `[a-z0-9-]` to
 * satisfy the slug regex on `FailureCardSchema`.
 *
 * Example: `Bash` → `tool-failure-bash`.
 */
export function makeSlug(toolName: string): string {
  const safe = toolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `tool-failure-${safe.length > 0 ? safe : 'unknown'}`;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function clampExcerpt(rawLine: string): string {
  if (rawLine.length <= 2000) return rawLine;
  return rawLine.slice(0, 1997) + '...';
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

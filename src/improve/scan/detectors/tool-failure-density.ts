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
 *     payload now carries a coarse `failureClass` (set at the dispatcher gates,
 *     the browser handlers, and the ask_question handler — see
 *     {@link ToolFailureClass}). This detector uses it to EXCLUDE "the system
 *     correctly said no / the human did not answer" results (policy refusal,
 *     permission denial, hook block, abort, elicitation decline) from both the
 *     failure count and the call total — see {@link EXCLUDED_FAILURE_CLASSES}.
 *     Failures with no class (older traces, handler throws, malformed input)
 *     still count, preserving back-compat. The per-class
 *     `failureClassBreakdown` and `excludedByClass`
 *     are surfaced in the card detail so a reviewer can see the mix.
 *   - `timeout` is classified but NOT excluded — a high timeout rate can be a
 *     real signal — so it still counts toward the rate, just visibly.
 *   - Tools that return `isError: true` as an unclassified *signal* to the LLM
 *     (e.g. intentional "no results" responses) will still inflate the rate.
 *     Reviewers can suppress via card status: 'deferred'.
 *   - **Co-occurring web_scrape + web_request failures** are a known
 *     environment-connectivity false positive: when the runtime environment has
 *     no outbound connectivity (or Node fetch fails on public URLs), subagents
 *     often fall back from `web_scrape` to `web_request`, producing two
 *     separate tool-failure cards at high severity — one per tool — even though
 *     the root cause is a single environment condition, not two independent tool
 *     bugs. A future improvement should detect sessions where both tools fail
 *     together and emit a single `environment-connectivity` signal at `medium`
 *     severity instead. Until then, reviewers should manually reclassify cards
 *     whose evidence rows overlap heavily across sessions (`status: 'deferred'`,
 *     note explaining the connectivity root cause). See issue #1917.
 *
 * @module improve/scan/detectors/tool-failure-density
 */

import type { DetectorResult, FailureEvidence, Severity } from '../../schemas.js';
import type { SessionRead } from '../reader.js';
import type { ToolFailureClass } from '../../../agent/trace/types.js';
import { clampExcerpt, MAX_EVIDENCE_PER_CARD } from './_lib.js';
import { BENIGN_FAILURE_CLASSES } from '../../../agent/trace/types.js';

// ---------------------------------------------------------------------------
// Error-head normalization
// ---------------------------------------------------------------------------

/**
 * Maximum number of error clusters surfaced in the card detail. Top-N by
 * descending failure count; ties broken by first-seen order (insertion stable).
 */
export const MAX_ERROR_CLUSTERS = 5;

/**
 * Normalise an `errorHead` string so that failures differing only in
 * session-specific identifiers, numeric values, quoted strings, paths, or
 * durations collapse to the same cluster key.
 *
 * Transformations applied in order (each pass operates on the output of the
 * previous one):
 *
 *   1. Known ID prefixes (`toolu_…`, `bg-…`, `call_…`, `sess-…`,
 *      `msg-…`, `sub-…`) → `<id>`.
 *   2. URLs (`https://…`, `http://…`, `file://…`) → `<url>`, applied before
 *      the path pass so that `https://example.com/a` is not partially matched.
 *   3. Absolute paths (Unix-style: whitespace/start-of-string + `/` + ≥2
 *      non-space chars) → `<path>`. Anchored so that `and/or` and contractions
 *      such as `it's` are not collapsed.
 *   4. Duration patterns, including compound forms (`2m30s`, `1h05m`) → `<dur>`.
 *   5. Quoted values — double-quoted (≤120 chars) → `<val>`; single-quoted
 *      only when the quote is preceded by `^` (start of string), whitespace,
 *      `(`, `[`, `{`, `,`, `;`, or `:` (not a contraction apostrophe) → `<val>`.
 *   6. Remaining digit runs (≥2 digits) → `#`.
 *   7. Collapse runs of whitespace to a single space and trim.
 *
 * The result is a stable string suitable for use as a `Map` key.
 */
export function normalizeErrorHead(head: string): string {
  let s = head;

  // 1. Known ID prefixes → <id>
  s = s.replace(/\b(?:toolu|call|bg|sess|msg|sub)[_-][A-Za-z0-9_-]+/g, '<id>');

  // 2. URLs — must run before the path pass so that `https://host/path` is
  //    collapsed as a whole rather than leaving `https:` as a stray token.
  s = s.replace(/\b(?:https?|file):\/\/[^\s"',;)}\]]{2,}/g, '<url>');

  // 3. Absolute paths anchored at whitespace or start-of-string, so that
  //    internal slashes in words like `and/or` are not matched.
  s = s.replace(/(^|\s)\/[^\s"',;)}\]]{2,}/g, '$1<path>');

  // 4. Duration patterns including compound forms: 123ms, 4.5s, 2m30s, 1h05m.
  //    The inner group `(?:\d+(?:ms|s|m|h))+` captures one or more unit
  //    segments so that `2m30s` collapses to a single `<dur>` token.
  s = s.replace(/\b(?:\d+(?:\.\d+)?(?:ms|s|m|h))+\b/g, '<dur>');

  // 5. Quoted values — double quotes (straightforward) and single quotes only
  //    at word boundaries (prevents collapsing contraction apostrophes like
  //    `can't` or `it's`).
  s = s.replace(/"[^"]{0,120}"/g, '<val>');
  s = s.replace(/(^|[\s([{,;:])('[^']{0,120}')(?=$|[\s)\]},;:])/g, '$1<val>');

  // 6. Remaining digit runs of 2+ digits → #
  s = s.replace(/\b\d{2,}\b/g, '#');

  // 7. Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Failure classes that mean "the system correctly said no" or "the human did
 * not answer", not "the tool failed". A domain-policy refusal, a permission
 * denial, a PreToolUse hook block, an aborted call, or an `ask_question`
 * decline/cancel all return `isError: true` so the model sees the outcome —
 * but counting them as tool failures inflated the signal and manufactured
 * false-positive cards (e.g. `browser_open` looking 50% broken when half its
 * calls were policy refusals working exactly as designed, or `ask_question`
 * looking 33% broken when the operator was simply AFK on an interactive
 * surface).
 *
 * Results in this set are excluded from BOTH the failure count and the call
 * total. `timeout` is deliberately NOT excluded — a high timeout rate can be a
 * real problem (too-tight a deadline, a systematically slow target) — but it IS
 * surfaced in the per-class breakdown so a reviewer can judge.
 *
 * Back-compat: traces written before the `failureClass` field existed carry no
 * class, so historical failures are never excluded — they count exactly as they
 * did before. Only post-upgrade traces benefit.
 *
 * The membership list itself lives in `agent/trace/types.ts` beside the
 * `ToolFailureClass` per-class notes, because the interactive tool-lane keys
 * its neutral-glyph rendering off the same "system correctly said no" split
 * (#75). Two copies of this set would drift the moment a class is added.
 */
const EXCLUDED_FAILURE_CLASSES: ReadonlySet<ToolFailureClass> = BENIGN_FAILURE_CLASSES;

/** Minimum absolute failure count for a tool before a card fires. */
export const DEFAULT_TOOL_FAILURE_MIN_FAILURES = 3;

/**
 * Minimum failure rate (failures / total calls) for a tool before a card
 * fires. Default 0.25 — a quarter of calls failing is unambiguously a
 * pattern worth surfacing.
 */
export const DEFAULT_TOOL_FAILURE_MIN_RATE = 0.25;

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
  /** First ≤200 chars of error text (redacted), when present on the event. */
  errorHead?: string;
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
          ...(ev.payload.errorHead !== undefined ? { errorHead: ev.payload.errorHead } : {}),
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

  const errorClusters = buildErrorClusters(stats.failures);

  return {
    slug,
    title: buildTitle(stats.toolName, stats.failures.length, stats.totalCalls, rate),
    pattern: 'tool-failure-density',
    severity: severityFor(stats.failures.length, rate),
    observedAt,
    evidence,
    detail: {
      detector: 'tool-failure-density@v3',
      toolName: stats.toolName,
      totalCalls: stats.totalCalls,
      failureCount: stats.failures.length,
      failureRate: round4(rate),
      affectedSessionCount: stats.affectedSessions.size,
      truncatedFailureCount: stats.truncatedFailureCount,
      avgFailureDurationMs: round2(avgFailureDurationMs),
      failureClassBreakdown,
      excludedByClass,
      errorClusters,
      sessionIds: Array.from(stats.affectedSessions),
      seqs: stats.failures.map((f) => f.seq),
    },
  };
}

/**
 * One error cluster entry surfaced in `card.detail.errorClusters`.
 *
 * `normalized` is the cluster key produced by {@link normalizeErrorHead}.
 * `count` is the number of failures that mapped to that key.
 * `sample` is one raw (un-normalized) `errorHead` from those failures — the
 * first one seen — so a reviewer can see what the real error text looks like
 * without losing the normalization that groups them.
 */
export interface ErrorCluster {
  normalized: string;
  count: number;
  sample: string;
}

/**
 * Group failures by normalized `errorHead` and return the top
 * {@link MAX_ERROR_CLUSTERS} clusters by descending count.
 *
 * Failures with no `errorHead` are excluded from clustering entirely. If no
 * failure carries an `errorHead` the returned array is empty (nothing useful
 * to cluster).
 */
function buildErrorClusters(failures: FailureSighting[]): ErrorCluster[] {
  const withHead = failures.filter((f) => f.errorHead !== undefined);
  if (withHead.length === 0) return [];

  // Accumulate counts and first-seen sample per normalized key.
  const counts = new Map<string, number>();
  const samples = new Map<string, string>();
  for (const f of withHead) {
    const raw = f.errorHead as string;
    const key = normalizeErrorHead(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!samples.has(key)) samples.set(key, raw);
  }

  // Sort by descending count, then cap.
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ERROR_CLUSTERS);

  return sorted.map(([normalized, count]) => ({
    normalized,
    count,
    sample: samples.get(normalized) ?? '',
  }));
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

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

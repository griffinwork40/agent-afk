/**
 * Typed aggregate structs for the `afk insights` usage analytics dashboard.
 *
 * All types here are pure data — no I/O, no LLM calls.
 *
 * Privacy invariants enforced at this type boundary:
 *   - No `telegramChatId` field anywhere in output aggregates.
 *   - No `responseExcerpt` field anywhere in output aggregates.
 *   - No prompt content, no file paths in Recommendation fields.
 *
 * @module insights/types
 */

// ---------------------------------------------------------------------------
// Input options
// ---------------------------------------------------------------------------

export interface InsightsOptions {
  /** Lookback window in days (default 30). */
  days: number;
  /** Override AFK_HOME for tests. When set, path helpers use this root. */
  afkHome?: string | undefined;
}

// ---------------------------------------------------------------------------
// SessionAggregates — derived from ~/.afk/state/sessions/*.json
// ---------------------------------------------------------------------------

export interface SessionAggregates {
  totalSessions: number;
  totalCostUsd: number;
  /**
   * Combined token total from the session sidecar's `totalTokens` field
   * (input + output + cache, summed). The sidecar does NOT carry an
   * input/output split — that lives in the witness trace closure events and
   * is surfaced on `TraceAggregates`. This field is a coarse fallback for
   * sessions with no trace.
   */
  totalTokens: number;
  /** key: 'YYYY-MM-DD' */
  byDay: Record<string, { costUsd: number; sessions: number }>;
  byModel: Record<string, { costUsd: number; sessions: number }>;
  bySurface: Record<string, { costUsd: number; sessions: number }>;
}

// ---------------------------------------------------------------------------
// TraceAggregates — derived from ~/.afk/state/witness/*/trace.jsonl
// ---------------------------------------------------------------------------

export interface TraceAggregates {
  totalTracedSessions: number;
  /** tool name → total completed calls */
  toolCallCounts: Record<string, number>;
  /** tool name → error count */
  toolErrorCounts: Record<string, number>;
  /** tool name → sum of durations in ms */
  toolDurationsMs: Record<string, number>;
  /** depth → count of subagent forks at that depth */
  subagentForkDepths: Record<number, number>;
  compactionCount: number;
  /** closure reason → count */
  closureReasons: Record<string, number>;
  // Token + cost totals sourced from closure-event `finalTokens` /
  // `finalCostUsd` payloads. These are the AUTHORITATIVE token split — the
  // session sidecar only stores a single combined `totalTokens`, so the real
  // input/output/cache breakdown is only available here.
  /** sum of closure `finalTokens.input` across traced sessions */
  totalInputTokens: number;
  /** sum of closure `finalTokens.output` */
  totalOutputTokens: number;
  /** sum of closure `finalTokens.cacheRead` */
  totalCacheReadTokens: number;
  /** sum of closure `finalTokens.cacheCreation` */
  totalCacheCreationTokens: number;
  /** sum of closure `finalCostUsd` (authoritative per-session cost) */
  totalCostUsd: number;
  /** count of traced sessions whose closure reported a non-zero cost */
  sessionsWithCost: number;
}

// ---------------------------------------------------------------------------
// DaemonAggregates — derived from forge-telemetry.jsonl
// ---------------------------------------------------------------------------

export interface DaemonAggregates {
  totalRuns: number;
  successCount: number;
  errorCount: number;
  skipCount: number;
  byTaskId: Record<string, { success: number; error: number; skip: number }>;
  /** trigger → count */
  triggerBreakdown: Record<string, number>;
  /** skip reason → count */
  skipReasons: Record<string, number>;
  /** max 5 recent errors — NO responseExcerpt, NO user content */
  recentErrors: Array<{ taskId: string; ts: number; message: string }>;
  avgDurationMs: number;
}

// ---------------------------------------------------------------------------
// RoutingAggregates — derived from routing-decisions.jsonl
// ---------------------------------------------------------------------------

export interface RoutingAggregates {
  totalRoutingEvents: number;
  /** fork/inline/load → count */
  skillDispatchModes: Record<string, number>;
  /** skill name → dispatch count */
  skillFrequency: Record<string, number>;
  composeCallCount: number;
  avgComposeNodes: number;
  avgComposeEdges: number;
  /** tool name → overflow kill count */
  overflowKills: Record<string, number>;
}

// ---------------------------------------------------------------------------
// InsightAggregates — full merged result
// ---------------------------------------------------------------------------

export interface InsightAggregates {
  /** Date.now() at generation time */
  generatedAt: number;
  windowDays: number;
  sessions: SessionAggregates;
  traces: TraceAggregates;
  daemon: DaemonAggregates;
  routing: RoutingAggregates;
}

// ---------------------------------------------------------------------------
// Recommendation — zero I/O, zero LLM, pure rule evaluation
// ---------------------------------------------------------------------------

export type RecommendationSeverity = 'high' | 'medium' | 'info';

export interface Recommendation {
  severity: RecommendationSeverity;
  title: string;
  /** No file paths, no prompt content, no telegramChatId */
  body: string;
  /** The numeric value that triggered this rule */
  metric: number;
}

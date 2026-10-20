/**
 * Shadow-git-detect observe-window aggregator (#3849 — measurement phase).
 *
 * `shadow-git-detect` (src/agent/shadow-git-detect.ts) runs in observe-only
 * mode for issue #3758's shadow window: it detects git identity-bypass
 * patterns (`--no-verify`, explicit author/committer overrides) but returns
 * `decision: 'approve'` so the command is never blocked. Each detection is
 * stamped as a `hook_decision` event with `reason` starting with the stable
 * prefix {@link SHADOW_GIT_OBSERVE_REASON_PREFIX}.
 *
 * This aggregator measures how often the detector fires across traced sessions,
 * giving operators the evidence they need to promote the guard from observe to
 * block — or to retire it if the trigger count is negligible.
 *
 * ## Data source
 *
 * Witness trace JSONL files under `~/.afk/state/witness/`. The signal is:
 *
 *   - `hook_decision` with `reason` starting `'shadow-git observe-only'` and
 *     `decision: 'approve'` → the guard observed a pattern (but did not block).
 *
 * ## What this does NOT do
 *
 * This is MEASUREMENT ONLY. The guard is not promoted, weakened, or removed
 * here. Promotion to block is a NEEDS-DECISION: an operator must review the
 * counts and false-positive signals before any behaviour changes (#3849).
 *
 * ## Limitations
 *
 * - Tool args are not in the witness trace; the exact git command that
 *   triggered the detection cannot be reconstructed from trace alone.
 * - `subagentId` attribution follows the same pattern as `guardrail-false-
 *   positives.ts`: present on fork firings, absent on root-session firings.
 *
 * @module insights/aggregators/shadow-git-observe
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAfkStateDir, getFacetCacheDir } from '../../paths.js';
import { TraceEventSchema } from '../../agent/trace/events.js';
import { listSessionIds, getOrDeriveFacet } from '../../agent/facets/index.js';
import type { InsightsOptions } from '../types.js';
import { parseJsonlLines } from '../../utils/jsonl.js';
import type { TraceEvent, HookDecisionPayload } from '../../agent/trace/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stable prefix that `shadow-git-detect` stamps on every `hook_decision`
 * reason it emits. Mirrored from `src/agent/shadow-git-detect.ts` as a
 * literal so the aggregator stays decoupled from the runtime module — the
 * same pattern used by `denial-circuit-breaker.ts` for its prefix constant.
 *
 * If the producer ever changes this string, the aggregator silently stops
 * counting, which is observable as a drop to zero — easy to notice and fix.
 */
export const SHADOW_GIT_OBSERVE_REASON_PREFIX = 'shadow-git observe-only';
// Invariant: SHADOW_GIT_OBSERVE_REASON_PREFIX must equal SHADOW_GIT_REASON_PREFIX
// in src/agent/shadow-git-detect.ts. They are kept as separate literals so
// this aggregator stays decoupled from the runtime module (same pattern as
// denial-circuit-breaker.ts). The equality is asserted in the test suite
// (shadow-git-observe.test.ts: 'matches the shadow-git-detect producer prefix').

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Statistics for the `shadow-git-detect` observe window over the time window. */
export interface ShadowGitObserveAggregates {
  /**
   * Total `hook_decision` events with `reason` starting with
   * {@link SHADOW_GIT_OBSERVE_REASON_PREFIX} observed across all traced
   * sessions in the window. Each event = one guard firing.
   */
  totalFirings: number;

  /**
   * Subset attributed to forked sub-agents (`subagentId` present on the
   * `hook_decision` payload). Root-session firings = `totalFirings - forkFirings`.
   */
  forkFirings: number;

  /**
   * Number of distinct sessions that contributed at least one firing.
   */
  sessionsWithFirings: number;

  /**
   * Total traced sessions scanned in the window. Zero when no sessions fell
   * in the window.
   */
  sessionsScanned: number;

  /**
   * Breakdown of detected patterns by the label fragment in the reason string.
   * Keys are the label tokens extracted from `reason` after the prefix, e.g.
   * `'no-verify'`, `'author-override'`, `'env-identity'`. Values are counts.
   *
   * Unknown/unparseable reason strings are binned under `'unknown'`.
   */
  byLabel: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Zero-aggregate factory
// ---------------------------------------------------------------------------

export function zeroShadowGitObserveAggregates(): ShadowGitObserveAggregates {
  return {
    totalFirings: 0,
    forkFirings: 0,
    sessionsWithFirings: 0,
    sessionsScanned: 0,
    byLabel: {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract label tokens from a `shadow-git observe-only [label1, label2]`
 * reason string. Returns `['unknown']` when the string is malformed.
 */
function extractLabels(reason: string): string[] {
  const inner = reason.slice(SHADOW_GIT_OBSERVE_REASON_PREFIX.length).trim();
  // Expected format: " [label1, label2]"
  const match = /^\s*\[([^\]]*)\]$/.exec(inner);
  if (!match || !match[1]) return ['unknown'];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Scan witness traces in the lookback window and return observe-window
 * statistics for the `shadow-git-detect` guard.
 *
 * Never throws — returns zero-aggregate when no sessions are found or when
 * all trace reads fail.
 */
export function aggregateShadowGitObserve(
  options: InsightsOptions,
): ShadowGitObserveAggregates {
  const agg = zeroShadowGitObserveAggregates();

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

    let sessionHadFiring = false;
    for (const ev of events) {
      if (ev.kind !== 'hook_decision') continue;
      const p = ev.payload as HookDecisionPayload;
      // Invariant: only 'approve' decisions are counted. The shadow-git guard
      // runs in observe-only mode and always emits decision: 'approve' — it
      // never blocks. Events with decision: 'block' (from other guards that
      // happen to share the reason prefix) must not be counted here.
      if (p.decision !== 'approve') continue;
      if (typeof p.reason !== 'string') continue;
      if (!p.reason.startsWith(SHADOW_GIT_OBSERVE_REASON_PREFIX)) continue;

      agg.totalFirings++;
      sessionHadFiring = true;

      if (typeof p.subagentId === 'string') {
        agg.forkFirings++;
      }

      for (const label of extractLabels(p.reason)) {
        agg.byLabel[label] = (agg.byLabel[label] ?? 0) + 1;
      }
    }

    if (sessionHadFiring) agg.sessionsWithFirings++;
  }

  return agg;
}

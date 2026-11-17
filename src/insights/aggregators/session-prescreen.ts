/**
 * Conservative mtime pre-screen for facet-based aggregators.
 *
 * Problem (#4913): the three trace-based aggregators (traces, shadow-git-observe,
 * guardrail-false-positives) call `getOrDeriveFacet` for every session sidecar
 * before comparing `facet.start_time` with the cutoff. On a large session store
 * this causes every facet to be re-derived when FACET_VERSION is bumped, even
 * for sessions that are far outside the requested window.
 *
 * Fix: check the sidecar file's mtime before calling `getOrDeriveFacet`. A
 * session's sidecar is always written at or after `startedAt`, so if the sidecar
 * mtime is strictly before the cutoff the session cannot have started inside the
 * window. Skip it without reading or re-deriving.
 *
 * Safety contract (conservative pre-screen, never a false negative):
 *   - A session that started inside the window is never dropped. Its sidecar
 *     mtime is >= startedAt, which is >= cutoffMs, so it passes this check.
 *   - A session that started before the cutoff but was modified after it also
 *     passes: its mtime >= cutoffMs, so `getOrDeriveFacet` is called, and the
 *     authoritative `facet.start_time` check in the aggregator correctly excludes
 *     it.
 *   - The existing `facet.start_time` comparison in each aggregator remains the
 *     authoritative filter. This helper is only a cheap early-exit guard.
 *
 * @module insights/aggregators/session-prescreen
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { debugLog, isDebugEnabled } from '../../utils/debug.js';

// Cumulative across aggregator scans, counting only stats made with DEBUG on.
let debugStatCount = 0;
let debugTotalStatMs = 0;

function recordDebugStat(startedAt: number) {
  const statMs = performance.now() - startedAt;
  debugStatCount += 1;
  debugTotalStatMs += statMs;
  return { statCount: debugStatCount, statMs, totalStatMs: debugTotalStatMs };
}

/**
 * Return `true` when the sidecar for `sessionId` can be ruled out of a time
 * window whose oldest allowed millisecond timestamp is `cutoffMs`.
 *
 * Returns `false` (do NOT skip) whenever:
 *   - The id contains a path separator (not a sidecar filename stem).
 *   - The sidecar mtime is >= `cutoffMs` (session may be in-window).
 *   - The stat call fails for any reason (safe fallback: let the caller decide).
 *
 * @param sessionId  The session identifier (sidecar filename stem).
 * @param sessionsDir  Directory that contains `<sessionId>.json` sidecars.
 * @param cutoffMs  Epoch-ms lower bound for the aggregation window.
 */
export function sidecarPredatesWindow(
  sessionId: string,
  sessionsDir: string,
  cutoffMs: number,
): boolean {
  // Reject both separator styles, even when running on a different platform.
  if (sessionId.includes('/') || sessionId.includes('\\')) return false;

  const debug = isDebugEnabled();
  const startedAt = debug ? performance.now() : 0;
  try {
    const mtime = statSync(join(sessionsDir, `${sessionId}.json`)).mtimeMs;
    const timing = debug ? recordDebugStat(startedAt) : undefined;
    const skip = mtime < cutoffMs;
    if (debug && skip) {
      debugLog('[session-prescreen] skip', {
        sessionId, mtimeMs: mtime, cutoffMs, deltaMs: mtime - cutoffMs, ...timing,
      });
    }
    return skip;
  } catch (error) {
    // Can't stat (missing, permission error, …) — let the caller proceed so the
    // subsequent `getOrDeriveFacet` call can handle it in the normal way.
    if (debug) {
      debugLog('[session-prescreen] stat failed; falling back', {
        sessionId, error, ...recordDebugStat(startedAt),
      });
    }
    return false;
  }
}

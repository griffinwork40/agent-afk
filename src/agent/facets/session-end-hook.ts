/**
 * SessionEnd hook that derives and caches a facet for the completed session,
 * then enriches it with session yield tracking data (#2016).
 *
 * Facets are structured summaries of a session's tool usage, outcomes, and
 * metadata. Before this hook, facets were only derived on-demand when a
 * plugin (e.g. harvest) explicitly requested one — so only ~5% of sessions
 * had facets. This hook ensures every top-level session gets a facet
 * automatically at teardown.
 *
 * Yield tracking enrichment runs after the base facet is written: the hook
 * probes the current git branch and queries `gh pr list` to determine whether
 * the session produced a PR and whether that PR is merged. This is a best-
 * effort async operation — failures are swallowed and the facet is left with
 * null values for `produced_pr` and `pr_merged` rather than blocking teardown.
 *
 * Scheduled sessions (source === 'daemon') are tagged `is_scheduled_session:
 * true` so callers can exclude them from the yield denominator.
 *
 * Contract:
 * - Skips subagent sessions (parentSessionId present) — only top-level
 *   sessions produce harvestable facets.
 * - Best-effort: derivation failures never block session teardown.
 * - The facet is written to the cache dir (getFacetCacheDir()) via the
 *   existing atomic write-through in getOrDeriveFacet.
 *
 * @module agent/facets/session-end-hook
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HookHandler } from '../hooks.js';
import { getOrDeriveFacet } from './store.js';
import { writeFacetYield } from './yield-probe.js';
import { isSubagentContext } from '../hooks/hook-utils.js';

const execFileAsync = promisify(execFile);

export function createFacetSessionEndHook(): HookHandler {
  return (context) => {
    if (context.event !== 'SessionEnd') return {};
    // Subagent guard: forked children inherit the parent's hook registry,
    // so their teardown fires this too. Skip — subagent sessions are worker
    // details, not standalone harvestable units.
    if (isSubagentContext(context)) return {};

    const sessionId = context.sessionId;
    if (!sessionId) return {};

    // Phase 1: derive + cache the base facet synchronously.
    let facet;
    try {
      facet = getOrDeriveFacet(sessionId);
    } catch {
      // Best-effort: derivation failures (corrupt session JSON, schema
      // mismatch) must never block teardown.
    }

    if (!facet) return {};

    // Phase 2: enrich yield fields asynchronously — never blocks teardown.
    // Scheduled sessions have is_scheduled_session=true already (set by derive);
    // we still probe them so the facet records produced_pr/pr_merged for
    // audit purposes, even though they are excluded from the yield denominator.
    // Read cwd from context so git/gh run against the session's repo, not
    // process.cwd() (which is the daemon launch dir in unattended runs).
    const cwd = context.cwd;
    void writeFacetYield(sessionId, execFileAsync, cwd).catch(() => {
      // Swallow: gh/git failures are normal in offline or non-repo contexts.
    });

    return {};
  };
}

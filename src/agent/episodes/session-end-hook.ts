/**
 * Session-end hook for automatic episode synthesis.
 *
 * Fires at SessionEnd for top-level (non-subagent) sessions when
 * AFK_EPISODE_SYNTHESIS=1. Builds a deterministic episode from the
 * session facet (no LLM call). Runs in the background lane and never
 * propagates errors into teardown.
 *
 * Hook ordering / async race (constraint 3, #4661):
 * The facet session-end hook runs Phase 1 (derive) synchronously but
 * Phase 2 (yield enrichment: `produced_pr`, `pr_merged`) is fire-and-forget
 * async. If this hook reads the facet immediately it will see
 * `produced_pr: null` for sessions that produced PRs.
 *
 * Fix: before building the episode we explicitly await the yield probe so
 * the facet cache is fully enriched before `buildEpisodeFromFacet` reads it.
 * The probe is best-effort — errors are swallowed and synthesis proceeds with
 * whatever data is available.
 *
 * History: the original hook (PR #4565) called Haiku for narrative
 * synthesis and backflowed LLM-derived decisions into the facet cache
 * (#4569). The facet-bridge rewrite reads decisions FROM the facet, so
 * backflow is no longer needed.
 *
 * @module agent/episodes/session-end-hook
 */

import type { HookHandler } from '../hooks.js';
import { isSubagentContext } from '../hooks/hook-utils.js';
import { env } from '../../config/env.js';
import { synthesizeAndWriteEpisode } from './index.js';
import { writeFacetYield } from '../facets/yield-probe.js';
import { execFileAsync } from '../../utils/exec-file.js';

export function createEpisodeSessionEndHook(): HookHandler {
  return async (context) => {
    if (context.event !== 'SessionEnd') return {};
    if (isSubagentContext(context)) return {};

    // Gate: only fire when explicitly opted in
    if (env.AFK_EPISODE_SYNTHESIS !== '1') return {};

    const sessionId = context.sessionId;
    if (!sessionId) return {};

    // Contract (#4661, constraint 3): await yield enrichment before reading the
    // facet. The facet hook's Phase 2 (writeFacetYield) is fire-and-forget, so
    // the cached facet may still have produced_pr=null when this hook fires.
    // We re-run the probe here to ensure the facet is fully enriched before
    // buildEpisodeFromFacet reads it. Best-effort: errors are swallowed and
    // synthesis proceeds with whatever data is available.
    const cwd = context.cwd;
    try {
      await writeFacetYield(sessionId, execFileAsync, cwd);
    } catch {
      // Swallow — offline / non-repo environments are normal; episode
      // synthesis must proceed regardless of yield-probe failures.
    }

    // Await synthesis so the background lane (drainBackground) tracks it
    // before fast-shutdown paths (Telegram bot.stop() → process.exit()) fire.
    // Errors are swallowed — episode synthesis is additive, never critical.
    try {
      await synthesizeAndWriteEpisode(sessionId);
    } catch {
      // Swallow all errors — episode synthesis is additive, never critical
    }

    return {};
  };
}

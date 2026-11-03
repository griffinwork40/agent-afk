/**
 * Session-end hook for automatic episode synthesis.
 *
 * Fires at SessionEnd for top-level (non-subagent) sessions when
 * AFK_EPISODE_SYNTHESIS=1. Builds a deterministic episode from the
 * session facet (no LLM call). Runs in the background lane and never
 * propagates errors into teardown.
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
import { patchFacetDecisions } from '../facets/yield-probe.js';

export function createEpisodeSessionEndHook(): HookHandler {
  return async (context) => {
    if (context.event !== 'SessionEnd') return {};
    if (isSubagentContext(context)) return {};

    // Gate: only fire when explicitly opted in
    if (env.AFK_EPISODE_SYNTHESIS !== '1') return {};

    const sessionId = context.sessionId;
    if (!sessionId) return {};

    // Await synthesis so the background lane (drainBackground) tracks it
    // before fast-shutdown paths (Telegram bot.stop() → process.exit()) fire.
    // Errors are swallowed — episode synthesis is additive, never critical.
    try {
      const episode = await synthesizeAndWriteEpisode(sessionId);
      // Backflow: patch synthesized decisions into the cached facet so
      // get_facet readers see them without a full re-derive (#4569).
      if (episode?.decisions && episode.decisions.length > 0) {
        patchFacetDecisions(sessionId, episode.decisions);
      }
    } catch {
      // Swallow all errors — episode synthesis is additive, never critical
    }

    return {};
  };
}

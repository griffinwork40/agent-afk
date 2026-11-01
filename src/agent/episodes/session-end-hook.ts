/**
 * Session-end hook for automatic episode synthesis.
 *
 * Fires at SessionEnd for top-level (non-subagent) sessions when
 * AFK_EPISODE_SYNTHESIS=1. Runs in the background lane (fire-and-forget)
 * and never propagates errors into teardown.
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
      // Backflow: patch the cached facet with LLM-synthesized decisions (#4569).
      // patchFacetDecisions no-ops when decisions is empty (fallback path) or
      // the facet cache file is absent — always safe to call.
      patchFacetDecisions(sessionId, episode.decisions);
    } catch {
      // Swallow all errors — episode synthesis is additive, never critical
    }

    return {};
  };
}

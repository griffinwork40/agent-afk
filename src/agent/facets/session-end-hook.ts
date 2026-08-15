/**
 * SessionEnd hook that derives and caches a facet for the completed session.
 *
 * Facets are structured summaries of a session's tool usage, outcomes, and
 * metadata. Before this hook, facets were only derived on-demand when a
 * plugin (e.g. harvest) explicitly requested one — so only ~5% of sessions
 * had facets. This hook ensures every top-level session gets a facet
 * automatically at teardown.
 *
 * Contract:
 * - Skips subagent sessions (parentSessionId present) — only top-level
 *   sessions produce harvestable facets.
 * - Best-effort: a derivation failure never blocks session teardown.
 * - The facet is written to the cache dir (getFacetCacheDir()) via the
 *   existing atomic write-through in getOrDeriveFacet.
 *
 * @module agent/facets/session-end-hook
 */

import type { HookHandler } from '../hooks.js';
import { getOrDeriveFacet } from './store.js';

export function createFacetSessionEndHook(): HookHandler {
  return (context) => {
    if (context.event !== 'SessionEnd') return {};
    // Subagent guard: forked children inherit the parent's hook registry,
    // so their teardown fires this too. Skip — subagent sessions are worker
    // details, not standalone harvestable units.
    if (context.parentSessionId) return {};

    const sessionId = context.sessionId;
    if (!sessionId) return {};

    try {
      getOrDeriveFacet(sessionId);
    } catch {
      // Best-effort: derivation failures (corrupt session JSON, schema
      // mismatch) must never block teardown. The session sidecar is still
      // on disk — a future getOrDeriveFacet call (or a FACET_VERSION bump
      // that fixes the schema) will succeed.
    }

    return {};
  };
}

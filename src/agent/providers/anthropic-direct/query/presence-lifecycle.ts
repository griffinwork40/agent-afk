/**
 * Re-export shim — the canonical implementation has moved to
 * `../../shared/presence-lifecycle.ts` so the openai-compatible provider can
 * share it instead of hand-duplicating the gate (which is how the two copies
 * drifted apart in the first place).
 *
 * This file is kept so existing imports of
 * `./query/presence-lifecycle.js` continue to resolve without modification.
 *
 * @module agent/providers/anthropic-direct/query/presence-lifecycle
 */

export {
  isTopLevelSession,
  registerPresenceLifecycle,
  resolveTopLevelSessionId,
  type PresenceLifecycleArgs,
  type SessionIdResolution,
  type SessionIdResolutionArgs,
} from '../../shared/presence-lifecycle.js';

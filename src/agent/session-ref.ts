import type { AgentSession } from './session.js';

/**
 * Mutable indirection around an active `AgentSession`. Consumers read the
 * current session through `ref.current` at call time, never capturing the
 * value. Owners (bootstrap, mid-session resume) mutate `ref.current` to
 * swap sessions atomically.
 *
 * Box-not-value: holding the ref keeps callers correct across swaps; holding
 * the value silently goes stale.
 */
export interface SessionRef {
  current: AgentSession;
}

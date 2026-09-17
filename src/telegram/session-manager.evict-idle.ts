/**
 * Idle-session eviction for Telegram SessionManager.
 *
 * Invariant: when a user simply stops chatting, `getSession()` has already
 * inserted the IAgentSession into `sessions`, and no turn-completion path
 * removes it — only explicit teardown (/clear, model switch, /cd) and
 * `closeAll()` at shutdown do. This means `_evictStaleSessionData`'s
 * `sessions.has(key)` guard skips exactly the sessions it should clean up
 * during long uptime (#1662, Codex review on #1700).
 *
 * This module closes and removes idle sessions from the live `sessions` map
 * so the downstream `sessionData` eviction pass — and its elicitation-route
 * cleanup — can actually fire for sessions that ran to natural completion.
 *
 * @module telegram/session-manager.evict-idle
 */

import type { IAgentSession } from '../agent/types.js';
import type { SessionData } from './session-manager.js';
import { clearElicitationRoute } from './elicitation-route-registry.js';
import type { SessionStats } from '../cli/slash/types.js';

/**
 * Close and remove sessions from the live `sessions` map whose matching
 * `sessionData` entry has had no activity for longer than `maxAgeMs`.
 *
 * A session is eligible for idle eviction when:
 * 1. It exists in `sessions` (i.e. it has a live IAgentSession object).
 * 2. It has a `sessionData` entry whose `lastActivity` is older than `maxAgeMs`.
 * 3. Its state is `'idle'` — never evict a session mid-turn.
 *
 * Closing is best-effort: a throwing `close()` logs and continues so one bad
 * session never blocks eviction of the rest.
 */
export async function evictIdleSessions(
  sessions: Map<string, IAgentSession>,
  sessionData: Map<string, SessionData>,
  maxAgeMs: number,
): Promise<number> {
  const now = Date.now();
  let evicted = 0;
  for (const [key, session] of sessions) {
    const data = sessionData.get(key);
    // No sessionData → can't judge staleness; skip.
    if (!data) continue;
    // Still active → skip.
    if (now - new Date(data.lastActivity).getTime() <= maxAgeMs) continue;
    // Mid-turn → skip. Only evict idle sessions.
    if (session.state !== 'idle') continue;

    try { await session.close(); } catch (err) {
      console.error('[session-manager] idle-evict close error for', key, err);
    }
    sessions.delete(key);
    evicted++;
  }
  return evicted;
}

/**
 * Resolve the sessionId for a route key and clear its elicitation mapping.
 * Checks both sessionStats and sessionData since a route can be registered
 * through either path.
 */
export function clearElicitationRouteForKey(
  key: string,
  sessionStats: Map<string, SessionStats>,
  sessionData: Map<string, SessionData>,
): void {
  const sid = sessionStats.get(key)?.sessionId ?? sessionData.get(key)?.sessionId;
  if (sid) clearElicitationRoute(sid);
}

/**
 * Evict sessionData entries whose lastActivity exceeds `maxAgeMs` and that
 * have no live session in the `sessions` map. Clears the elicitation-route
 * registry entry for each evicted key before deleting its data (#1662).
 */
export function evictStaleSessionData(
  sessions: Map<string, IAgentSession>,
  sessionData: Map<string, SessionData>,
  sessionStats: Map<string, SessionStats>,
  maxAgeMs: number,
): void {
  const now = Date.now();
  for (const [key, data] of sessionData) {
    if (sessions.has(key)) continue; // live session -- never evict
    if (now - new Date(data.lastActivity).getTime() > maxAgeMs) {
      clearElicitationRouteForKey(key, sessionStats, sessionData);
      sessionData.delete(key);
    }
  }
}

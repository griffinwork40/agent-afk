/**
 * Post-restart stats hydration for Telegram's SessionManager.
 *
 * Extracted from session-manager.ts to stay under the 350-line code ceiling.
 * This module owns ONE concern: given the in-memory maps and a route, hydrate
 * the per-route SessionStats from the shared persisted sidecar when the bot
 * restarts and loses in-memory state.
 *
 * All functions are pure helpers that take explicit parameters — no closure
 * over enclosing SessionManager locals.
 *
 * @module telegram/session-manager.hydrate-stats
 */

import { loadSession, saveSession } from '../cli/session-store.js';
import type { SessionStats } from '../cli/slash/types.js';
import { type TelegramRoute, routeKey } from './route.js';
import type { SessionData } from './session-manager.js';

/**
 * Hydrate in-memory stats from the persisted sidecar for a chat whose
 * sessionId survived a bot restart in `sessionData` but whose `sessionStats`
 * entry was lost (sessionStats is in-memory-only and starts empty on restart).
 *
 * Guards:
 * - No-op when stats already exist in memory (never clobber live state).
 * - No-op when sessionData carries no sessionId (nothing to hydrate from).
 * - No-op when the sidecar cannot be loaded (missing / corrupted file).
 * - No-op when the sidecar is not a telegram sidecar for THIS chat (source
 *   guard prevents accidentally adopting a CLI sidecar that happens to share
 *   a sessionId).
 *
 * After hydration, setSessionName and recordTelegramTurn both see the full
 * prior-conversation stats (sessionId, turns, totals), so a rename persists
 * in-place without forking a duplicate sidecar and turn counts are preserved.
 *
 * Contract: `sessionStats.set(key, stats)` is performed inside this helper
 * so callers observe the mutation via their shared Map reference. The helper
 * is idempotent — calling it twice for the same route is safe.
 *
 * @param sessionStats - The SessionManager's live per-route stats map (mutated in place)
 * @param sessionData  - The SessionManager's live per-route data map (read-only)
 * @param route        - The route to hydrate stats for
 */
export function hydrateStatsFromStore(
  sessionStats: Map<string, SessionStats>,
  sessionData: Map<string, SessionData>,
  route: TelegramRoute,
): void {
  const key = routeKey(route);
  // Never clobber live in-memory stats — this is a post-restart-only repair.
  if (sessionStats.has(key)) return;

  const sessionId = sessionData.get(key)?.sessionId;
  if (!sessionId) return;

  const stored = loadSession(sessionId);
  if (!stored) return;

  // Only hydrate telegram sidecars that belong to THIS chat — prevent
  // accidentally adopting a CLI sidecar or a different chat's sidecar. The
  // per-route sidecar is keyed by SDK sessionId, so a topic can only hydrate
  // its own conversation (each topic's session has a distinct sessionId).
  if (stored.source !== 'telegram' || stored.telegramChatId !== route.chatId) return;

  // Map StoredSession → SessionStats.
  // Critical rename: stored.startedAt === SessionStats.sessionStartTime.
  // Fields not persisted (turnCosts, turnTokens, permissionMode) are
  // reconstructed as empty/default — they are runtime-only display helpers,
  // not resumption data. The round-trip contract is: saveSession(hydrated) === the original
  // sidecar (modulo savedAt timestamp), so a post-hydration persist does NOT
  // fork a new file.
  const stats: SessionStats = {
    sessionId: stored.sessionId,
    name: stored.name,
    model: stored.model,
    source: stored.source,
    telegramChatId: stored.telegramChatId,
    sessionStartTime: stored.startedAt,
    totalTurns: stored.totalTurns,
    totalCostUsd: stored.totalCostUsd,
    unpricedTurns: stored.unpricedTurns ?? 0,
    totalTokens: stored.totalTokens,
    totalDurationMs: stored.totalDurationMs,
    turns: stored.turns,
    // Runtime-only fields — reconstructed as empty defaults.
    turnCosts: [],
    turnTokens: [],
    permissionMode: 'default',
  };
  // Carry forward the per-route cwd override if one was set via /cd.
  const chatCwd = sessionData.get(key)?.cwd;
  if (chatCwd !== undefined) stats.cwd = chatCwd;
  sessionStats.set(key, stats);
}

/**
 * Return the SDK session id for a chat route, or undefined when no model turn
 * has completed yet. Reads from in-memory stats first; falls back to the live
 * IAgentSession for the route. Used by feedback handlers (/good, /bad) to key
 * the outcome record.
 *
 * @param sessionStats - The SessionManager's live per-route stats map
 * @param sessions     - The SessionManager's live per-route IAgentSession map
 * @param route        - The route to look up the session id for
 */
export function getRouteSessionId(
  sessionStats: Map<string, SessionStats>,
  sessions: Map<string, { sessionId?: string }>,
  route: TelegramRoute,
): string | undefined {
  const key = routeKey(route);
  const fromStats = sessionStats.get(key)?.sessionId;
  if (fromStats) return fromStats;
  return sessions.get(key)?.sessionId;
}

/**
 * Return the human-readable session name for a chat route, or undefined.
 * Mirrors getRouteSessionId — plain stats-map lookup that the SessionManager
 * method delegates to after running _hydrateStatsFromStore.
 */
export function getRouteSessionName(
  sessionStats: Map<string, SessionStats>,
  route: TelegramRoute,
): string | undefined {
  return sessionStats.get(routeKey(route))?.name;
}

/**
 * Persist the session name for a chat route when the session has enough state
 * to write to disk (totalTurns > 0 and sessionId known). Captures the live
 * session's id into stats and sessionData before saving. Extracted from
 * SessionManager.setSessionName to keep session-manager.ts under the ceiling.
 *
 * @param sessionStats  - Per-route stats map (mutated: sessionId captured)
 * @param sessionData   - Per-route session data map (mutated: sessionId mirrored)
 * @param sessions      - Per-route live session map (read-only)
 * @param route         - Route to persist the name for
 * @param slug          - Already-slugified session name
 * @returns `{ persisted: true }` when written to disk now, `{ persisted: false }` when deferred.
 */
export function persistSessionName(
  sessionStats: Map<string, SessionStats>,
  sessionData: Map<string, SessionData>,
  sessions: Map<string, { sessionId?: string }>,
  route: TelegramRoute,
  slug: string,
): { persisted: boolean } {
  const key = routeKey(route);
  const stats = sessionStats.get(key);
  if (!stats) return { persisted: false };
  stats.name = slug;

  // Capture the live session's id if the stats don't carry one yet.
  const live = sessions.get(key);
  if (!stats.sessionId && live?.sessionId) stats.sessionId = live.sessionId;

  if (stats.totalTurns > 0 && stats.sessionId) {
    const data = sessionData.get(key);
    if (data) data.sessionId = stats.sessionId;
    saveSession(stats);
    return { persisted: true };
  }
  return { persisted: false };
}

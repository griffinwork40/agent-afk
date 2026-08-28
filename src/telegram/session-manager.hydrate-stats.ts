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

import { loadSession } from '../cli/session-store.js';
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

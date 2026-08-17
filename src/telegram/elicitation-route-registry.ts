/**
 * In-memory registry that maps SDK session IDs to their Telegram route.
 *
 * When the elicitation handler fires, it needs to know WHICH topic/chat the
 * originating session belongs to. The registry is the sole bridge between
 * session identity (SDK sessionId, available when ask_question fires) and
 * routing identity (TelegramRoute, owned by SessionManager).
 *
 * Lifecycle:
 *   - `set` — called by SessionManager when a sessionId becomes known
 *     (captured from the first turn's metadata or from live IAgentSession).
 *   - `get` — called by makeTelegramElicitationHandler to resolve the route
 *     for the currently-eliciting session, so the prompt lands in the right
 *     topic thread instead of always going to General.
 *   - `clear` — called by SessionManager when a session is torn down
 *     (/clear, model switch, /cd) to prevent stale route lookups.
 *
 * Intentionally module-scope (singleton). Multiple bot instances in the same
 * process are unsupported by design (each bot process manages one Telegram
 * bot), so a single Map is safe and avoids threading the registry through
 * every constructor.
 *
 * @module telegram/elicitation-route-registry
 */

import type { TelegramRoute } from './route.js';

const registry = new Map<string, TelegramRoute>();

/**
 * Register a sessionId → route mapping.
 * Idempotent: a second call for the same sessionId overwrites the route,
 * which is the correct behaviour when a session's route changes (e.g. a
 * /cd that rebuilds the session with a new route key).
 */
export function setElicitationRoute(sessionId: string, route: TelegramRoute): void {
  registry.set(sessionId, route);
}

/**
 * Look up the TelegramRoute for a given SDK sessionId.
 * Returns undefined when the sessionId is unknown — callers should fall back
 * to the primary chatId (General topic) in that case.
 */
export function getElicitationRoute(sessionId: string): TelegramRoute | undefined {
  return registry.get(sessionId);
}

/**
 * Remove the route mapping for a sessionId.
 * Called when the underlying AgentSession is torn down so no stale entry
 * can misdirect a future session that happens to reuse the same id.
 */
export function clearElicitationRoute(sessionId: string): void {
  registry.delete(sessionId);
}

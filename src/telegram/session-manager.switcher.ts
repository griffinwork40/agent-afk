/**
 * Session-switcher helpers extracted from SessionManager.
 *
 * Covers the `/sessions`, `/switch`, and `/new` command concerns:
 * listing a chat's resumable conversations, switching between them, and
 * opening a fresh conversation while keeping prior ones resumable.
 *
 * Invariant: all state mutations go through explicit parameters so this module
 * is stateless and testable in isolation. SessionManager delegates via these
 * functions; its public surface is unchanged.
 *
 * @module telegram/session-manager.switcher
 */

import type { IAgentSession } from '../agent/types.js';
import { loadSession, listSessions } from '../cli/session-store.js';
import { type TelegramRoute, routeKey } from './route.js';
import { clearElicitationRouteForKey } from './session-manager.evict-idle.js';
import type { SessionData, ChatSessionInfo, RouteTarget } from './session-manager.js';
import type { SessionStats } from '../cli/slash/types.js';

/** Normalise a RouteTarget to a full route. A bare number is the General topic. */
function toRoute(target: RouteTarget): TelegramRoute {
  return typeof target === 'number' ? { chatId: target } : target;
}

/**
 * List a chat's resumable conversations for the `/sessions` switcher,
 * newest-active first. Sourced from the shared sidecar store (telegram
 * sidecars for this chatId) -- the durable record of every conversation the
 * chat has held -- with the route's currently-active one flagged.
 *
 * Provenance is the chatId, so this lists every conversation the chat has
 * held (across General and any topics). The `active` flag reflects the
 * requesting route's own live session id -- the conversation the switcher
 * would replace on that route.
 *
 * A brand-new conversation with no recorded turn yet has no sidecar and so
 * does not appear until its first turn is saved.
 */
export function listChatSessionsImpl(
  target: RouteTarget,
  sessionData: Map<string, SessionData>,
): ChatSessionInfo[] {
  const route = toRoute(target);
  const activeId = sessionData.get(routeKey(route))?.sessionId;
  return listSessions()
    .filter(
      (s) => s.source === 'telegram' && s.telegramChatId === route.chatId && s.sessionId !== undefined,
    )
    .map((s) => {
      const info: ChatSessionInfo = {
        sessionId: s.sessionId as string,
        model: s.model,
        turns: s.totalTurns,
        lastActive: s.savedAt,
        active: s.sessionId === activeId,
      };
      if (s.name !== undefined) info.name = s.name;
      return info;
    })
    .sort((a, b) => b.lastActive - a.lastActive);
}

/** Context maps passed by reference from SessionManager. */
export interface SwitcherContext {
  sessions: Map<string, IAgentSession>;
  pendingSessions: Map<string, Promise<IAgentSession>>;
  sessionData: Map<string, SessionData>;
  sessionStats: Map<string, SessionStats>;
  autosaveFailureLogged: Set<string>;
  pendingResume: Map<string, string>;
  newData(route: TelegramRoute): SessionData;
}

/**
 * Switch the chat's active conversation to a previously-persisted session
 * (the `/switch` command). Closes the current live session -- its sidecar is
 * already persisted per-turn, so it stays resumable -- drops in-memory stats so
 * the target's name/turns re-hydrate from its sidecar, adopts the target's
 * model + cwd, and stages the SDK session id for resume. The next
 * getSession(chatId) rebuilds the session with `config.resume` so it continues
 * the chosen conversation; callers wanting it warmed can await getSession after.
 *
 * @returns `{ ok: true }` on success; `{ ok: false, reason }` when the target
 *   is missing / not a telegram sidecar for this chat, or already active.
 */
export async function switchToSessionImpl(
  target: RouteTarget,
  targetSessionId: string,
  sc: SwitcherContext,
): Promise<{ ok: true; name?: string } | { ok: false; reason: 'not-found' | 'already-active' }> {
  const route = toRoute(target);
  const key = routeKey(route);

  // If a session creation is in flight for this route, let it settle before we
  // inspect and close the live session. Otherwise the in-flight promise sets
  // the pre-switch session as live AFTER we adopt the target below, silently
  // reverting the switch. Awaiting materializes it so the close path evicts it
  // normally; a failed creation leaves sessions empty, which the `old` guard handles.
  const inflight = sc.pendingSessions.get(key);
  if (inflight !== undefined) {
    await inflight.catch(() => undefined);
  }

  // Already the live active conversation -- no-op (avoid a needless rebuild).
  if (sc.sessions.has(key) && sc.sessionData.get(key)?.sessionId === targetSessionId) {
    return { ok: false, reason: 'already-active' };
  }

  const stored = loadSession(targetSessionId);
  if (!stored || stored.source !== 'telegram' || stored.telegramChatId !== route.chatId) {
    return { ok: false, reason: 'not-found' };
  }

  // Close the current live session (sidecar already persisted per-turn).
  const old = sc.sessions.get(key);
  if (old) {
    // Guard the close: a throwing close() must never block the delete + target-state
    // adoption below, or the stale session stays keyed in sessions and the next
    // getSession returns it unrebuilt.
    await old.close().catch((err) => console.error('Error closing session on switch:', err));
    sc.sessions.delete(key);
  }
  // Drop in-memory stats so the resumed session hydrates the TARGET's stats
  // (name/turns/sessionId) from its sidecar on next access -- never the
  // previous conversation's. autosave-failure notice re-arms for the switch.
  clearElicitationRouteForKey(key, sc.sessionStats, sc.sessionData); // clear before dropping stats (#1662)
  sc.sessionStats.delete(key);
  sc.autosaveFailureLogged.delete(key);

  // Adopt the target's identity + model/cwd and stage the resume.
  let data = sc.sessionData.get(key);
  if (!data) {
    data = sc.newData(route);
    data.model = stored.model;
    sc.sessionData.set(key, data);
  } else {
    data.model = stored.model;
    data.lastActivity = new Date().toISOString();
  }
  data.sessionId = targetSessionId;
  // Adopt the target's cwd, or CLEAR a stale per-chat override when the target
  // has none -- otherwise the resumed session runs + autosaves under the
  // previously-active conversation's directory (getSession uses data.cwd ?? botCwd).
  if (stored.cwd !== undefined) data.cwd = stored.cwd;
  else delete data.cwd;
  sc.pendingResume.set(key, targetSessionId);
  return stored.name !== undefined ? { ok: true, name: stored.name } : { ok: true };
}

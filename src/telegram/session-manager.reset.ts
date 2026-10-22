/**
 * Chat-level identity bookkeeping around the shared reset-in-place `/clear`.
 *
 * Contract: the shared session-control `clearConversation` resets the live
 * AgentSession in place. On Telegram the session object, its bg-injection and
 * notifier route keys, and its cwd survive the reset; the conversation id,
 * name, stats and any staged resume do not. `beginConversationResetImpl` runs
 * before the reset (it reads the OLD session id to retire its elicitation
 * route and registry handle); `finishConversationResetImpl` runs after it and
 * re-points the persisted identity at the NEW id, so a bot restart never
 * resumes the cleared conversation.
 *
 * Also holds the replace-the-session reset (`resetSessionImpl`). Extracted from
 * session-manager.ts (350-code-line ceiling); the SessionManager methods
 * `beginConversationReset` / `finishConversationReset` / `resetSession` delegate here
 * with explicit state, following the other session-manager.* siblings.
 */

import type { IAgentSession } from '../agent/types.js';
import type { SessionStats } from '../cli/slash/types.js';
import type { SessionRegistry } from '../agent/session/session-registry.js';
import { setElicitationRoute } from './elicitation-route-registry.js';
import { type TelegramRoute, routeKey } from './route.js';
import { archiveRegistryHandle } from './session-manager.registry.js';
import { clearElicitationRouteForKey } from './session-manager.evict-idle.js';
import type { SessionData } from './session-manager.js';

export interface BeginResetDeps {
  sessionStats: Map<string, SessionStats>;
  sessionData: Map<string, SessionData>;
  pendingResume: Map<string, string>;
  autosaveFailureLogged: Set<string>;
  registry: SessionRegistry;
}

export function beginConversationResetImpl(key: string, deps: BeginResetDeps): void {
  clearElicitationRouteForKey(key, deps.sessionStats, deps.sessionData);
  try {
    archiveRegistryHandle(deps.registry, key);
  } catch {
    // Best-effort: a stale registry handle is cosmetic and must not block /clear.
  }
  deps.pendingResume.delete(key);
  deps.autosaveFailureLogged.delete(key);
}

export interface FinishResetDeps {
  sessionData: Map<string, SessionData>;
  sessions: Map<string, IAgentSession>;
  ensureRegistryHandle: (route: TelegramRoute, data: SessionData) => void;
}

export function finishConversationResetImpl(route: TelegramRoute, deps: FinishResetDeps): void {
  const key = routeKey(route);
  const data = deps.sessionData.get(key);
  // The reset session may not have minted its provider id yet (it does on the
  // first turn); in that case drop the stale id rather than keep the old one.
  const sid = deps.sessions.get(key)?.sessionId;
  if (data) {
    if (sid) {
      data.sessionId = sid;
    } else {
      delete data.sessionId;
    }
    data.lastActivity = new Date().toISOString();
  }
  if (sid) setElicitationRoute(sid, route);
  if (data) {
    try {
      deps.ensureRegistryHandle(route, data);
    } catch {
      // Non-fatal: the handle is re-ensured on the next turn.
    }
  }
}

export interface ReplaceResetDeps {
  registry: SessionRegistry;
  sessions: Map<string, IAgentSession>;
  sessionData: Map<string, SessionData>;
  resetStats: (key: string) => void;
}

/**
 * The replace-the-session reset: close the live session so the next request
 * builds a fresh one. Used by Telegram's own lifecycle paths and as the
 * fallback when the reset-in-place /clear leaves the session closed.
 */
export async function resetSessionImpl(key: string, deps: ReplaceResetDeps): Promise<void> {
  // Archive the registry handle FIRST so the stale handle is freed before
  // resetStats clears the sessionId. Best-effort: non-fatal if never registered.
  try {
    archiveRegistryHandle(deps.registry, key);
  } catch {
    // best-effort
  }
  const oldSession = deps.sessions.get(key);
  if (oldSession) {
    await oldSession.close();
    deps.sessions.delete(key);
  }
  // New conversation: drop accumulated stats and the stale sessionId so the
  // rebuilt session is recorded as a fresh sidecar, not appended to the old.
  deps.resetStats(key);
  // Keep session data; a new session is created on the next request.
  const data = deps.sessionData.get(key);
  if (data) data.lastActivity = new Date().toISOString();
}

/**
 * Session registry wiring for Telegram's SessionManager.
 *
 * Extracted from session-manager.ts to stay under the 350-line ceiling.
 * These are pure functions that operate on a provided SessionRegistry — no
 * module-level singleton access. The SessionManager resolves `registry ??
 * sessionRegistry` and passes the resolved ref here.
 *
 * @module telegram/session-manager.registry
 */

import type { SessionRegistry } from '../agent/session/session-registry.js';
import { asHandleId } from '../agent/session/session-registry.js';
import type { AgentModelInput } from '../agent/types.js';
import { type TelegramRoute, routeKey } from './route.js';
import type { SessionData } from './session-manager.js';

/**
 * Create or resolve a session registry handle for a route. Idempotent.
 * Uses routeKey as HandleId for backward compatibility (Step 3); a future
 * step migrates to UUID-based ids for full cross-surface identity.
 *
 * Three code paths:
 *  1. `resolve()` finds an active handle → `touch()` + optional `attachSdkSessionId`.
 *  2. `get(id)` finds an active handle by id → `bind()` + optional `attachSdkSessionId`.
 *  3. Neither → `create()` a fresh handle.
 *
 * Archived handles are never reused — their bindings were freed by `archive()`,
 * so a fresh handle is needed for the new conversation.
 */
export function ensureRegistryHandle(
  reg: SessionRegistry,
  route: TelegramRoute,
  data: SessionData,
  defaultModel: AgentModelInput,
): void {
  const key = routeKey(route);
  const id = asHandleId(key);
  const existing = reg.resolve('telegram', key);
  if (existing) {
    reg.touch(existing.id);
    if (data.sessionId) reg.attachSdkSessionId(existing.id, data.sessionId);
    return;
  }
  // Singleton registry may hold the id from a prior conversation. get() checks
  // by id — only re-bind if the handle is still ACTIVE (archived handles must
  // not be reused; their bindings were freed by archive() so a fresh handle is
  // needed for the new conversation).
  const byId = reg.get(id);
  if (byId && byId.status === 'active') {
    reg.bind(id, { surface: 'telegram', key });
    if (data.sessionId) reg.attachSdkSessionId(id, data.sessionId);
    return;
  }
  // Use data.model when present; fall back to the configured default so that
  // legacy sidecars with model: undefined don't violate SessionHandle.model.
  // Do NOT pass an explicit id when the prior handle was archived — the routeKey
  // id is already taken; let the registry mint a fresh UUID instead.
  const createId = byId === undefined ? id : undefined;
  reg.create({ surface: 'telegram', key, model: data.model ?? defaultModel, id: createId, sdkSessionId: data.sessionId });
}

/**
 * Archive a registry handle by routeKey. Best-effort: swallows errors for
 * handles that were never registered (e.g. sessions created before registry
 * wiring landed). Called by `resetSession` and `switchModel` before teardown.
 */
export function archiveRegistryHandle(reg: SessionRegistry, key: string): void {
  reg.archive(asHandleId(key));
}

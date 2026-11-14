/**
 * Session-identity continuity across inner rebuilds for {@link ProviderRouter}.
 *
 * Problem: a rebuilt inner (fallback swap, or a `/model` swap onto a different
 * routing signature) is a provider query whose id comes ONLY from its config
 * (`sessionId` / `resume`) or its provider instance's memoized mint. No inner
 * reads `ProviderUserTurn.sessionId` from its prompt stream, so the router's
 * `lastSessionId` never reaches it. A fresh instance (any cross-family swap,
 * or any swap when the router resolves providers unmemoized, e.g. the SDK
 * `query()` path) mints a NEW id, and its first `assistant.message` re-stamps
 * the session's id (stream-consumer `updateSessionIdentity`) while the message
 * journal stays under the original id.
 *
 * Fix here, not by handing the id to the inner's config: an explicit config
 * `sessionId` makes `resolveTopLevelSessionId` advertise presence regardless of
 * surface. Instead the router rewrites the `sessionId` of every event it
 * forwards to the id the session already holds (the outer turn's `sessionId`).
 * Before any rebuild the two ids are equal, so this is a no-op.
 *
 * Known limit: the rebuilt inner still uses its own id INTERNALLY (request
 * headers, tool attribution, its own presence record). Only the id the session
 * observes is pinned.
 *
 * @module agent/providers/router/provider-router.identity
 */

import type { ProviderEvent } from '../../provider.js';

/**
 * Return `ev` with its `sessionId` replaced by `sessionId` when it carries a
 * different one. Never mutates `ev`; events without a `sessionId` field, or an
 * unknown session id, pass through unchanged.
 */
export function pinSessionId(ev: ProviderEvent, sessionId: string | undefined): ProviderEvent {
  if (sessionId === undefined) return ev;
  if (ev.type === 'session.init') {
    return ev.info.sessionId === sessionId ? ev : { ...ev, info: { ...ev.info, sessionId } };
  }
  const carried = (ev as { sessionId?: unknown }).sessionId;
  if (typeof carried !== 'string' || carried === sessionId) return ev;
  return { ...ev, sessionId } as ProviderEvent;
}

/**
 * Wrap the router's event lane so every forwarded event carries the session id
 * the session adopted from the FIRST `session.init` (the only init the router
 * yields; rebuilt inners' inits are swallowed). Closing the wrapper closes the
 * lane (for-await forwards `return()`), so the lane's teardown still runs.
 */
export async function* pinSessionIds(
  lane: AsyncGenerator<ProviderEvent, void, unknown>,
): AsyncGenerator<ProviderEvent, void, unknown> {
  let anchor: string | undefined;
  for await (const ev of lane) {
    if (anchor === undefined && ev.type === 'session.init') anchor = ev.info.sessionId;
    yield pinSessionId(ev, anchor);
  }
}

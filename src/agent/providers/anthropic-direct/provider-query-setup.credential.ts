/**
 * Pure helper for deriving whether the session token originated from the
 * Claude Code OAuth keychain store (vs. an env var or a slot-pinned key).
 *
 * Extracted so it can be unit-tested without standing up a full
 * `setUpQuerySession` call tree.
 *
 * @module agent/providers/anthropic-direct/provider-query-setup.credential
 */

/**
 * Contract: returns `true` IFF **both** of the following hold:
 *
 * 1. `tokenRefresherInstalled` is `true` — meaning `authMode === 'oauth' &&
 *    !localMode` (client-setup.ts:160). This rules out api-key sessions and
 *    local-mode sessions, neither of which ever touch the store.
 *
 * 2. `token === readStore()` — the live session token matches the value
 *    currently in the keychain cache. `readStore()` is a foreground read with a
 *    5 s in-process cache (keychain.ts), so this is a cache hit on the same
 *    value the `RetryLayer` constructor already read in the same construction
 *    path — no extra subprocess. `readStore()` is called exactly once here;
 *    there is no double-read: the result is compared inline against `token` and
 *    not stored separately, so the compiler/runtime sees a single invocation.
 *
 * Why `tokenRefresher` presence alone is insufficient: every top-level surface
 * fills `config.apiKey` FROM the store (`credential-resolver.ts:55-62`), and
 * subagent children receive `apiKey: resolvedChildApiKey` from the live store
 * (`child-config.helpers.ts:~211`). `tokenRefresher` is therefore installed for
 * EVERY `oauth && !localMode` session, including ones whose token came from
 * `AFK_MODEL_<TIER>_API_KEY` (slot-pinned). The token-equality comparison is
 * the only way to distinguish "token came from the store" from "token happens
 * to be oauth-shaped but was pinned via config".
 *
 * Conservative false cases:
 * - An env-var token that happens to equal the store is still blocked by the
 *   env guard inside `storeAheadOfClient`.
 * - If the store is unreadable `readStore()` returns `undefined`, so the
 *   comparison yields `false` — the conservative outcome (no auto-swap).
 */
export function deriveCredentialFromStore(
  token: string,
  tokenRefresherInstalled: boolean,
  readStore: () => string | undefined,
): boolean {
  if (!tokenRefresherInstalled) return false;
  return token === readStore();
}

/**
 * Credential selection for the suggestion engine.
 *
 * Invariant: a suggestion call authenticates with a credential resolved for
 * the SUGGESTION model's provider, never with the session's credential. The
 * suggestion model routinely belongs to a different provider than the session
 * (an Anthropic session falls back to `AFK_COMPACT_MODEL`, which may be a
 * `gpt-*` id; `AFK_SUGGEST_MODEL` may name anything). Forwarding the session
 * credential across that boundary sent an Anthropic token as the Bearer to
 * `api.openai.com` on every debounced keystroke, where it both failed and
 * leaked. The credential captured at REPL bootstrap is also only correct for
 * the BOOT model, so even a same-provider check against the live session model
 * goes stale after a `/model` swap. Resolving per target model removes both
 * failure modes. This mirrors cross-provider compaction
 * (`agent/providers/shared/compact-summarizer.ts`), which also resolves the
 * target provider's own credential and never borrows the session's.
 *
 * Resolution is memoized per provider kind for the engine's lifetime: the
 * Anthropic path can read the OS keychain, which must not run per keystroke.
 * That matches the previous session-stable capture.
 *
 * Cache key: `binding.provider` (the raw slot provider string such as
 * `'chatgpt-oauth'` or `'openai'`), NOT the collapsed `providerForModel`
 * return value. `providerForModel` collapses both `'openai'` and
 * `'chatgpt-oauth'` to `'openai-compatible'`, which would cause a chatgpt-oauth
 * slot and a plain openai slot to share the same cache entry and receive the
 * wrong credential. Using the raw binding provider preserves the distinction.
 *
 * @module cli/input/suggest-credential
 */

import { resolveCredentialForModel } from '../../agent/auth/credential-resolver.js';
import { resolveBinding } from '../../agent/session/model-slots.js';
import type { ProviderRouteHints } from '../../agent/providers/index.js';
import { debugLog } from '../../utils/debug.js';

/** Result returned by a credential resolve call. */
export interface SuggestCredential {
  apiKey?: string;
  forceChatgptOAuth?: boolean;
}

/**
 * Resolve a credential for `model` under `hints` (injectable for tests).
 * Returns a {@link SuggestCredential} object or `undefined` when no credential
 * is available.
 */
export type ResolveCredentialFn = (
  model: string | undefined,
  hints: ProviderRouteHints | undefined,
) => string | undefined;

/** Memoized per-provider-kind credential lookup for one suggest engine. */
export interface SuggestCredentialResolver {
  /** The credential for the provider that serves `model`, or undefined. */
  resolve(model: string, hints: ProviderRouteHints | undefined): SuggestCredential | undefined;
}

export function createSuggestCredentialResolver(
  resolveFn: ResolveCredentialFn = resolveCredentialForModel,
): SuggestCredentialResolver {
  // Cache key: the raw binding provider string (e.g. 'chatgpt-oauth', 'openai',
  // undefined → ''), not the collapsed providerForModel return value. This
  // ensures chatgpt-oauth and openai slots get separate cache entries.
  const cache = new Map<string, SuggestCredential | undefined>();
  return {
    resolve(model, hints) {
      const binding = resolveBinding(model, hints?.slots);
      // Use the raw provider field as the cache key; fall back to a sentinel
      // that groups all id-inferred (non-slot) providers together.
      const kind = binding.provider ?? `__inferred__:${model}`;
      if (cache.has(kind)) {
        debugLog('[suggest-credential] cache hit', kind);
        return cache.get(kind);
      }
      const apiKey = resolveFn(model, hints);
      const isChatgptOAuth = binding.provider === 'chatgpt-oauth';
      const result: SuggestCredential | undefined =
        apiKey !== undefined || isChatgptOAuth
          ? { ...(apiKey !== undefined ? { apiKey } : {}), ...(isChatgptOAuth ? { forceChatgptOAuth: true } : {}) }
          : undefined;
      cache.set(kind, result);
      return result;
    },
  };
}

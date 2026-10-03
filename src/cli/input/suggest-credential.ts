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
 * @module cli/input/suggest-credential
 */

import { resolveCredentialForModel } from '../../agent/auth/credential-resolver.js';
import {
  providerForModel,
  type ProviderRouteHints,
} from '../../agent/providers/index.js';

/** Resolve a credential for `model` under `hints` (injectable for tests). */
export type ResolveCredentialFn = (
  model: string | undefined,
  hints: ProviderRouteHints | undefined,
) => string | undefined;

/** Memoized per-provider-kind credential lookup for one suggest engine. */
export interface SuggestCredentialResolver {
  /** The credential for the provider that serves `model`, or undefined. */
  resolve(model: string, hints: ProviderRouteHints | undefined): string | undefined;
}

export function createSuggestCredentialResolver(
  resolveFn: ResolveCredentialFn = resolveCredentialForModel,
): SuggestCredentialResolver {
  const cache = new Map<string, string | undefined>();
  return {
    resolve(model, hints) {
      const kind = providerForModel(model, hints);
      if (cache.has(kind)) return cache.get(kind);
      const credential = resolveFn(model, hints);
      cache.set(kind, credential);
      return credential;
    },
  };
}

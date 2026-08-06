/**
 * Model + provider selection for the suggestion engine.
 *
 * Both suggestion producers — the Tier-2 completion tier and the empty-prompt
 * proposal — need the same two answers: WHICH model is the suggestion-class
 * model for this session, and WHICH provider instance serves it. Those answers
 * are shared state (the provider pool holds open SQLite handles), so they live
 * here rather than being duplicated in each producer.
 *
 * Split out of `./suggest`, which now composes the pieces. `suggest.ts`
 * re-exports {@link pickModel} so the historical import path keeps working.
 *
 * @module cli/input/suggest-provider
 */

import {
  providerForModel,
  resolveProvider as defaultResolveProvider,
  type ProviderRouteHints,
} from '../../agent/providers/index.js';
import type { ModelProvider } from '../../agent/provider.js';
import { env } from '../../config/env.js';
import type { SuggestContext } from './suggest.js';

/**
 * Pick the model for suggestions.
 *
 * Priority:
 *   1. `AFK_SUGGEST_MODEL` env override
 *   2. For anthropic-routed sessions: `AFK_COMPACT_MODEL ?? 'haiku'`
 *   3. For other providers: the session model (`ctx.model`)
 */
export function pickModel(ctx: SuggestContext): string {
  const suggestModel = env.AFK_SUGGEST_MODEL;
  if (suggestModel) return suggestModel;

  const providerName = providerForModel(ctx.model);
  if (providerName === 'anthropic-direct' || providerName === 'anthropic') {
    return env.AFK_COMPACT_MODEL ?? 'haiku';
  }

  return ctx.model;
}

/** Memoized provider handles, keyed by provider kind. */
export interface ProviderPool {
  /** Resolve (and memoize) the provider serving `model` under `hints`. */
  resolve(model: string | undefined, hints: ProviderRouteHints | undefined): ModelProvider;
  /** Close every memoized provider. Best-effort; never throws. */
  closeAll(): void;
}

/**
 * Build a per-session provider pool.
 *
 * `resolveProvider()` returns a FRESH provider on every call, and each provider
 * constructor opens a SQLite MemoryStore (mkdirSync + DB open + WAL replay —
 * all synchronous). Resolving per debounced keystroke therefore did blocking
 * disk I/O on the input hot path AND leaked an unclosed DB handle per novel
 * prefix for the REPL session's lifetime. Memoize (at most one per kind) and
 * close them all on dispose.
 */
export function createProviderPool(
  resolveProviderFn: (
    model: string | undefined,
    hints: ProviderRouteHints | undefined,
  ) => ModelProvider = defaultResolveProvider,
): ProviderPool {
  const cache = new Map<string, ModelProvider>();

  return {
    resolve(model, hints) {
      const kind = providerForModel(model, hints);
      let provider = cache.get(kind);
      if (provider === undefined) {
        provider = resolveProviderFn(model, hints);
        cache.set(kind, provider);
      }
      return provider;
    },
    closeAll() {
      for (const provider of cache.values()) {
        try {
          void provider.close?.();
        } catch {
          // ignore — teardown continues
        }
      }
      cache.clear();
    },
  };
}

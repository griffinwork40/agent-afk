/**
 * Ghost-text suggestion engine for the interactive REPL — composition root.
 *
 * Three producers, each in its own module; this file wires them to one
 * session-scoped engine and to the shared provider pool:
 *
 *   Tier 1 — `./suggest-tier1`. Deterministic, synchronous, always active.
 *     Returns the full completion candidate when `buffer` is a strict non-empty
 *     prefix of a known entry (dropdown candidate → history → mid-sentence
 *     skill name). Never returns a string equal to buffer.
 *
 *   Tier 2 — `./suggest-tier2`. LLM fallback, opt-in via `ctx.llmEnabled()`.
 *     Only fires when Tier 1 has no match AND `buffer.length >= MIN_LLM_CHARS`.
 *     Debounced, hard-aborted, result cached by buffer. Never throws.
 *
 *   Empty prompt — `./suggest-prompt` (production) + `./suggest-prompt-state`
 *     (lifecycle/newest-wins). PROPOSES a whole next action at a blank prompt
 *     rather than completing a prefix.
 *
 * Design: pure and dependency-injected. The engine holds no global state
 * except its producers' timers and bounded caches. Construct one per REPL
 * session. This module also re-exports the shared types and helpers so
 * `./input/suggest.js` stays the single public import path.
 *
 * @module cli/input/suggest
 */

import type { ProviderRouteHints } from '../../agent/providers/index.js';
import { getDeterministicGhost } from './suggest-tier1.js';
import { createProviderPool, pickModel } from './suggest-provider.js';
import { createPromptSuggestionState } from './suggest-prompt-state.js';
import { stripGhostControlChars } from './suggest-sanitize.js';
import { createTier2Runner, DEBOUNCE_MS, TIMEOUT_MS } from './suggest-tier2.js';
import type {
  CompleteFn,
  SuggestContext,
  SuggestEngine,
  SuggestEngineOptions,
} from './suggest-types.js';

export type {
  CompleteFn,
  CompleteRequest,
  SuggestContext,
  SuggestEngine,
  SuggestEngineOptions,
} from './suggest-types.js';
export { stripGhostControlChars } from './suggest-sanitize.js';
export { pickModel } from './suggest-provider.js';
export { getDeterministicGhost } from './suggest-tier1.js';

/**
 * Construct a fresh `SuggestEngine`. One instance per REPL session.
 */
export function createSuggestEngine(opts: SuggestEngineOptions = {}): SuggestEngine {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const providers = createProviderPool(opts.resolveProviderFn);

  /**
   * Resolve the completion function both producers share: the injected
   * completer in tests, otherwise a memoized real provider (null when that
   * provider cannot complete at all).
   */
  function resolveComplete(model: string, ctx: SuggestContext): CompleteFn | null {
    if (opts.completeFn) return opts.completeFn;
    const hints: ProviderRouteHints | undefined = ctx.baseUrl
      ? { openaiBaseUrl: ctx.baseUrl }
      : undefined;
    const provider = providers.resolve(model, hints);
    if (typeof provider.complete !== 'function') return null;
    return provider.complete.bind(provider);
  }

  const tier2 = createTier2Runner({
    pickModel,
    resolveComplete,
    debounceMs: opts.debounceMs ?? DEBOUNCE_MS,
    timeoutMs,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });

  const promptState = createPromptSuggestionState({
    pickModel,
    resolveComplete,
    timeoutMs,
    scrub: stripGhostControlChars,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });

  async function getGhost(buffer: string, ctx: SuggestContext): Promise<string | null> {
    // Always try Tier 1 first
    const deterministic = getDeterministicGhost(buffer, ctx);
    if (deterministic !== null) {
      return deterministic;
    }

    // Tier 2 guard condition (length + cache guards live in the runner).
    if (!ctx.llmEnabled()) return null;

    return tier2.request(buffer, ctx);
  }

  function dispose(): void {
    promptState.dispose();
    tier2.cancel();
    // Close memoized providers — each holds an open SQLite handle that would
    // otherwise leak for the process lifetime.
    providers.closeAll();
  }

  return {
    getDeterministicGhost,
    getGhost,
    primePromptSuggestion: (ctx) => promptState.prime(ctx),
    peekPromptSuggestion: () => promptState.peek(),
    clearPromptSuggestion: () => promptState.clear(),
    dispose,
  };
}

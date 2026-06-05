/**
 * Provider-agnostic usage accumulation.
 *
 * Lives in `src/agent/` (one layer up from `providers/`) because both
 * `anthropic-direct` and `openai-compatible` need to sum `ProviderUsage`
 * objects across tool-loop iterations and the math is identical. Keeping it
 * here lets each provider import from a sibling-of-its-parent module rather
 * than cross-import from another provider directory.
 *
 * The `anthropic-direct/types.ts` file re-exports `sumProviderUsage` from
 * here as a backward-compatibility shim — existing tests + the loop module
 * keep their imports unchanged.
 *
 * @module agent/usage
 */

import type { ProviderUsage } from './provider.js';

/**
 * Sum two `ProviderUsage` objects into a third. Used by providers to
 * aggregate usage across multiple model calls within a single user turn.
 *
 * Semantics:
 *   - `inputTokens` / `outputTokens` / `totalTokens` / `totalCostUsd` are
 *     CUMULATIVE — every tool-use iteration adds new input (history + new
 *     tool_result blocks) and output (the assistant's new turn). Summing
 *     matches billing.
 *   - `cachedInputTokens` / `cacheCreationTokens` are NOT cumulative — they
 *     report the current-call's prefix-cache footprint, which references
 *     the SAME cached system + tool prefix across every iteration of a turn
 *     (single-breakpoint policy in `anthropic-direct/cache-policy.ts`).
 *     Summing them N-times across N iterations inflates the apparent
 *     context size by ~N×, which clamps `contextRatio` to 100% in the REPL
 *     status line. Take the latest value (`b`, the incoming iteration)
 *     instead.
 *
 * If a provider ever moves to multi-breakpoint caching, those fields would
 * become genuinely additive across distinct cache creations — revisit then.
 *
 * @see anthropic-direct/types.ts — historical home, now a re-export shim.
 */
export function sumProviderUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  const sumOptional = (x?: number, y?: number): number | undefined => {
    if (x == null && y == null) return undefined;
    return (x ?? 0) + (y ?? 0);
  };
  const latestOptional = (x?: number, y?: number): number | undefined => {
    if (y !== undefined) return y;
    return x;
  };
  const out: ProviderUsage = {
    stopReason: b.stopReason ?? a.stopReason ?? null,
  };
  const inp = sumOptional(a.inputTokens, b.inputTokens);
  if (inp !== undefined) out.inputTokens = inp;
  const outp = sumOptional(a.outputTokens, b.outputTokens);
  if (outp !== undefined) out.outputTokens = outp;
  // Cache fields: take latest, not sum — see semantics note above.
  const cached = latestOptional(a.cachedInputTokens, b.cachedInputTokens);
  if (cached !== undefined) out.cachedInputTokens = cached;
  const cacheCreate = latestOptional(a.cacheCreationTokens, b.cacheCreationTokens);
  if (cacheCreate !== undefined) out.cacheCreationTokens = cacheCreate;
  const total = sumOptional(a.totalTokens, b.totalTokens);
  if (total !== undefined) out.totalTokens = total;
  // Cost is cumulative across iterations (unlike cache fields above).
  const cost = sumOptional(a.totalCostUsd, b.totalCostUsd);
  if (cost !== undefined) out.totalCostUsd = cost;
  return out;
}

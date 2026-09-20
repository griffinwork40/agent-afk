/**
 * Context-usage display projection — provider-neutral.
 *
 * Translates a provider's native {@link ProviderUsage} (camelCase) into the
 * SDK-shaped fields that REPL consumers read: the `/tokens` command
 * (src/cli/slash/commands/info.ts) and the status-line sampler
 * (src/cli/context-sampler.ts).
 *
 * Split from `shared/auto-compact.ts` (#1863) — the threshold logic and the
 * display projection are independent concerns; extracting here keeps each file
 * within the 350-code-line ceiling and makes the dependency graph explicit.
 *
 * @module agent/providers/shared/context-usage-fields
 */

import type { ProviderUsage } from '../../provider.js';

/**
 * Cumulative billed tokens for a turn: `inputTokens + outputTokens`.
 *
 * This is the FALLBACK for {@link contextWindowTokensUsed} (used when a
 * provider has not populated {@link ProviderUsage.contextWindowTokens}) and the
 * `/tokens` total. It deliberately omits cache: `sumProviderUsage` accumulates
 * input/output cumulatively across tool-loop rounds but keeps cache fields at
 * their latest (last-round) value, so summing the two is a mixed basis. The
 * real context-window footprint is computed per-round at the provider — see
 * {@link ProviderUsage.contextWindowTokens}.
 *
 * Contract: returns input + output only. (A prior comment here claimed
 * Anthropic's `input_tokens` "already includes cache reads" — that is wrong.
 * Per the Anthropic API docs, `input_tokens` counts only tokens NOT read from
 * or used to create a cache; total = input + cache_read + cache_creation.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
 */
export function computeUsedTokens(usage: Partial<ProviderUsage>): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/**
 * Context-window footprint for the latest model call — the value that drives
 * the context-usage % and auto-compaction. Prefers the provider-computed
 * {@link ProviderUsage.contextWindowTokens} (correct per-provider cache
 * accounting) and falls back to {@link computeUsedTokens} when absent.
 */
export function contextWindowTokensUsed(usage: Partial<ProviderUsage>): number {
  return usage.contextWindowTokens ?? computeUsedTokens(usage);
}

/**
 * Snake_case per-field last-turn API usage, matching the shape both the
 * `/tokens` command (src/cli/slash/commands/info.ts) and the status-line
 * sampler (src/cli/context-sampler.ts) read off `apiUsage`.
 */
// A `type` alias (not `interface`) so it stays assignable to the
// `Record<string, unknown>` shape that ProviderContextUsage.apiUsage expects —
// interfaces are open to declaration merging and TS refuses the assignment.
export type ContextUsageApiBreakdown = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /**
   * Invariant: the four fields above are a MIXED BASIS and must never be
   * summed. `sumProviderUsage` accumulates input/output cumulatively across
   * every tool-loop round of a turn, but keeps the two cache fields at their
   * latest (last-round) value. By round N the latest `cache_read` already
   * contains everything the earlier rounds sent, so adding the cumulative
   * input/output back on top double-counts them — inflation that grows with
   * round count and can push a displayed total past the context limit while
   * the separately-derived percentage stays correct.
   *
   * This field is the single safe scalar: the provider-computed context-window
   * footprint of the LAST round only (input + output + cache_read +
   * cache_creation for that one call). Display code wanting "how full is the
   * context" reads this, not a sum. See turn-accumulator.ts `addRoundUsage`.
   */
  context_window_tokens: number;
};

/** Consumer-facing context-usage fields derived from a completed turn. */
export interface ContextUsageFields {
  totalTokens: number;
  apiUsage: ContextUsageApiBreakdown | null;
}

/**
 * Translate a provider's native {@link ProviderUsage} (camelCase) into the
 * SDK-shaped context-usage fields the REPL consumers read.
 *
 * Contract: `SDKControlGetContextUsageResponse` (src/agent/types/sdk-types.ts)
 * declares `totalTokens: number` and a snake_case `apiUsage`. The provider's
 * `getContextUsage()` returns the looser `ProviderContextUsage`, so without
 * this translation the consumers read `usage.totalTokens` (→ `undefined`, which
 * `formatTokens` renders as `NaNm`) and `apiUsage.input_tokens` et al. (→
 * `undefined ?? 0` → all zeros). This helper is the single source of truth for
 * that mapping, shared by both the anthropic-direct and openai-compatible
 * providers.
 *
 * - `totalTokens` uses {@link contextWindowTokensUsed} — the provider-computed
 *   context-window footprint (falling back to inputTokens + outputTokens) — so
 *   the displayed total stays consistent with the context-usage percentage,
 *   which is derived from the same value. Deliberately does NOT read
 *   `ProviderUsage.totalTokens` — that field is provider-dependent and would
 *   diverge from the percentage.
 * - `apiUsage` carries the raw per-field breakdown (including cache reads /
 *   creation) for the "Last turn (API)" display, and is `null` when no turn has
 *   completed yet — matching the SDK response's nullable contract.
 */
export function buildContextUsageFields(
  last: ProviderUsage | null | undefined,
): ContextUsageFields {
  if (!last) {
    return { totalTokens: 0, apiUsage: null };
  }
  return {
    totalTokens: contextWindowTokensUsed(last),
    apiUsage: {
      input_tokens: last.inputTokens ?? 0,
      output_tokens: last.outputTokens ?? 0,
      cache_read_input_tokens: last.cachedInputTokens ?? 0,
      cache_creation_input_tokens: last.cacheCreationTokens ?? 0,
      context_window_tokens: contextWindowTokensUsed(last),
    },
  };
}

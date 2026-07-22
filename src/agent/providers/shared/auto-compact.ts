/**
 * Auto-compaction threshold logic — provider-neutral.
 *
 * Intentionally pure — no I/O, no logging, no side effects. The caller
 * (each provider's turn loop) reads the result and decides whether to fire
 * `compact()`.
 *
 * Previously located at `anthropic-direct/query/auto-compact.ts`. Moved here
 * because both the anthropic-direct and openai-compatible providers consume
 * these helpers. The original file now re-exports from this location so
 * existing test imports continue to resolve without change.
 *
 * @module agent/providers/shared/auto-compact
 */

import type { ProviderUsage } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';

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
    },
  };
}

/**
 * Return true when automatic compaction should be triggered.
 *
 * @param usedTokens  - Total tokens consumed in the last turn
 *   (`inputTokens + outputTokens` — see {@link computeUsedTokens}).
 *   A value <= 0 means usage is unknown — returns false in that case.
 * @param contextLimit - Model's full context window in tokens.
 *   A value <= 0 means the limit is unknown — returns false.
 * @param threshold - Fraction of the context window (0–1 exclusive) at which
 *   to trigger. Defaults to 0.90. Values outside (0, 1) are treated as
 *   disabled and return false.
 */
export function shouldAutoCompact(
  usedTokens: number,
  contextLimit: number,
  threshold: number,
): boolean {
  if (contextLimit <= 0) return false;
  if (usedTokens <= 0) return false;
  if (threshold <= 0 || threshold >= 1) return false;
  return usedTokens / contextLimit >= threshold;
}

/**
 * Context-window fullness as a raw fraction of a limit.
 *
 * Unlike {@link shouldAutoCompact} (a boolean gate against a configured
 * threshold), this returns the magnitude for callers that need to reason about
 * how full the window is — e.g. the compaction handlers deciding whether to
 * shrink the keep-window on a short-but-full session (see
 * `shared/compaction.ts:findCompactionBoundaryAdaptive`). Returns `0` when
 * either input is non-positive (unknown usage / limit) so an unknown state
 * never looks "full" and never triggers the shrink fallback.
 */
export function contextFullnessFraction(usedTokens: number, contextLimit: number): number {
  if (contextLimit <= 0 || usedTokens <= 0) return 0;
  return usedTokens / contextLimit;
}

/** Default auto-compaction threshold (fraction of the context window). */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.9;

/**
 * Resolve `AgentConfig.autoCompact` to a numeric threshold fraction, or
 * `undefined` when auto-compaction is disabled. Provider-neutral: both the
 * anthropic-direct and openai-compatible providers resolve their threshold
 * through this single source of truth.
 *
 * - `false` or `undefined` → disabled (`undefined` returned).
 * - `true` → default threshold (0.90).
 * - `{ threshold: n }` → custom fraction; clamped to (0, 1) exclusive.
 *   Out-of-range values are silently treated as disabled.
 */
export function resolveAutoCompactThreshold(
  autoCompact: AgentConfig['autoCompact'],
): number | undefined {
  if (autoCompact === undefined || autoCompact === false) return undefined;
  if (autoCompact === true) return DEFAULT_AUTO_COMPACT_THRESHOLD;
  const t = autoCompact.threshold;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t >= 1) {
    return undefined;
  }
  return t;
}

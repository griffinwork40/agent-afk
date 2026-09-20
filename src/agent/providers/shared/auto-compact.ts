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
 * Context-usage display projection (`computeUsedTokens`, `contextWindowTokensUsed`,
 * `buildContextUsageFields`, and the associated types) was split into
 * `shared/context-usage-fields.ts` (#1863) — that concern is independent of
 * the threshold math and was growing the file past the 350-code-line ceiling.
 *
 * @module agent/providers/shared/auto-compact
 */

import type { AgentConfig } from '../../types/config-types.js';
import { autoCompactLimitFor, contextLimitFor, maxOutputTokensFor } from '../../model-limits.js';

// Re-export the display-projection symbols so existing importers that reach
// into this module do not break (#1863 — additive, not a breaking rename).
export {
  computeUsedTokens,
  contextWindowTokensUsed,
  buildContextUsageFields,
} from './context-usage-fields.js';
export type { ContextUsageApiBreakdown, ContextUsageFields } from './context-usage-fields.js';

/**
 * Return true when automatic compaction should be triggered.
 *
 * @param usedTokens  - Total tokens consumed in the last turn
 *   (`inputTokens + outputTokens` — see `computeUsedTokens`).
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
 * Maximum SAFE auto-compaction threshold for a model, computed from its
 * documented output ceiling (#962).
 *
 * When auto-compaction fires at `threshold × window`, the NEXT turn needs at
 * least `max_tokens` headroom: `threshold × window + max_tokens ≤ window`,
 * i.e. `threshold ≤ (window - max_tokens) / window`. The slack fraction
 * (`SAFE_THRESHOLD_SLACK`) shaves a small buffer so the guard fires slightly
 * before the exact math boundary, avoiding a race between compaction and the
 * next user turn.
 *
 * For models whose `MODEL_AUTOCOMPACT_BUDGET` shrinks the compaction limit below
 * the real context window (base `sonnet`, base `opus`), auto-compaction already
 * fires well below the overflow boundary — no cap is needed, so this returns
 * the default 0.90 unchanged. The cap only tightens for narrow-headroom models
 * whose compaction limit equals their full context window:
 *
 * | Model              | window  | ceiling | cap    |
 * |--------------------|---------|---------|--------|
 * | haiku              | 200k    | 64k     | ≈0.64  |
 * | openai compat fb.  | 262k    | 64k     | ≈0.70  |
 * | sonnet_1m / opus_1m| 1M      | 128k    | ≈0.83  |
 * | base sonnet/opus   | (200k budget) | 128k | 0.90 (no cap) |
 *
 * Callers that set a user-configured threshold receive the MIN of their
 * threshold and this safe cap — they can still lower the threshold further,
 * but never raise it above the safe boundary.
 */
const SAFE_THRESHOLD_SLACK = 0.04;

/**
 * Returns the maximum safe auto-compaction threshold for a model — the
 * largest fraction of the context window at which compaction can fire and
 * still leave enough room for a full output turn.
 *
 * Use as a cap on any threshold before passing it to `shouldAutoCompact`.
 */
export function safeAutoCompactThresholdFor(model: string): number {
  const contextWindow = contextLimitFor(model);
  const compactionLimit = autoCompactLimitFor(model);
  const ceiling = maxOutputTokensFor(model);
  if (contextWindow <= 0 || ceiling <= 0) return DEFAULT_AUTO_COMPACT_THRESHOLD;

  // When `MODEL_AUTOCOMPACT_BUDGET` shrinks the compaction limit below the
  // real context window (base `sonnet`, `opus`), auto-compaction fires at a
  // fraction of the budget — which is already far below the overflow point.
  // No cap is needed: the budget guarantee is stricter than the overflow guard.
  // Apply the cap only when compactionLimit equals the full context window.
  if (compactionLimit < contextWindow) return DEFAULT_AUTO_COMPACT_THRESHOLD;

  // The safe cap is the fraction of the context window below which the
  // next full output turn still fits: `threshold × window + ceiling ≤ window`.
  // `SAFE_THRESHOLD_SLACK` adds a small buffer so compaction fires slightly
  // before the exact math boundary.
  const safeCap = (contextWindow - ceiling) / contextWindow - SAFE_THRESHOLD_SLACK;
  // Never return a nonsensical value — fall back to default if the geometry
  // is impossible (e.g. ceiling >= contextWindow).
  return safeCap > 0 ? safeCap : DEFAULT_AUTO_COMPACT_THRESHOLD;
}

/**
 * Fail-fast guard for context-window overflow (#962).
 *
 * When `knownInputTokens + maxOutputTokens > contextLimit`, the provider WILL
 * reject the request with HTTP 400 ("input length and max_tokens exceed context
 * limit"). We detect this condition before sending — using the stale-by-one-round
 * `lastUsage.contextWindowTokens` as a lower bound on the current input — and
 * throw a legible error naming the numbers and the two escape hatches.
 *
 * **Conservative by design.** The guard fires only when overflow is
 * MATHEMATICALLY CERTAIN (stale lower-bound already exceeds the hard limit),
 * never on estimates. A request whose actual input is slightly larger than the
 * stale count still goes to the wire; the provider error in that case is
 * unchanged from pre-fix behaviour and is already reasonably legible.  Trading
 * a loud 400 for a silent `max_tokens` shrink (#952) is NOT acceptable — we
 * fail loudly or not at all.
 *
 * **Not called when `knownInputTokens <= 0`** (first turn or stale usage
 * unavailable) — the guard skips those cases to avoid false positives on sessions
 * that have never completed a round.
 *
 * @throws {Error} with a structured message naming the numbers and escape hatches
 *   when overflow is guaranteed.
 */
export function guardContextOverflow(
  knownInputTokens: number,
  maxOutputTokens: number,
  contextLimit: number,
  model: string,
): void {
  if (knownInputTokens <= 0 || contextLimit <= 0 || maxOutputTokens <= 0) return;
  const projected = knownInputTokens + maxOutputTokens;
  if (projected <= contextLimit) return;
  throw new Error(
    `[afk] Context-window overflow: the conversation already used ~${knownInputTokens.toLocaleString()} ` +
      `tokens (last-turn API count) and the configured output ceiling is ${maxOutputTokens.toLocaleString()} ` +
      `tokens — together they exceed the ${model} context window of ${contextLimit.toLocaleString()} tokens ` +
      `by ${(projected - contextLimit).toLocaleString()} tokens. ` +
      `The provider would reject this request with HTTP 400. ` +
      `To continue: run /compact to summarise the conversation history, or start a new session.`,
  );
}

/**
 * Resolve `AgentConfig.autoCompact` to a numeric threshold fraction, or
 * `undefined` when auto-compaction is disabled. Provider-neutral: both the
 * anthropic-direct and openai-compatible providers resolve their threshold
 * through this single source of truth.
 *
 * When `model` is supplied the resolved threshold is capped at
 * {@link safeAutoCompactThresholdFor} — the largest fraction of the window at
 * which compaction can fire and still leave enough room for a full output turn
 * (#962). This prevents the situation where compaction would fire AFTER the
 * overflow point (e.g. haiku: 0.9×200k = 180k, but overflow is at 136k).
 * The cap is applied silently; it does not disable compaction, just moves the
 * trigger earlier.
 *
 * - `false` or `undefined` → disabled (`undefined` returned).
 * - `true` → default threshold (0.90), capped at `safeAutoCompactThresholdFor(model)`.
 * - `{ threshold: n }` → custom fraction; clamped to (0, 1) exclusive and
 *   capped at `safeAutoCompactThresholdFor(model)`.
 *   Out-of-range values are silently treated as disabled.
 */
export function resolveAutoCompactThreshold(
  autoCompact: AgentConfig['autoCompact'],
  model?: string,
): number | undefined {
  if (autoCompact === undefined || autoCompact === false) return undefined;
  const safeCap = model !== undefined ? safeAutoCompactThresholdFor(model) : 1;
  if (autoCompact === true) return Math.min(DEFAULT_AUTO_COMPACT_THRESHOLD, safeCap);
  const t = autoCompact.threshold;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t >= 1) {
    return undefined;
  }
  return Math.min(t, safeCap);
}

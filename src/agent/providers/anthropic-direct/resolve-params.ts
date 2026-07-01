/**
 * Pure parameter-resolution helpers for the anthropic-direct provider.
 *
 * These functions are stateless and carry zero dependency on the
 * {@link AnthropicDirectProvider} instance — extracted from `index.ts`
 * (issue #103) to shrink the provider file and isolate independently testable
 * logic. `index.ts` re-imports all of them and re-exports `resolveMaxTokens`,
 * `resolveThinkingParam`, and `resolveEffort` so the historical
 * `from './index.js'` import path stays valid for existing callers.
 *
 * @module agent/providers/anthropic-direct/resolve-params
 */

import type { MessageParam, ThinkingConfigParam } from '@anthropic-ai/sdk/resources';
import type { AgentConfig, ResumeHistoryTurn } from '../../types/config-types.js';
import type { EffortLevel, ThinkingConfig } from '../../types/sdk-types.js';
import { maxOutputTokensFor } from '../../model-limits.js';

/** Match opus-4.7 and later opus 4.x families that require adaptive thinking + summarized display. */
const isOpus47Plus = (model: string): boolean => /opus-4-(7|[89])/.test(model);

/**
 * Models that reject manual `{type:'enabled'}` extended thinking and must be
 * routed to adaptive thinking instead: the opus-4.7+ family plus Claude
 * Sonnet 5 (adaptive-only per its model card — "Extended thinking: No /
 * Adaptive thinking: Yes", the same profile as Opus 4.8).
 */
const requiresAdaptiveThinking = (model: string): boolean =>
  isOpus47Plus(model) || /(claude-)?sonnet-5/.test(model);

const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.9;

/**
 * Resolve `AgentConfig.autoCompact` to a numeric threshold fraction, or
 * `undefined` when auto-compaction is disabled.
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

/**
 * Module-scope dedupe for budget-clamp warnings, keyed so a single
 * misconfiguration warns once per process rather than once per turn.
 */
const warnedTokenClamps = new Set<string>();

/**
 * Fraction of `max_tokens` reserved for the visible reply when thinking is
 * explicitly enabled. Thinking tokens share the output budget on the Messages
 * API, so without a reserve the thinking budget can consume nearly all of
 * `max_tokens` and starve the final answer (a budget of `maxTokens - 1` leaves
 * one token for the reply). 0.25 keeps at least a quarter of the budget for the
 * reply while leaving the bulk for reasoning.
 */
const THINKING_OUTPUT_RESERVE_FRACTION = 0.25;

/**
 * Resolve the effective Messages-API `max_tokens`, clamped to the model's
 * documented output ceiling (`maxOutputTokensFor`).
 *
 * - A finite, positive `config.maxOutputTokens` is used as-is when it fits the
 *   ceiling and clamped down (with a one-time warning) when it exceeds it.
 *   Without the clamp an over-large value reaches the wire verbatim and the
 *   API rejects the request with HTTP 400.
 * - Any non-finite or non-positive value — including the
 *   `Number.POSITIVE_INFINITY` "model max" sentinel that `parseMaxOutputTokens`
 *   emits for `--max-output-tokens max` — falls back to the model ceiling.
 *
 * Exported for unit testing; the production caller is the query builder in
 * `index.ts`.
 */
export function resolveMaxTokens(config: AgentConfig, model: string): number {
  const ceiling = maxOutputTokensFor(model);
  const v = config.maxOutputTokens;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const requested = Math.floor(v);
    if (requested > ceiling) {
      const key = `max:${model}:${requested}`;
      if (!warnedTokenClamps.has(key)) {
        warnedTokenClamps.add(key);
        console.warn(
          `[afk] maxOutputTokens ${requested} exceeds the ${model} output ceiling (${ceiling}); clamping to ${ceiling}.`,
        );
      }
      return ceiling;
    }
    return requested;
  }
  return ceiling;
}

export function resumeHistoryToMessages(history: ResumeHistoryTurn[] | undefined): MessageParam[] | undefined {
  if (!history || history.length === 0) return undefined;
  const messages: MessageParam[] = [];
  for (const turn of history) {
    if (turn.user.length > 0) {
      messages.push({ role: 'user', content: turn.user });
    }
    if (turn.assistant.length > 0) {
      messages.push({ role: 'assistant', content: turn.assistant });
    }
  }
  return messages.length > 0 ? messages : undefined;
}

/**
 * Translate our internal {@link ThinkingConfig} into the Anthropic SDK wire
 * shape, applying model-specific fixups.
 *
 * Fixups for the adaptive-thinking-only models — the `claude-opus-4-7+`
 * family and `claude-sonnet-5` (see `requiresAdaptiveThinking`):
 *  - `{type: 'enabled'}` is rejected by the API; auto-route to `'adaptive'`.
 *    Callers that explicitly request `enabled` on these models get adaptive
 *    behaviour so the request still clears the API's validation.
 *  - `display: 'summarized'` is always injected on adaptive/enabled configs.
 *    On 4.7+ the default display mode is `'omitted'` (thinking blocks are
 *    produced server-side but stripped before delivery), so this field is
 *    *required* to surface visible reasoning.  On earlier models it is
 *    harmless — the server already defaults to visible delivery.
 */
export function resolveThinkingParam(
  tc: ThinkingConfig,
  maxTokens: number,
  model?: string,
): ThinkingConfigParam {
  switch (tc.type) {
    case 'adaptive':
      // Cast: the SDK ThinkingConfigAdaptive shape doesn't declare `display`
      // yet, but the server honours it.  We use a type assertion to avoid
      // pulling in a beta-SDK type across the module boundary.
      return { type: 'adaptive', display: 'summarized' } as ThinkingConfigParam;

    case 'disabled':
      return { type: 'disabled' };

    case 'enabled': {
      if (typeof model === 'string' && requiresAdaptiveThinking(model)) {
        // These models reject {type:'enabled'}; silently promote to adaptive.
        return { type: 'adaptive', display: 'summarized' } as ThinkingConfigParam;
      }
      // Thinking tokens share the `max_tokens` budget, so reserve a slice for
      // the visible reply and cap the thinking budget to fit. The cap applies
      // to caller-supplied budgets too — an oversized explicit budget is
      // clamped (with a one-time warning) rather than honoured blindly.
      // `budget_tokens` must satisfy 1024 <= budget < max_tokens; when the
      // reserve cannot be honoured (very small max_tokens) the upper bound
      // wins so the request still clears the `< max_tokens` constraint.
      const reserve = Math.floor(maxTokens * THINKING_OUTPUT_RESERVE_FRACTION);
      const maxBudget = Math.max(1024, maxTokens - 1 - reserve);
      const explicit =
        tc.budgetTokens !== undefined && Number.isFinite(tc.budgetTokens)
          ? Math.floor(tc.budgetTokens)
          : undefined;
      const budget = Math.min(Math.max(explicit ?? maxBudget, 1024), maxBudget);
      if (explicit !== undefined && explicit > maxBudget) {
        const key = `think:${model ?? 'default'}:${explicit}:${maxTokens}`;
        if (!warnedTokenClamps.has(key)) {
          warnedTokenClamps.add(key);
          console.warn(
            `[afk] thinking budgetTokens ${explicit} leaves too little of max_tokens ${maxTokens} for the reply; clamping to ${maxBudget}.`,
          );
        }
      }
      return {
        type: 'enabled',
        budget_tokens: budget,
        display: 'summarized',
      } as ThinkingConfigParam;
    }
  }
}

/**
 * Resolve the effective effort level for a request.
 *
 * Rules:
 *  1. An explicit `config.effort` always wins — callers can always override
 *     (including on Haiku, which will then fail loudly rather than silently
 *     ignore).
 *  2. For `opus-4-6`, `opus-4-7`, `opus-4-8`, `sonnet-4-6`, `sonnet-4-7`, and
 *     `sonnet-5` (current and recent non-Haiku Claude models), default to
 *     `'max'` when no effort is supplied. Empirically (scripts/probe-effort-
 *     thinking.mjs on opus-4-7) `max` produces ~10× the thinking-token depth
 *     vs the server default; the same lever applies on sonnet-4-6/opus-4-6.
 *     On opus-4-8 the server default flipped to `high`, so retaining `max`
 *     here preserves the high-thinking-depth experience users had on 4.7.
 *     Sonnet 5's server default is also `high`; `max` keeps parity with the
 *     prior Sonnet tier (4.6).
 *  3. Older 4-x variants (4-1, 4-5) and every Haiku reject
 *     `output_config.effort` with HTTP 400 — auto-default is skipped so
 *     non-effort requests on those models stay byte-equal to before.
 *  4. 3.x / legacy / unknown ids: omit. Matches Claude Code's
 *     `modelSupportsEffort()` allowlist behavior.
 *
 * `'xhigh'` is accepted by the API but empirically sits between `'high'`
 * and `'max'` on opus-4-7, so it is NOT the auto-default. (Anthropic's
 * 4.8 docs recommend `xhigh` for coding/agentic work; consider re-tuning
 * after baselining cost/latency on 4.8.)
 *
 * The returned value is forwarded as `output_config.effort` in the wire
 * request.  When `undefined`, no `output_config` field is sent.
 */
export function resolveEffort(
  callerEffort: EffortLevel | undefined,
  model: string,
): EffortLevel | undefined {
  if (callerEffort !== undefined) return callerEffort;
  const m = model.toLowerCase();
  // Allowlist: `4-6`/`4-7`/`4-8` opus & sonnet variants plus Sonnet 5 accept
  // `output_config.effort` (4.x variants probed via scripts/probe-effort-
  // {all-models,older}.mjs against the OAuth identity; Sonnet 5 documented to
  // accept `effort` with a `high` server default). Earlier minor versions —
  // 4-1, 4-5 sonnet, 4-5 opus, and every Haiku — return HTTP 400
  // "This model does not support the effort parameter." Caller-supplied
  // effort still flows through unchanged so explicit overrides fail loudly
  // rather than silently ignoring, but auto-default is gated tightly.
  if (/(claude-)?(opus|sonnet)-4-[678]|(claude-)?sonnet-5/.test(m)) return 'max';
  return undefined;
}

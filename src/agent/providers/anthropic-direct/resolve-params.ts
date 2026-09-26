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

import type { ContentBlockParam, MessageParam, ThinkingConfigParam } from '@anthropic-ai/sdk/resources';
import type { AgentConfig, ResumeHistoryTurn } from '../../types/config-types.js';
import type { EffortLevel, ThinkingConfig } from '../../types/sdk-types.js';
import { maxOutputTokensFor } from '../../model-limits.js';

/** Match opus-4.7 and later opus 4.x families that require adaptive thinking + summarized display. */
const isOpus47Plus = (model: string): boolean => /opus-4-(7|[89])/.test(model);

/**
 * Models that reject manual `{type:'enabled'}` extended thinking and must be
 * routed to adaptive thinking instead: the opus-4.7+ family plus Claude
 * Sonnet 5 and Claude Opus 5 (adaptive-only per their model cards — "Extended
 * thinking: No / Adaptive thinking: Yes", the same profile as Opus 4.8).
 */
const requiresAdaptiveThinking = (model: string): boolean =>
  isOpus47Plus(model) || /(claude-)?(opus|sonnet)-5/.test(model);

// resolveAutoCompactThreshold moved to shared/auto-compact.ts (both providers
// auto-compact now). Re-exported here so existing importers (index.ts) resolve
// unchanged.
export { resolveAutoCompactThreshold } from '../shared/auto-compact.js';

/**
 * Module-scope dedupe for budget-clamp warnings, keyed so a single
 * misconfiguration warns once per process rather than once per turn.
 */
const warnedTokenClamps = new Set<string>();

/** Module-scope dedupe for temperature-clamp warnings. */
const warnedTemperatureClamps = new Set<string>();

/** Anthropic Messages API maximum temperature. */
const ANTHROPIC_MAX_TEMPERATURE = 1.0;

/**
 * Validate and clamp the sampling temperature for the Anthropic Messages API.
 *
 * The Anthropic API accepts `0.0`-`1.0`; values above `1.0` are rejected with
 * HTTP 400. The shared config layer (`settable-keys.ts`) permits `0`-`2` to
 * accommodate OpenAI's wider range, so the user can set `1.5` via
 * `/config set temperature 1.5` and have it silently accepted at the config tier
 * while the Anthropic wire rejects it at runtime.
 *
 * This function mirrors the `resolveMaxTokens` pattern: clamp with a one-time
 * warning rather than letting the request fail opaquely at the API boundary.
 * Values at or below `1.0` pass through unchanged. `undefined` stays `undefined`
 * (server default). Negative or non-finite values are treated as unset.
 */
export function resolveAnthropicTemperature(
  temperature: number | undefined,
): number | undefined {
  if (temperature === undefined) return undefined;
  if (!Number.isFinite(temperature) || temperature < 0) return undefined;
  if (temperature > ANTHROPIC_MAX_TEMPERATURE) {
    const key = `temp:${temperature}`;
    if (!warnedTemperatureClamps.has(key)) {
      warnedTemperatureClamps.add(key);
      console.warn(
        `[afk] temperature ${temperature} exceeds the Anthropic maximum (${ANTHROPIC_MAX_TEMPERATURE}); clamping to ${ANTHROPIC_MAX_TEMPERATURE}.`,
      );
    }
    return ANTHROPIC_MAX_TEMPERATURE;
  }
  return temperature;
}

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

/**
 * Allowlisted `type` values for content blocks deserialized from sidecar JSON.
 *
 * These are the complete set of `ContentBlockParam` discriminants in the
 * Anthropic SDK — every entry in the `ContentBlockParam` union maps to exactly
 * one string here. Any block whose `type` is absent or not in this set is
 * silently dropped before the block array reaches the API (#2003).
 *
 * Security rationale: `userContentBlocks` and `assistantContentBlocks` are
 * JSON-deserialized from `$AFK_STATE_DIR/sessions/` sidecar files. An attacker
 * with local write access to those files could craft blocks with unknown or
 * crafted `type` values. Forwarding them verbatim to the Anthropic API could
 * replay attacker-controlled `tool_use` blocks (with arbitrary `name`/`input`)
 * into a resumed session. The allowlist check is the last defence before the
 * API call and must stay conservative.
 *
 * Keep in sync with ContentBlockParam union from @anthropic-ai/sdk.
 * When the SDK adds new discriminants, add them here -- unknown types
 * are silently filtered on resume (safe-fail, not safe-pass).
 * See: .sdk-dependency.lock.json for SDK import tracking.
 */
const ALLOWED_CONTENT_BLOCK_TYPES = new Set<string>([
  'text',
  'image',
  'document',
  'search_result',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

/**
 * Filter a raw (JSON-deserialized) content-block array, retaining only blocks
 * whose `type` field is a known `ContentBlockParam` discriminant.
 *
 * - Non-object entries, `null`, and entries without a string `type` field are
 *   dropped — they cannot be valid blocks.
 * - Entries with an unknown `type` are dropped — they may be attacker-crafted
 *   or from a future SDK version this binary does not understand.
 * - Valid entries are returned as `ContentBlockParam[]` via a type assertion
 *   that is now safe because the discriminant has been checked at runtime.
 *
 * Exported for unit testing; the production caller is `resumeHistoryToMessages`.
 */
export function filterContentBlocks(raw: unknown[] | undefined): ContentBlockParam[] {
  if (!raw || raw.length === 0) return [];
  const result: ContentBlockParam[] = [];
  for (const block of raw) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const t = (block as Record<string, unknown>)['type'];
    if (typeof t !== 'string' || !ALLOWED_CONTENT_BLOCK_TYPES.has(t)) continue;
    result.push(block as ContentBlockParam);
  }
  return result;
}

/**
 * Contract: Rebuild a `MessageParam[]` from persisted `ResumeHistoryTurn` records.
 *
 * Two paths:
 *   - **Structured path** (new sidecars, v5.226+): when `assistantContentBlocks`
 *     or `userContentBlocks` is present on the turn, the full typed block array
 *     is used as the message `content`. Blocks (`tool_use`, `thinking`,
 *     `tool_result`, `text`) are passed through as-is. No `summarizeToolEvents`
 *     append is needed because the structured blocks already contain the tool
 *     information. **Pairing is not validated here** (see note below).
 *   - **Text fallback** (pre-v5.226 sidecars): turns with no content-block
 *     fields fall back to the legacy `{ role, content: string }` path so
 *     backward compatibility is preserved across upgrades.
 *
 * Content blocks from sidecars are validated by {@link filterContentBlocks}
 * before being forwarded to the API. Blocks with unknown or missing `type`
 * fields are dropped to prevent replay of attacker-crafted blocks (#2003).
 *
 * **Pairing note (#2008):** PR #1996 removed `hasValidToolUsePairing` from this
 * function. Orphan `tool_use` blocks in `assistantContentBlocks`, i.e. blocks
 * with no corresponding `tool_result` in the following user turn, are passed
 * through **unchanged**. Pairing is not validated here. The caller is
 * responsible for detecting and healing any such gaps before the history is
 * forwarded to the Anthropic API. `repairOrphanToolUses` in
 * `query-turn-driver.ts` fulfils that role; it scans all assistant messages,
 * not just the tail, to cover the multi-turn resume case (see
 * `repair-orphan-tool-uses.ts` for details).
 *
 * **Skip-guard (#2112):** When both `filterContentBlocks(turn.userContentBlocks)`
 * and `turn.user` are empty, the user turn would silently be skipped. If the
 * assistant turn for the same `ResumeHistoryTurn` would produce content, this
 * creates consecutive assistant messages that violate the Anthropic API's
 * role-alternation contract. The `else` fallback below emits a minimal
 * `{ role: 'user', content: '[resumed]' }` placeholder in that case, preventing
 * the violation from being constructed here. `repairOrphanToolUses` /
 * `repairRoleAlternation` (PR #2112) remain the downstream safety net for any
 * violations that reach the API layer.
 */
export function resumeHistoryToMessages(history: ResumeHistoryTurn[] | undefined): MessageParam[] | undefined {
  if (!history || history.length === 0) return undefined;
  const messages: MessageParam[] = [];
  for (const turn of history) {
    // Compute assistant content first so the skip-guard below can inspect it
    // before deciding whether to emit a placeholder user message.
    const assistantBlocks = filterContentBlocks(turn.assistantContentBlocks);

    // User turn —— prefer structured blocks when present, else text fallback.
    const userBlocks = filterContentBlocks(turn.userContentBlocks);
    if (userBlocks.length > 0) {
      messages.push({ role: 'user', content: userBlocks });
    } else if (turn.user.length > 0) {
      messages.push({ role: 'user', content: turn.user });
    } else {
      // Defense-in-depth: never skip a user message when the assistant turn
      // would produce content, which would create consecutive assistant messages
      // violating the Anthropic API's role-alternation contract. The downstream
      // repairRoleAlternation pass in repairOrphanToolUses is the primary guard;
      // this prevents the violation from being constructed in the first place.
      if (assistantBlocks.length > 0 || turn.assistant.length > 0) {
        messages.push({ role: 'user', content: '[resumed]' });
      }
    }

    // Assistant turn —— prefer structured blocks when present, else text fallback.
    if (assistantBlocks.length > 0) {
      messages.push({ role: 'assistant', content: assistantBlocks });
    } else if (turn.assistant.length > 0) {
      messages.push({ role: 'assistant', content: turn.assistant });
    }
  }
  return messages.length > 0 ? messages : undefined;
}

/**
 * Block types that are NEVER safe to replay from a resumed session.
 *
 * - `thinking` / `redacted_thinking`: signatures are model-scoped and a
 *   resumed session may use a different model. The API rejects cross-model
 *   thinking blocks with HTTP 400 "thinking blocks require special handling."
 *   Stripping them is always correct because the prior-turn thinking is not
 *   required for the resumed session — the conversation text carries the
 *   conclusions.
 */
const STRIP_FROM_RESUME = new Set<string>(['thinking', 'redacted_thinking']);

/**
 * Validate and sanitize a `MessageParam[]` loaded from a stored sidecar for
 * use as `initialMessages` on resume.
 *
 * Applies three guards:
 *   1. **Role check** — only `'user'` and `'assistant'` roles are valid.
 *   2. **Block allowlist** — unknown block types are dropped via the same
 *      `filterContentBlocks` allowlist used by `resumeHistoryToMessages`.
 *   3. **Thinking strip** — `thinking` and `redacted_thinking` blocks are
 *      removed. Their signatures are model-scoped; resuming on a different
 *      model causes HTTP 400.
 *
 * Messages left empty after filtering (no role, no content) are dropped.
 * `repairOrphanToolUses` heals any orphan tail on the first resumed turn.
 *
 * Exported for unit testing.
 */
export function filterResumeMessages(raw: unknown): MessageParam[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const result: MessageParam[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const role = e['role'];
    if (role !== 'user' && role !== 'assistant') continue;

    const content = e['content'];
    if (typeof content === 'string') {
      if (content.length > 0) result.push({ role, content } as MessageParam);
    } else if (Array.isArray(content)) {
      // First filter to known block types, then strip thinking blocks.
      const filtered = filterContentBlocks(content).filter(
        (b) => !STRIP_FROM_RESUME.has(b.type),
      );
      if (filtered.length > 0) result.push({ role, content: filtered } as MessageParam);
    }
  }
  return result;
}

/**
 * Choose the provider's initial message array for a resumed session.
 *
 * Prefers the full-fidelity `resumeMessages` snapshot (validated by
 * {@link filterResumeMessages}); falls back to rebuilding from the per-turn
 * `resumeHistory` when the snapshot is absent or filters to nothing, so
 * sidecars written before the snapshot existed keep resuming.
 */
export function resolveInitialMessages(
  config: Pick<AgentConfig, 'resumeMessages' | 'resumeHistory'>,
): MessageParam[] | undefined {
  const snapshot = filterResumeMessages(config.resumeMessages);
  return snapshot.length > 0 ? snapshot : resumeHistoryToMessages(config.resumeHistory);
}

/** Effort levels at which Opus 5 rejects `{type:'disabled'}` thinking. */
const OPUS5_DISABLED_FORBIDDEN_EFFORTS = new Set<string>(['xhigh', 'max']);

/**
 * Models where `{type:'disabled'}` thinking is unconditionally forbidden: the
 * API returns HTTP 400 at every effort level. Only Claude Opus 5.5 is documented
 * this way. This is deliberately NOT `requiresAdaptiveThinking`: that predicate
 * means "rejects `enabled`", which does not imply "rejects `disabled`" (Opus
 * 4.7/4.8 and Sonnet 5 accept `disabled`). Claude Opus 5 rejects `disabled` only
 * at xhigh/max and is handled separately via OPUS5_DISABLED_FORBIDDEN_EFFORTS.
 */
const isAlwaysAdaptiveModel = (model: string): boolean => /(claude-)?opus-5[-.]5/.test(model);

/**
 * Translate our internal {@link ThinkingConfig} into the Anthropic SDK wire
 * shape, applying model-specific fixups.
 *
 * Fixups for the adaptive-thinking-only models — the `claude-opus-4-7+`
 * family and `claude-sonnet-5` (see `requiresAdaptiveThinking`):
 *  - `{type: 'enabled'}` is rejected by the API; auto-route to `'adaptive'`.
 *    Callers that explicitly request `enabled` on these models get adaptive
 *    behaviour so the request still clears the API's validation.
 *  - `{type: 'disabled'}` is rejected by the API on adaptive-only models
 *    (HTTP 400 at every effort level). A legible agent-afk error is thrown
 *    before the first request rather than forwarding an invalid wire shape.
 *    For Claude Opus 5 specifically, `disabled` is only forbidden at
 *    `xhigh`/`max` effort; lower efforts are allowed through (#2073).
 *  - `display: 'summarized'` is always injected on adaptive/enabled configs.
 *    On 4.7+ the default display mode is `'omitted'` (thinking blocks are
 *    produced server-side but stripped before delivery), so this field is
 *    *required* to surface visible reasoning.  On earlier models it is
 *    harmless — the server already defaults to visible delivery.
 *
 * @param effort The effective effort level resolved for this request (used to
 *   determine whether Opus 5 rejects `disabled` at this effort level).
 *
 * @throws when thinking resolves to `enabled` (non-adaptive model) and
 *   `maxTokens <= 1024`: no `budget_tokens` can satisfy the API's
 *   `1024 <= budget < max_tokens`, so the request is unsatisfiable and we fail
 *   fast with a legible message rather than taking a per-turn HTTP 400 (#951).
 * @throws when thinking is `disabled` on an adaptive-only model, or on
 *   Claude Opus 5 at `xhigh`/`max` effort, where the API rejects the
 *   combination with HTTP 400 (#2073).
 */
export function resolveThinkingParam(
  tc: ThinkingConfig,
  maxTokens: number,
  model?: string,
  effort?: string,
): ThinkingConfigParam {
  switch (tc.type) {
    case 'adaptive':
      // Cast: the SDK ThinkingConfigAdaptive shape doesn't declare `display`
      // yet, but the server honours it.  We use a type assertion to avoid
      // pulling in a beta-SDK type across the module boundary.
      return { type: 'adaptive', display: 'summarized' } as ThinkingConfigParam;

    case 'disabled': {
      const m = typeof model === 'string' ? model : '';
      // Unconditionally adaptive-only models (opus-5-5, sonnet-5, opus-4-7+):
      // the API rejects {type:'disabled'} at every effort level.
      if (m.length > 0 && isAlwaysAdaptiveModel(m)) {
        throw new Error(
          `[afk] ${m} uses adaptive thinking that cannot be disabled. ` +
            `Remove --thinking disabled / AFK_THINKING=disabled, or use a model ` +
            `that supports extended thinking control.`,
        );
      }
      // Claude Opus 5: rejects {type:'disabled'} at xhigh/max effort only.
      if (
        m.length > 0 &&
        /(claude-)?opus-5(?![-.]5)/.test(m) &&
        effort !== undefined &&
        OPUS5_DISABLED_FORBIDDEN_EFFORTS.has(effort)
      ) {
        throw new Error(
          `[afk] ${m} rejects thinking: {type: 'disabled'} at effort '${effort}'. ` +
            `Lower the effort (e.g. --effort high) or remove --thinking disabled.`,
        );
      }
      return { type: 'disabled' };
    }

    case 'enabled': {
      if (typeof model === 'string' && requiresAdaptiveThinking(model)) {
        // These models reject {type:'enabled'}; silently promote to adaptive.
        return { type: 'adaptive', display: 'summarized' } as ThinkingConfigParam;
      }
      // Contract: the Messages API requires `1024 <= budget_tokens < max_tokens`
      // for enabled thinking. That interval is empty once `max_tokens <= 1024`
      // (the 1024 floor can no longer satisfy the strict `< max_tokens` upper
      // bound), so no valid budget exists — unlike the over-ceiling case there
      // is nothing to clamp *to*. Fail fast with a legible error naming both
      // escape hatches instead of emitting `budget_tokens == max_tokens` and
      // taking an opaque HTTP 400 on every turn (#951). Reachable by default,
      // not opt-in: `--thinking` defaults to `enabled:max` on both `afk chat`
      // and `afk interactive`, so the real trigger is an explicit output cap
      // <= 1024 — `--max-output-tokens` or a stale `AFK_MAX_OUTPUT_TOKENS` —
      // on a non-adaptive model (haiku, fable-5, raw sonnet-4-6); opus-5 and
      // sonnet-5 still route to adaptive above regardless of the cap.
      if (maxTokens <= 1024) {
        throw new Error(
          `[afk] Extended thinking requires max_tokens > 1024 (the API constraint is ` +
            `1024 <= budget_tokens < max_tokens), but the resolved output cap is ${maxTokens}. ` +
            `Raise --max-output-tokens / AFK_MAX_OUTPUT_TOKENS above 1024, or disable thinking ` +
            `with --thinking disabled.`,
        );
      }
      // Thinking tokens share the `max_tokens` budget, so reserve a slice for
      // the visible reply and cap the thinking budget to fit. The cap applies
      // to caller-supplied budgets too — an oversized explicit budget is
      // clamped (with a one-time warning) rather than honoured blindly.
      // `budget_tokens` must satisfy 1024 <= budget < max_tokens; the guard
      // above guarantees `max_tokens > 1024`, so the 1024 floor here always
      // clears the strict upper bound.
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
 *  2. For `opus-4-6`, `opus-4-7`, `opus-4-8`, `opus-5`, `sonnet-4-6`,
 *     `sonnet-4-7`, and `sonnet-5` (current and recent non-Haiku Claude
 *     models), default to
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
  // Opus 5.5 (released 2026-09-22): server default is `medium` (the only
  // model where the default is not `high`). We raise to `high` for agentic
  // coding depth without the excessive thinking-token accumulation that `max`
  // causes on this model. Must be checked BEFORE the general opus/sonnet-5
  // regex below, which would otherwise match `opus-5` as a substring of
  // `opus-5-5` and return `max`.
  if (/(claude-)?opus-5-5/.test(m)) return 'high';
  // Allowlist: `4-6`/`4-7`/`4-8` opus & sonnet variants plus Sonnet 5 and
  // Opus 5 accept `output_config.effort` (4.x variants probed via
  // scripts/probe-effort-{all-models,older}.mjs against the OAuth identity;
  // Sonnet 5 / Opus 5 documented to accept `effort` with a `high` server
  // default — we keep `max` for high thinking depth). Earlier minor versions —
  // 4-1, 4-5 sonnet, 4-5 opus, and every Haiku — return HTTP 400
  // "This model does not support the effort parameter." Caller-supplied
  // effort still flows through unchanged so explicit overrides fail loudly
  // rather than silently ignoring, but auto-default is gated tightly.
  if (/(claude-)?(opus|sonnet)-(4-[678]|5)/.test(m)) return 'max';
  return undefined;
}

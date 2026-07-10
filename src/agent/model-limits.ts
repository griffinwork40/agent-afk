/**
 * Per-model token caps:
 *   - `MODEL_MAX_OUTPUT_TOKENS` / `maxOutputTokensFor` — the Messages-API
 *     `max_tokens` ceiling, resolved by `session/query-options.ts` against
 *     the `'max'` sentinel.
 *   - `MODEL_CONTEXT_LIMITS` / `contextLimitFor` — the full context-window
 *     size, used by the provider's `getContextUsage()` to compute a
 *     percentage and by the CLI status line to format the "of N" suffix.
 *
 * Both live in the agent layer so providers can look them up without
 * reaching back into CLI code; CLI consumers re-export from
 * `src/cli/model-limits.ts` for backward compatibility.
 *
 * @module agent/model-limits
 */

import type { ClaudeModel } from './types.js';
import { resolveModelInput } from './session/model-slots.js';
import { isOSeriesModel } from './model-capabilities.js';

/**
 * Keys cover both short aliases (`opus`, `sonnet`, `haiku`, `*_1m`) and the
 * full model IDs `resolveModelId` emits, so lookups work either side of the
 * alias boundary. Unknown models fall back to a conservative 64k — the
 * smaller of the documented 2026-Q1 caps, safe if the user passes an
 * unfamiliar proxy-keyed model string.
 */
export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  opus: 128_000,
  opus_1m: 128_000,
  sonnet: 128_000,
  sonnet_1m: 128_000,
  haiku: 64_000,
  fable: 128_000,
  'claude-opus-4-8': 128_000,
  // 'claude-opus-4-7' removed — retired model; MODEL_MAP.opus now points to
  // claude-opus-4-8. Kept here as a comment so git blame reveals the removal.
  // (Prior retirement: 'claude-opus-4-6' → 4-7 on 2026-04, then 4-7 → 4-8 on
  // 2026-05-28.)
  // Claude Sonnet 5 (GA 2026-06): 128k max output (up from 64k on Sonnet 4.6).
  'claude-sonnet-5': 128_000,
  'claude-haiku-4-5-20251001': 64_000,
  // Claude Fable 5 (Mythos-class, GA 2026-06-09): 128k max output.
  'claude-fable-5': 128_000,
} as const;

const DEFAULT_MAX_OUTPUT = 64_000;

/**
 * Look up the max-output-tokens cap for a given model identifier.
 * Accepts short aliases and full IDs; unknown models fall back to 64k.
 */
export function maxOutputTokensFor(model: ClaudeModel | string): number {
  const lowered = String(model).trim().toLowerCase();
  // Preserve explicit *_1m aliases (a context-window choice) before resolution.
  const oneM = MODEL_MAX_OUTPUT_TOKENS[lowered];
  if (lowered.endsWith('_1m') && oneM !== undefined) return oneM;
  // Resolve slot alias → bound id so a rebound tier gets the correct cap.
  const id = resolveModelInput(model) ?? String(model);
  return (
    MODEL_MAX_OUTPUT_TOKENS[id] ??
    MODEL_MAX_OUTPUT_TOKENS[id.toLowerCase()] ??
    DEFAULT_MAX_OUTPUT
  );
}

/**
 * Per-model context-window limits.
 *
 * Lookup falls back per-provider when the model isn't listed:
 *   - Anthropic-routed models (no slash, no gpt/o/codex prefix) get 200k.
 *     Every published Claude model uses at least 200k, so this errs on the
 *     side of accurate percentages for unknown short aliases.
 *   - openai-compatible-routed models (HF-style `org/model`, or gpt/o/codex
 *     prefix) get 256k. Local OpenAI-shim runners (MLX, llama.cpp, vLLM,
 *     ollama-openai) mostly serve modern long-context models -- Qwen3.5/3.6
 *     ships 256k native, Llama-3.x sits at 128k, gpt-4.1 hits 1M -- so 256k
 *     is a closer median than the 200k Claude fallback. Known OpenAI-branded
 *     models are listed explicitly below; only unknown HF-style and
 *     gpt/o/codex models hit this fallback.
 *
 * See `DEFAULT_CONTEXT_LIMIT_OPENAI_COMPATIBLE` and
 * `routesToOpenAICompatible` below.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude aliases
  opus: 200_000,
  opus_1m: 1_000_000,
  // Sonnet 5 ships a 1M-token context window natively (like Fable 5) — no beta
  // header required: per Anthropic's docs 1M is both the default and the maximum,
  // with no smaller variant. The `sonnet` alias, the `sonnet_1m` alias, and the
  // `claude-sonnet-5` wire id all report the full 1M window. Base `sonnet` still
  // auto-compacts early for cost/latency (see MODEL_AUTOCOMPACT_BUDGET /
  // autoCompactLimitFor below) — that is a compaction policy, NOT a smaller window.
  sonnet: 1_000_000,
  sonnet_1m: 1_000_000,
  haiku: 200_000,
  // Native 1M-context models (no `_1m` opt-in, unlike opus/haiku whose base
  // window is 200k). Keyed by both the short alias (where one exists) and the
  // wire id so lookups hit either side of the alias boundary.
  fable: 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  // OpenAI flagship + cost-tier models (windows per OpenAI platform docs
  // as of 2026-Q1). Listed here so the openai-compatible provider's
  // getContextUsage() returns an accurate percentage instead of the
  // openai-compatible fallback below.
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  // OpenAI GPT-5.6 family (GA 2026-07-09). The `gpt-5.6` alias routes to
  // `gpt-5.6-sol` (flagship); `-terra` is the balanced tier and `-luna` the
  // high-volume tier. All ship the flagship 5.x ~1.05M-token window (rounded to
  // 1M here to match the gpt-4.1 / gpt-5.5 convention above). Keyed by the alias
  // and all three variant ids so getContextUsage() reports an accurate percentage
  // regardless of which id the user pins. gpt-5.5 is included as the prior
  // flagship (the ChatGPT/Codex backend baseline) so it stops falling through to
  // the 262k openai-compatible default.
  'gpt-5.5': 1_000_000,
  'gpt-5.6': 1_000_000,
  'gpt-5.6-sol': 1_000_000,
  'gpt-5.6-terra': 1_000_000,
  'gpt-5.6-luna': 1_000_000,
  // OpenAI reasoning models — o-series. All 200k context windows except
  // o1-mini (128k).
  o1: 200_000,
  'o1-mini': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  // mlx-community local models served via MLX LM's OpenAI-compatible shim
  // (AFK_OPENAI_BASE_URL=http://localhost:8080/v1 AFK_MODEL=mlx-community/…).
  // Context windows per mlx-community model cards (2025-Q2). Without these
  // entries, contextLimitFor() falls back to DEFAULT_CONTEXT_LIMIT_OPENAI_COMPATIBLE
  // (262k), which exceeds the actual 128k window and silently allows overruns.
  'mlx-community/qwen3-30b-a3b-4bit': 128_000,
  'mlx-community/qwen3-32b-4bit': 128_000,
  'mlx-community/qwen2.5-coder-32b-instruct-4bit': 131_072,
} as const;

const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_CONTEXT_LIMIT_OPENAI_COMPATIBLE = 262_144;

/**
 * Mirror of the openai-compatible branch of
 * `providers/index.ts:providerForModel`. Kept inline (rather than imported)
 * to avoid a `model-limits.ts` ↔ `providers/index.ts` cycle —
 * `providers/openai-compatible/query.ts` imports `contextLimitFor` from
 * this module, and `providers/index.ts` re-exports `OpenAICompatibleProvider`.
 *
 * If the routing rules in `providers/index.ts` change, update this predicate
 * in lock-step. `routing.test.ts` covers the provider router; the fallback
 * cases below in this module's test cover this predicate.
 */
function routesToOpenAICompatible(model: string): boolean {
  if (!model) return false;
  const lowered = model.trim().toLowerCase();
  if (!lowered) return false;
  // HuggingFace-style `org/model` ids (mlx-community/…, Qwen/…, TheBloke/…)
  // are served exclusively by local OpenAI-shim runners.
  if (lowered.includes('/')) return true;
  if (lowered.startsWith('gpt-') || lowered.startsWith('gpt_')) return true;
  if (isOSeriesModel(lowered)) return true;
  if (lowered.startsWith('codex-') || lowered.startsWith('codex_') || lowered === 'codex') return true;
  return false;
}

/**
 * Look up the context-window limit for a given model identifier.
 *
 * Accepts both the short ClaudeModel aliases and arbitrary model strings.
 * Unknown models fall back per-provider:
 *   - openai-compatible-routed (HF-style or gpt/o/codex prefix): 256k
 *   - everything else (Anthropic): 200k
 */
export function contextLimitFor(model: ClaudeModel | string): number {
  const lowered = String(model).trim().toLowerCase();
  // Preserve explicit *_1m aliases (1M context window) before resolution.
  const oneM = MODEL_CONTEXT_LIMITS[lowered];
  if (lowered.endsWith('_1m') && oneM !== undefined) return oneM;
  // Resolve slot alias → bound id, then look up the concrete id. A lowercased
  // fallback lets mixed-case HF-style ids (e.g.
  // "mlx-community/Qwen3-30B-A3B-4bit") still hit their entry.
  const id = resolveModelInput(model) ?? String(model);
  const known = MODEL_CONTEXT_LIMITS[id] ?? MODEL_CONTEXT_LIMITS[id.toLowerCase()];
  if (known !== undefined) return known;
  return routesToOpenAICompatible(id)
    ? DEFAULT_CONTEXT_LIMIT_OPENAI_COMPATIBLE
    : DEFAULT_CONTEXT_LIMIT;
}

/**
 * Per-model auto-compaction working budget (absolute tokens).
 *
 * Sonnet 5 ships a truthful 1M window, but resending the whole conversation
 * prefix every turn on a long DEFAULT session is slow and expensive. So base
 * `sonnet` triggers auto-compaction around a smaller working budget rather than
 * at `threshold × 1M`. This is a deliberate cost/latency policy, NOT a claim
 * about the window (`MODEL_CONTEXT_LIMITS` stays truthful at 1M): the full
 * window is one `sonnet_1m` away (the `_1m` opt-in bypasses the budget), or the
 * user can raise the `autoCompact` threshold. Keyed by the resolved wire id so
 * both the `sonnet` alias and a literal `claude-sonnet-5` requestedModel hit it.
 */
const MODEL_AUTOCOMPACT_BUDGET: Record<string, number> = {
  'claude-sonnet-5': 200_000,
};

/**
 * Token limit at which auto-compaction should trigger for a model: its context
 * window, capped by its {@link MODEL_AUTOCOMPACT_BUDGET} entry when one exists.
 * Used ONLY by the turn loop's auto-compaction check — the status-line /
 * percentage path uses {@link contextLimitFor} (the true window). Mirrors
 * `contextLimitFor`'s alias handling: an explicit `*_1m` opt-in always uses the
 * full window, never the reduced budget. Models with no budget entry return
 * their full window (identical to the pre-budget behavior).
 */
export function autoCompactLimitFor(model: ClaudeModel | string): number {
  const window = contextLimitFor(model);
  const lowered = String(model).trim().toLowerCase();
  // Explicit *_1m opt-in → full window, never the reduced default budget.
  if (lowered.endsWith('_1m')) return window;
  const id = resolveModelInput(model) ?? String(model);
  const budget = MODEL_AUTOCOMPACT_BUDGET[id] ?? MODEL_AUTOCOMPACT_BUDGET[id.toLowerCase()];
  return budget !== undefined ? Math.min(window, budget) : window;
}

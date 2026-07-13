/**
 * Per-model capability detection. Currently just vision (image input).
 *
 * Sibling to `model-limits.ts` (token caps) — kept separate because vision is a
 * different axis from context/output limits. Consulted by the openai-compatible
 * provider to decide whether to forward image content as native multimodal
 * parts or degrade to a text notice (issue #127). The anthropic-direct provider
 * does NOT consult this: every current Claude model is vision-capable, so it
 * passes images through unconditionally.
 *
 * Resolution for `supportsVision`:
 *   1. Force-disable override — an `AFK_VISION_MODELS` token prefixed with `!`.
 *   2. Force-enable override  — any other `AFK_VISION_MODELS` token (exact id
 *      or substring). This is the escape hatch for local vision-language models
 *      we don't recognise by name.
 *   3. Built-in allowlist — exact ids + family regex patterns.
 *   4. Default `false` — degrade gracefully. Sending images to an endpoint that
 *      can't take them risks a hard 400; a text notice never does and always
 *      informs the user.
 *
 * Aliases (`local`/`small`/`medium`/`large`, `opus`/`sonnet`/`haiku`, `fable`) are
 * resolved to their bound concrete id first, so capability follows the resolved
 * model — a tier rebound to a text-only id degrades, as it should.
 *
 * @module agent/model-capabilities
 */

import { env } from '../config/env.js';
import { resolveModelInput } from './session/model-slots.js';

/**
 * Exact model ids known to accept image input. Mirrors the maintained-table
 * pattern of `MODEL_CONTEXT_LIMITS`. The `-mini` reasoning variants are listed
 * individually because vision is NOT uniform across them: `o4-mini` has vision,
 * but `o1-mini` and `o3-mini` are text-only (deliberately absent).
 */
const VISION_MODEL_IDS: ReadonlySet<string> = new Set([
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4-turbo',
  'o1',
  'o3',
  'o4-mini',
]);

/**
 * Model-id family patterns that accept image input. Covers OpenAI's flagship
 * multimodal line (whose exact cost-tier suffixes drift) and the common local
 * vision-language model families served by OpenAI-shim runners (MLX, llama.cpp,
 * vLLM). Conservative by design: a miss degrades gracefully and is recoverable
 * via `AFK_VISION_MODELS`.
 */
const VISION_MODEL_PATTERNS: readonly RegExp[] = [
  // Anthropic — every current Claude model is vision-capable.
  /^claude-/i,
  // OpenAI flagship multimodal + gpt-5.x line.
  /^gpt-4o/i,
  /^gpt-4\.1/i,
  /^gpt-4-turbo/i,
  /^gpt-4-vision/i,
  /^gpt-5/i,
  // Short, ambiguous tokens need delimiters on BOTH sides so "vllm" (a runner,
  // not a model) does NOT false-positive on the bare "vl".
  /(?:^|[/_-])(?:vl|vlm)(?:[/_.-]|$)/i,
  // Unambiguous vision-language family names need only a leading delimiter (a
  // trailing version digit like "internvl2" must still match).
  /(?:^|[/_-])(?:llava|pixtral|internvl|cogvlm|idefics|moondream|janus)/i,
  // Looser family tokens that are unambiguous anywhere in the id.
  /(?:vision|minicpm-?[vo]|qwen[\d.]*-?vl|llama-?3\.2-\d+b-vision|gemma-3|phi-3\.5-vision|phi-4-multimodal)/i,
];

interface VisionOverrides {
  enable: string[];
  disable: string[];
}

/**
 * Parse `AFK_VISION_MODELS` (comma-separated). A leading `!` marks a
 * force-disable token; everything else is a force-enable token. Tokens are
 * lower-cased; matching is exact-or-substring against the resolved id.
 */
function parseVisionOverrides(): VisionOverrides {
  const raw = env.AFK_VISION_MODELS;
  const enable: string[] = [];
  const disable: string[] = [];
  if (raw) {
    for (const token of raw.split(',')) {
      const t = token.trim().toLowerCase();
      if (!t) continue;
      if (t.startsWith('!')) {
        const inner = t.slice(1).trim();
        if (inner) disable.push(inner);
      } else {
        enable.push(t);
      }
    }
  }
  return { enable, disable };
}

function overrideMatches(loweredId: string, token: string): boolean {
  return loweredId === token || loweredId.includes(token);
}

/**
 * Does `model` accept image (vision) input? See module docstring for the full
 * resolution order. Accepts slot aliases and full ids; unknown models return
 * `false` so the caller degrades gracefully.
 */
export function supportsVision(model: string | undefined): boolean {
  if (!model) return false;
  const resolved = (resolveModelInput(model) ?? model).trim();
  if (!resolved) return false;
  const lowered = resolved.toLowerCase();

  const { enable, disable } = parseVisionOverrides();
  // Force-disable wins so a user can blacklist a mis-detected id.
  if (disable.some((t) => overrideMatches(lowered, t))) return false;
  if (enable.some((t) => overrideMatches(lowered, t))) return true;

  if (VISION_MODEL_IDS.has(lowered)) return true;
  return VISION_MODEL_PATTERNS.some((re) => re.test(resolved));
}

/**
 * Normalize a model id for family matching: strip a leading `provider/` segment
 * (OpenRouter-style ids such as `openai/o3`) and lower-case + trim it. Shared by
 * the family predicates below so `openai/o3`, `  O3  `, and `o3` all classify
 * identically. Because the result is already lower-cased, the predicates' regex
 * patterns do not need the `/i` flag.
 */
function bareModelId(model: string): string {
  const trimmed = model.trim().toLowerCase();
  return trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
}

/**
 * Detect OpenAI o-series reasoning models — o1, o3, o4, and any future `oN`.
 *
 * This is the *id-family* predicate — it answers "is this an o-series id?" — and
 * is the single source of truth consumed by the provider router
 * (`providers/index.ts`) and token sizing (`model-limits.ts`) to route bare
 * o-series ids to the openai-compatible provider. For the *request contract*
 * (which token field / effort param to send) use {@link isReasoningModel}, a
 * superset that also covers the gpt-5.x models OpenAI names as the o-series
 * replacements.
 *
 * Robustness the enumerated `startsWith('o1'|'o3'|'o4')` copies lacked:
 *   - matches ANY `o<digit>` prefix, so o5/o6/… are covered without edits;
 *   - strips a leading `provider/` segment (OpenRouter-style ids) so
 *     `openai/o3` and `openrouter/o1-mini` classify correctly;
 *   - case-insensitive.
 *
 * Note: unlike `supportsVision`, this does NOT resolve slot aliases — o-series
 * ids arrive as concrete strings (there is no `o3` alias), so it stays a pure
 * string predicate with no `resolveModelInput` dependency.
 */
export function isOSeriesModel(model: string | undefined): boolean {
  if (!model) return false;
  return /^o[0-9]/.test(bareModelId(model));
}

/**
 * Reasoning-model id families *beyond* the o-series (which {@link isOSeriesModel}
 * already covers). These speak OpenAI's reasoning request contract on Chat
 * Completions: they reject `max_tokens` (requiring `max_completion_tokens`) and
 * accept `reasoning_effort` — the inverse of the classic chat models (gpt-4o,
 * gpt-4.1, …) which want `max_tokens` and ignore effort.
 *
 * Kept as a data table (not an enumerated `||` chain) so a new reasoning family
 * — a future gpt-6, say — is a one-line addition that propagates to every
 * request-shaping call site at once. Patterns run against the provider-stripped,
 * lower-cased id from {@link bareModelId}, so no `/i` flag is needed.
 */
const REASONING_MODEL_PATTERNS: readonly RegExp[] = [
  /^gpt-5/, // gpt-5.x line: gpt-5, gpt-5.1, gpt-5.5, gpt-5-mini, gpt-5-codex, …
];

/**
 * Detect OpenAI reasoning models — the o-series (o1/o3/o4/oN) *and* the gpt-5.x
 * line — i.e. every model that requires the `max_completion_tokens` +
 * `reasoning_effort` request contract rather than plain `max_tokens`.
 *
 * Single source of truth for request shaping in the openai-compatible provider:
 * `query/model-params.ts` (`resolveStreamingMaxTokens`, `resolveReasoningEffort`)
 * and `oneshot.ts`. A superset of {@link isOSeriesModel}: every o-series id is a
 * reasoning model, but so are the gpt-5.x ids that replace them. Extend the
 * non-o-series families via {@link REASONING_MODEL_PATTERNS}.
 */
export function isReasoningModel(model: string | undefined): boolean {
  if (!model) return false;
  if (isOSeriesModel(model)) return true;
  const bare = bareModelId(model);
  return REASONING_MODEL_PATTERNS.some((re) => re.test(bare));
}

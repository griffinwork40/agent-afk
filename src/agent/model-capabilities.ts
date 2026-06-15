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
 * Aliases (`small`/`medium`/`large`, `opus`/`sonnet`/`haiku`, `fable`) are
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

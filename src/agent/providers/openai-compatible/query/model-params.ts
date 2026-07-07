/**
 * Model-shape parameter helpers for the openai-compatible provider: output-
 * token cap resolution, o-series detection, and effort→reasoning_effort
 * mapping. Pure functions extracted from `query.ts` so the query module
 * carries only the session class and its turn loop.
 *
 * @module agent/providers/openai-compatible/query/model-params
 */

import type { EffortLevel } from '../../../types/sdk-types.js';
import { maxOutputTokensFor } from '../../../model-limits.js';
import { isOSeriesModel } from '../../../model-capabilities.js';

/**
 * Resolve the effective output-token cap (a plain number).
 *
 * Honours `config.maxOutputTokens` when finite+positive, otherwise falls back
 * to the model's output ceiling (matching Anthropic's resolveMaxTokens).  Uses
 * maxOutputTokensFor (output ceiling), not contextLimitFor (context window),
 * because the cap bounds *output*, not the full context window.
 *
 * Field-name selection (`max_tokens` vs `max_completion_tokens` vs
 * `max_output_tokens`) is the caller's concern — it differs by wire mode:
 * Chat Completions uses {@link resolveStreamingMaxTokens}; the Responses API
 * uses `max_output_tokens` directly.
 */
export function resolveEffectiveMaxOutputTokens(
  model: string,
  configMaxOutput: number | undefined,
): number {
  const ceiling = maxOutputTokensFor(model);
  return typeof configMaxOutput === 'number' && Number.isFinite(configMaxOutput) && configMaxOutput > 0
    ? Math.floor(configMaxOutput)
    : ceiling;
}

/**
 * Resolve the **Chat Completions** streaming output-token cap.
 *
 * Mirrors the o-series field-selection logic in `oneshot.ts:91–96`:
 * o-series reasoning models (o1/o3/o4…) reject `max_tokens` and require
 * `max_completion_tokens`; everything else (chat models, local shims)
 * wants `max_tokens`.  (The Responses API is different again — it uses
 * `max_output_tokens` — so this helper is Chat-Completions-only.)
 *
 * Always returns an object containing the resolved cap; uses the model's
 * output ceiling as a fallback so the field is always present on the wire.
 */
export function resolveStreamingMaxTokens(
  model: string,
  configMaxOutput: number | undefined,
): Record<string, number> {
  const effectiveMax = resolveEffectiveMaxOutputTokens(model, configMaxOutput);
  return isOSeriesModel(model)
    ? { max_completion_tokens: effectiveMax }
    : { max_tokens: effectiveMax };
}

export function normalizePermissionMode(mode: string | undefined): string {
  return mode ?? 'default';
}

/**
 * Re-exported for backward compatibility — `query.ts` re-exports it and older
 * call sites import it from here. Canonical definition (incl. o5+/`oN` and
 * `provider/`-prefix handling) now lives in `model-capabilities.ts`.
 */
export { isOSeriesModel };

/**
 * Map AFK's `EffortLevel` to OpenAI's `reasoning_effort` values.
 * OpenAI accepts `low`, `medium`, `high`. AFK's `xhigh` and `max` are
 * Anthropic-specific and map to `high` for OpenAI.
 */
export function mapEffortForOpenAI(effort: EffortLevel): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
  }
}

/**
 * Resolve the `reasoning_effort` to send for a given model + effort config.
 * Returns `undefined` when effort should not be forwarded (non-o-series model
 * or no effort configured). Callers attach the result to the request body
 * under `reasoning_effort` (Chat Completions) or `reasoning.effort` (Responses).
 */
export function resolveReasoningEffort(
  effort: EffortLevel | undefined,
  model: string,
): 'low' | 'medium' | 'high' | undefined {
  if (effort === undefined) return undefined;
  if (!isOSeriesModel(model)) return undefined;
  return mapEffortForOpenAI(effort);
}

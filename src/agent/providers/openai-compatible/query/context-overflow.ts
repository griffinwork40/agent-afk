/**
 * Context-overflow pre-flight guard for the openai-compatible provider (#962).
 *
 * Wraps `guardContextOverflow` from shared/auto-compact into a caller-friendly
 * helper that returns an Error on overflow and null otherwise, so the turn
 * driver can yield the error and return cleanly without a naked try/catch block
 * inline. Extracted from query.ts to keep that file within its line ceiling.
 *
 * @module agent/providers/openai-compatible/query/context-overflow
 */

import { guardContextOverflow, contextWindowTokensUsed } from '../../shared/auto-compact.js';
import { contextLimitFor } from '../../../model-limits.js';
import { resolveEffectiveMaxOutputTokens } from './model-params.js';
import type { ProviderUsage } from '../../../provider.js';

/**
 * Run the context-overflow guard for a pending turn.
 *
 * Returns null when the turn is safe to send, or an Error when
 * `lastUsage.input_tokens + max_tokens > contextWindow` — meaning the provider
 * would reject the request with HTTP 400. The caller should yield the error and
 * return without sending the request.
 *
 * Uses the stale-by-one-round `lastUsage` as a conservative lower bound:
 * - Skips the first turn (lastUsage === null) — no prior usage to check against.
 * - Never silently shrinks max_tokens; prefers a loud failure over a silent one.
 *
 * @param lastUsage - Usage from the previous turn, or null on the first turn.
 * @param currentModel - Resolved model identifier for this turn.
 * @param maxOutputTokens - Optional configured output-token cap.
 * @param configuredModel - The model string from config (for error messages).
 */
export function checkContextOverflow(
  lastUsage: Partial<ProviderUsage> | null,
  currentModel: string,
  maxOutputTokens: number | undefined,
  configuredModel: string,
): Error | null {
  try {
    guardContextOverflow(
      contextWindowTokensUsed(lastUsage ?? {}),
      resolveEffectiveMaxOutputTokens(currentModel, maxOutputTokens),
      contextLimitFor(currentModel),
      configuredModel,
    );
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

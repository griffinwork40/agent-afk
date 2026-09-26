/**
 * Factory for the `CompleteFn` used by predict, compile, discover, and the
 * Claude judge.
 *
 * Wraps `oneShotCompletion` (the shared one-shot helper in the Anthropic
 * provider) so the rest of `src/whatif/` never imports the SDK directly —
 * only `src/agent/providers/` is allowed to do that.
 *
 * Cost estimation: `oneShotCompletion` returns only the text response, not
 * token counts. We estimate tokens from character counts using a rough
 * 3.5 chars/token ratio and pass the estimates to `deriveCallCostUsd`.
 * This is an approximation; real costs may differ by ±30%.
 *
 * @module whatif/complete
 */

import { oneShotCompletion } from '../agent/providers/anthropic-direct/oneshot.js';
import { deriveCallCostUsd } from '../agent/providers/anthropic-direct/pricing.js';
import type { CompleteFn } from './types.js';
import { withAnalystRetry } from './complete.retry.js';
import { resolveModelId } from '../agent/session/model-resolution.js';

/** Characters-per-token ratio used for cost estimation (rough heuristic). */
const CHARS_PER_TOKEN = 3.5;

/**
 * Create a `CompleteFn` backed by `oneShotCompletion`.
 *
 * Cost is estimated from character counts — documented as an approximation.
 * Callers should treat `costUsd` as a guide for budget tracking, not billing.
 */
export function createAnthropicComplete(token: string): CompleteFn {
  return async (req) => {
    const { system, user, maxTokens, model, signal } = req;

    const text = await withAnalystRetry(
      () => oneShotCompletion({ token, model, system, user, maxTokens, signal }),
      signal !== undefined ? { signal } : {},
    );

    // Estimate token counts from character lengths (3.5 chars per token).
    const inputChars = system.length + user.length;
    const outputChars = text.length;
    const inputTokens = Math.round(inputChars / CHARS_PER_TOKEN);
    const outputTokens = Math.round(outputChars / CHARS_PER_TOKEN);

    // `deriveCallCostUsd` returns undefined for unknown models; fall back to 0.
    const costUsd =
      deriveCallCostUsd(resolveModelId(model) ?? model, inputTokens, outputTokens, 0, 0) ?? 0;

    return { text, costUsd };
  };
}

/**
 * Per-round context-window footprint for the openai-compatible turn driver.
 *
 * Extracted from turn-driver.ts so the carry-forward rule is a pure, directly
 * testable function instead of inline arithmetic a test has to copy.
 *
 * @module agent/providers/openai-compatible/query/turn-driver.context-window
 */

import type { ProviderUsage } from '../../../provider.js';
import { contextWindowTokensUsed } from '../../shared/context-usage-fields.js';

/**
 * Context-window footprint to record for one round.
 *
 * Contract:
 * - Round carried usage → `input + output` for that round. OpenAI's
 *   `prompt_tokens` already includes cached tokens, so this is the window size
 *   (not cumulative across rounds).
 * - Round carried no usage (a stream accepted after a drop before the trailing
 *   usage chunk arrived, #2780) → the last known footprint, never 0. Writing 0
 *   would disable the context-overflow guard and auto-compaction on the next
 *   turn. The last known value goes through {@link contextWindowTokensUsed} so a
 *   resume seed carrying only `inputTokens` (no `contextWindowTokens`) still
 *   counts.
 * - No usage and no prior footprint → 0 (nothing better is known).
 */
export function roundContextWindowTokens(
  roundUsage: Partial<ProviderUsage>,
  lastUsage: Partial<ProviderUsage> | null | undefined,
): number {
  if (roundUsage.inputTokens !== undefined || roundUsage.outputTokens !== undefined) {
    return (roundUsage.inputTokens ?? 0) + (roundUsage.outputTokens ?? 0);
  }
  return lastUsage ? contextWindowTokensUsed(lastUsage) : 0;
}

import type { Usage } from '@anthropic-ai/sdk/resources';
import type { ProviderUsage } from '../../provider.js';
import { deriveCallCostUsd, type AnthropicSpeed } from './pricing.js';

/** Narrowly accept only the speed values documented by Anthropic. */
function observedSpeed(usage: Usage): AnthropicSpeed | undefined {
  const value = (usage as unknown as { speed?: unknown }).speed;
  return value === 'fast' || value === 'standard' ? value : undefined;
}

/** Normalize one Anthropic call's usage while retaining provider diagnostics. */
export function toProviderUsage(
  usage: Usage | null,
  stopReason: string | null,
  model?: string,
  requestSpeed?: AnthropicSpeed,
): ProviderUsage {
  if (!usage) return { stopReason: stopReason ?? null };

  const responseSpeed = observedSpeed(usage);
  const out: ProviderUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    stopReason: stopReason ?? null,
    raw: { ...(usage as unknown as Record<string, unknown>), ...(responseSpeed ? { speed: responseSpeed } : {}) },
  };
  if (usage.cache_read_input_tokens != null) out.cachedInputTokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) out.cacheCreationTokens = usage.cache_creation_input_tokens;
  out.totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

  if (model) {
    const cost = deriveCallCostUsd(
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      { ...(requestSpeed ? { requestSpeed } : {}), ...(responseSpeed ? { responseSpeed } : {}) },
    );
    if (cost !== undefined) out.totalCostUsd = cost;
  }
  return out;
}

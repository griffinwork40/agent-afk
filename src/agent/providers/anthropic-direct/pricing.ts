export type AnthropicSpeed = 'standard' | 'fast';
interface ModelPricing { inputPerMTok: number; outputPerMTok: number; cacheWritePerMTok?: number; cacheReadPerMTok?: number }
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map([
  ['claude-sonnet-5', { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: .3 }],
  ['claude-opus-5', { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: .5 }],
  ['claude-sonnet-4-5-20250929', { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: .3 }],
  ['claude-opus-4-5-20250929', { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 }],
  ['claude-haiku-4-5-20250929', { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: .1 }],
  ['claude-haiku-4-5-20251001', { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: .1 }],
  ['claude-3-7-sonnet-20250219', { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: .3 }],
  ['claude-3-5-sonnet-20241022', { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: .3 }],
  ['claude-3-5-sonnet-20240620', { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: .3 }],
  ['claude-3-5-haiku-20241022', { inputPerMTok: .8, outputPerMTok: 4, cacheWritePerMTok: 1, cacheReadPerMTok: .08 }],
  ['claude-3-opus-20240229', { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 }],
  ['claude-3-sonnet-20240229', { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: .3 }],
  ['claude-3-haiku-20240307', { inputPerMTok: .25, outputPerMTok: 1.25, cacheWritePerMTok: .3, cacheReadPerMTok: .03 }],
]);

export interface SpeedPricingContext { responseSpeed?: AnthropicSpeed; requestSpeed?: AnthropicSpeed }
export function deriveCallCostUsd(model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheCreationTokens: number, speed: SpeedPricingContext = {}): number | undefined {
  const standard = MODEL_PRICING.get(model); if (!standard) return undefined;
  const selected = speed.responseSpeed ?? speed.requestSpeed ?? 'standard';
  const pricing = selected === 'fast' && /^claude-opus-(?:5|4-8)(?:-|$)/.test(model)
    ? { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 1 }
    : standard;
  const plainInput = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens);
  return (plainInput * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok + cacheCreationTokens * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok * 1.25) + cachedInputTokens * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok * .1)) / 1_000_000;
}

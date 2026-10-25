/**
 * #3878 billing-normalized usage: construction per provider, cross-round
 * summation, the ResponseMetadata wire round-trip, and the guardrail that the
 * legacy `ProviderUsage` fields (summed input, latest-round cache, cost) are
 * unchanged by the additive `billing` field.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Usage } from '@anthropic-ai/sdk/resources';
import {
  anthropicBilling,
  billingFromUsageRecord,
  billingLifecycleFields,
  billingToUsageFields,
  openAICompatibleBilling,
  sumBillingUsage,
} from './usage.billing.js';
import { sumProviderUsage } from './usage.js';
import { toProviderUsage } from './providers/anthropic-direct/usage.js';
import { usageFromState } from './providers/openai-compatible/translate.js';
import { deriveCallCostUsdWithTier } from './providers/openai-compatible/pricing.js';
import { usageToMetadata } from './session/stream-consumer.js';
import type { ProviderUsage } from './provider.js';

type OpenAIState = Parameters<typeof usageFromState>[0];
const openAIState = (prompt: number, cached: number, completion: number): OpenAIState =>
  ({
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: cached },
    },
    finishReason: 'stop',
  }) as unknown as OpenAIState;

const hitRate = (b: { uncachedInput: number; cacheRead: number; cacheWrite: number }): number =>
  b.cacheRead / (b.uncachedInput + b.cacheRead + b.cacheWrite);

describe('billing construction', () => {
  it('anthropic maps counters directly (input already excludes cache)', () => {
    expect(
      anthropicBilling({
        input_tokens: 50,
        output_tokens: 20,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      }),
    ).toEqual({ provider: 'anthropic-direct', uncachedInput: 50, cacheRead: 900, cacheWrite: 100, output: 20 });
  });

  it('anthropic treats null cache fields as zero', () => {
    expect(anthropicBilling({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: null })).toEqual({
      provider: 'anthropic-direct',
      uncachedInput: 5,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
    });
  });

  it('openai-compatible subtracts the cached subset from prompt_tokens exactly once', () => {
    expect(openAICompatibleBilling(10_000, 9_000, 200)).toEqual({
      provider: 'openai-compatible',
      uncachedInput: 1_000,
      cacheRead: 9_000,
      cacheWrite: 0,
      output: 200,
    });
  });

  it('openai-compatible clamps a backend reporting cached > prompt', () => {
    const b = openAICompatibleBilling(100, 150, 0);
    expect(b.uncachedInput).toBe(0);
    expect(b.cacheRead).toBe(100);
  });
});

describe('sumBillingUsage', () => {
  it('adds counters and tolerates either side absent', () => {
    const a = openAICompatibleBilling(100, 40, 10);
    const b = openAICompatibleBilling(200, 150, 5);
    expect(sumBillingUsage(a, b)).toEqual({
      provider: 'openai-compatible',
      uncachedInput: 110,
      cacheRead: 190,
      cacheWrite: 0,
      output: 15,
    });
    expect(sumBillingUsage(undefined, b)).toEqual(b);
    expect(sumBillingUsage(a, undefined)).toEqual(a);
    expect(sumBillingUsage(undefined, undefined)).toBeUndefined();
  });

  it('does not alias its inputs', () => {
    const a = openAICompatibleBilling(10, 0, 0);
    const out = sumBillingUsage(a, undefined)!;
    out.uncachedInput = 999;
    expect(a.uncachedInput).toBe(10);
  });

  it('tags result as mixed and warns when providers differ', () => {
    const a = anthropicBilling({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 });
    const b = openAICompatibleBilling(20, 10, 3);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = sumBillingUsage(a, b)!;
    expect(result.provider).toBe('mixed');
    expect(result.uncachedInput).toBe(a.uncachedInput + b.uncachedInput);
    expect(result.cacheRead).toBe(a.cacheRead + b.cacheRead);
    expect(result.cacheWrite).toBe(a.cacheWrite + b.cacheWrite);
    expect(result.output).toBe(a.output + b.output);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toMatch(/provider mismatch/);
    warnSpy.mockRestore();
  });

  it('sumBillingUsage(undefined, mixedRecord) returns a copy without warning', () => {
    // Identity path: a is absent, b is already 'mixed'.  The short-circuit must
    // propagate 'mixed' without emitting a second warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mixed = sumBillingUsage(
        anthropicBilling({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
        openAICompatibleBilling(20, 10, 3),
      )!;
      warnSpy.mockClear(); // discard the construction warn
      const result = sumBillingUsage(undefined, mixed);
      expect(result).toEqual(mixed);
      expect(result).not.toBe(mixed); // must be a copy, not the same reference
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('re-summing a mixed record does not warn again', () => {
    // Deserialized 'mixed' records should not flood the log on every accumulation.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mixed = sumBillingUsage(
      anthropicBilling({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
      openAICompatibleBilling(20, 10, 3),
    )!;
    expect(mixed.provider).toBe('mixed');
    warnSpy.mockClear(); // discard the one construction warn

    const normal = anthropicBilling({ input_tokens: 5, output_tokens: 2 });
    const result = sumBillingUsage(mixed, normal)!;
    expect(result.provider).toBe('mixed');
    expect(result.uncachedInput).toBe(mixed.uncachedInput + normal.uncachedInput);
    expect(warnSpy).not.toHaveBeenCalled();

    const result2 = sumBillingUsage(normal, mixed)!;
    expect(result2.provider).toBe('mixed');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('sumBillingUsage(mixed, mixed) merges totals without warning', () => {
    // Two independently-constructed mixed records (e.g. from deserialized sidecars)
    // must merge cleanly with no provider-mismatch warn.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mixed1 = sumBillingUsage(
      anthropicBilling({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }),
      openAICompatibleBilling(20, 10, 3),
    )!;
    const mixed2 = sumBillingUsage(
      anthropicBilling({ input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 50, cache_creation_input_tokens: 30 }),
      openAICompatibleBilling(12, 6, 2),
    )!;
    warnSpy.mockClear(); // discard the two construction warns
    const result = sumBillingUsage(mixed1, mixed2)!;
    expect(result.provider).toBe('mixed');
    expect(result.uncachedInput).toBe(mixed1.uncachedInput + mixed2.uncachedInput);
    expect(result.output).toBe(mixed1.output + mixed2.output);
    expect(result.cacheRead).toBe(mixed1.cacheRead + mixed2.cacheRead);
    expect(result.cacheWrite).toBe(mixed1.cacheWrite + mixed2.cacheWrite);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('sumProviderUsage carries billing (summed) beside the legacy fields', () => {
  it('multi-round OpenAI child: billing reports the true hit rate; legacy fields unchanged', () => {
    // Three tool rounds, each re-sending a 10k prompt of which 9k is a cache hit.
    let acc: ProviderUsage = {};
    for (let i = 0; i < 3; i++) acc = sumProviderUsage(acc, usageFromState(openAIState(10_000, 9_000, 100)));

    // Legacy semantics preserved: input summed (subset incl. cached), cache latest-round.
    expect(acc.inputTokens).toBe(30_000);
    expect(acc.cachedInputTokens).toBe(9_000);

    // The legacy formula on these fields reports ~23% for a 90% cache hit.
    const legacy = acc.cachedInputTokens! / (acc.inputTokens! + acc.cachedInputTokens!);
    expect(legacy).toBeCloseTo(0.2308, 3);

    // Billing: uncached input is NOT inflated by cached tokens; hit rate is 90%.
    expect(acc.billing).toEqual({
      provider: 'openai-compatible',
      uncachedInput: 3_000,
      cacheRead: 27_000,
      cacheWrite: 0,
      output: 300,
    });
    expect(hitRate(acc.billing!)).toBeCloseTo(0.9, 6);
  });

  it('multi-round Anthropic turn: billing sums cache reads that the legacy field drops', () => {
    const round = (input: number, read: number, write: number): ProviderUsage =>
      toProviderUsage(
        { input_tokens: input, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write } as Usage,
        'tool_use',
      );
    let acc: ProviderUsage = {};
    acc = sumProviderUsage(acc, round(20, 0, 5_000));
    acc = sumProviderUsage(acc, round(30, 5_000, 200));
    acc = sumProviderUsage(acc, round(40, 5_200, 300));

    expect(acc.inputTokens).toBe(90);
    expect(acc.cachedInputTokens).toBe(5_200); // latest round only (unchanged)
    expect(acc.cacheCreationTokens).toBe(300); // latest round only (unchanged)
    expect(acc.billing).toEqual({
      provider: 'anthropic-direct',
      uncachedInput: 90,
      cacheRead: 10_200,
      cacheWrite: 5_500,
      output: 30,
    });
  });

  it('a usage object without billing (legacy/seeded) sums to undefined billing', () => {
    expect(sumProviderUsage({ inputTokens: 1 }, { inputTokens: 2 }).billing).toBeUndefined();
  });
});

describe('translator guardrails', () => {
  it('openai usageFromState keeps legacy fields and cost exactly as before', () => {
    const u = usageFromState(openAIState(10_000, 9_000, 200), 'gpt-4o');
    expect(u.inputTokens).toBe(10_000);
    expect(u.cachedInputTokens).toBe(9_000);
    expect(u.outputTokens).toBe(200);
    expect(u.totalCostUsd).toBe(deriveCallCostUsdWithTier('gpt-4o', 10_000, 200, 9_000, false));
    expect(u.billing?.uncachedInput).toBe(1_000);
  });

  it('openai usageFromState with no usage reports no billing', () => {
    expect(usageFromState({ finishReason: 'stop' } as unknown as OpenAIState).billing).toBeUndefined();
  });

  it('anthropic toProviderUsage with no usage reports no billing', () => {
    expect(toProviderUsage(null, 'end_turn').billing).toBeUndefined();
  });
});

describe('ResponseMetadata wire round-trip', () => {
  it('usageToMetadata emits billing keys that billingFromUsageRecord reads back', () => {
    const usage: ProviderUsage = {
      inputTokens: 10_000,
      cachedInputTokens: 9_000,
      outputTokens: 5,
      billing: openAICompatibleBilling(10_000, 9_000, 5),
    };
    const meta = usageToMetadata(usage, 's1');
    const record = meta.usage as Record<string, unknown>;
    // Legacy keys untouched.
    expect(record['input_tokens']).toBe(10_000);
    expect(record['cache_read_input_tokens']).toBe(9_000);
    expect(billingFromUsageRecord(record)).toEqual(usage.billing);
  });

  it('a legacy usage record (no provider tag) never fabricates zero billing', () => {
    expect(billingFromUsageRecord({ input_tokens: 5, cache_read_input_tokens: 3 })).toBeUndefined();
    expect(billingFromUsageRecord(undefined)).toBeUndefined();
    expect(billingToUsageFields(undefined)).toEqual({});
  });
});

describe('billingLifecycleFields', () => {
  it('splits provider from counters, or yields {} when absent', () => {
    expect(billingLifecycleFields(openAICompatibleBilling(10, 4, 1))).toEqual({
      provider: 'openai-compatible',
      tokens: { uncachedInput: 6, cacheRead: 4, cacheWrite: 0, output: 1 },
    });
    expect(billingLifecycleFields(undefined)).toEqual({});
  });
});

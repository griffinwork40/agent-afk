/**
 * Unit tests for ContextSampler's token accounting.
 *
 * Focus: the sampler must report an absolute `used` count on the SAME basis
 * as the `percentage` it displays beside it. Summing the `apiUsage` fields
 * (its previous behaviour) mixes cumulative input/output with last-round-only
 * cache counts and double-counts every prior round.
 *
 * @module cli/context-sampler.test
 */

import { describe, it, expect } from 'vitest';
import { ContextSampler } from './context-sampler.js';
import type { AgentSession } from '../agent/session.js';

type Payload = Awaited<ReturnType<AgentSession['getContextUsage']>>;

/** Minimal stub matching the sampler's narrow ContextUsageSource surface. */
function sourceOf(payload: Record<string, unknown>): AgentSession {
  return {
    getContextUsage: async () => payload as unknown as Payload,
  } as unknown as AgentSession;
}

describe('ContextSampler — used-token basis', () => {
  it('reports the provider-computed total, not a sum of the mixed-basis fields', async () => {
    // A realistic round-3 payload: input/output accumulated across the turn's
    // rounds, cache counts from the last round only. The naive sum is
    // 3000+900+50000+2000 = 55,900 — but the last round's true occupancy is
    // 53,000. The inflation is exactly the earlier rounds' input+output, which
    // the latest cache_read already contains.
    const sampler = new ContextSampler(
      sourceOf({
        totalTokens: 53_000,
        percentage: 26.5,
        maxTokens: 200_000,
        isAutoCompactEnabled: false,
        apiUsage: {
          input_tokens: 3000,
          output_tokens: 900,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 2000,
          context_window_tokens: 53_000,
        },
      }),
    );

    await sampler.refresh();
    expect(sampler.getDetail()?.used).toBe(53_000);
    expect(sampler.getDetail()?.used).not.toBe(55_900);
  });

  it('keeps used consistent with the percentage it is displayed beside', async () => {
    // The regression this guards: an inflated absolute rendered next to a
    // correctly-derived ratio, in the same status-line segment.
    const sampler = new ContextSampler(
      sourceOf({
        totalTokens: 100_000,
        percentage: 50,
        maxTokens: 200_000,
        isAutoCompactEnabled: false,
        apiUsage: {
          input_tokens: 9000,
          output_tokens: 4000,
          cache_read_input_tokens: 95_000,
          cache_creation_input_tokens: 1000,
          context_window_tokens: 100_000,
        },
      }),
    );

    await sampler.refresh();
    const detail = sampler.getDetail()!;
    expect(detail.used / detail.limit).toBeCloseTo(detail.percentage / 100, 6);
  });

  it('falls back to the breakdown field when totalTokens is absent', async () => {
    const sampler = new ContextSampler(
      sourceOf({
        percentage: 10,
        maxTokens: 200_000,
        isAutoCompactEnabled: false,
        apiUsage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 18_000,
          cache_creation_input_tokens: 500,
          context_window_tokens: 20_000,
        },
      }),
    );

    await sampler.refresh();
    expect(sampler.getDetail()?.used).toBe(20_000);
  });

  it('falls back to cache-excluded input+output when no footprint is present', async () => {
    // Mirrors contextWindowTokensUsed's own fallback. The 40k cache_read must
    // NOT be added back — that is the double-count this change removes.
    const sampler = new ContextSampler(
      sourceOf({
        percentage: 10,
        maxTokens: 200_000,
        isAutoCompactEnabled: false,
        apiUsage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 0,
        },
      }),
    );

    await sampler.refresh();
    expect(sampler.getDetail()?.used).toBe(1500);
  });

  it('reports zero rather than a bad sum when neither basis is available', async () => {
    const sampler = new ContextSampler(
      sourceOf({
        percentage: 5,
        maxTokens: 200_000,
        isAutoCompactEnabled: false,
        apiUsage: null,
      }),
    );

    await sampler.refresh();
    expect(sampler.getDetail()?.used).toBe(0);
  });
});

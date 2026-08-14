import { describe, it, expect } from 'vitest';
import { deriveXaiCallCostUsd, isGrokModelId, XAI_MODEL_PRICING } from './pricing.js';

const M = 1_000_000;

describe('deriveXaiCallCostUsd', () => {
  it('prices grok-4.5 at list rates', () => {
    const cost = deriveXaiCallCostUsd('grok-4.5', M, M, 0);
    expect(cost).toBeCloseTo(2.0 + 6.0, 8);
  });

  it('applies cached input discount when present', () => {
    const cost = deriveXaiCallCostUsd('grok-4.5', M, 0, M / 2);
    expect(cost).toBeCloseTo(0.5 * 2.0 + 0.5 * 0.3, 8);
  });

  it('returns undefined for unknown models (never zero)', () => {
    expect(deriveXaiCallCostUsd('not-a-grok', M, M)).toBeUndefined();
  });

  it('returns undefined for retired families (never invents list prices)', () => {
    expect(deriveXaiCallCostUsd('grok-3', M, M)).toBeUndefined();
    expect(deriveXaiCallCostUsd('grok-2', M, M)).toBeUndefined();
    expect(deriveXaiCallCostUsd('grok-4', M, M)).toBeUndefined();
    expect(XAI_MODEL_PRICING.has('grok-3')).toBe(false);
    expect(XAI_MODEL_PRICING.has('grok-4')).toBe(false);
  });

  it('prices grok-4.6 at list rates (same in/out as 4.5, cached 0.5)', () => {
    const cost = deriveXaiCallCostUsd('grok-4.6', M, M, 0);
    expect(cost).toBeCloseTo(2.0 + 6.0, 8);
    const cached = deriveXaiCallCostUsd('grok-4.6', M, 0, M / 2);
    expect(cached).toBeCloseTo(0.5 * 2.0 + 0.5 * 0.5, 8);
  });

  it('has entries only for the active public catalog set', () => {
    expect(XAI_MODEL_PRICING.has('grok-4.6')).toBe(true);
    expect(XAI_MODEL_PRICING.has('grok-4.5')).toBe(true);
    expect(XAI_MODEL_PRICING.has('grok-4.3')).toBe(true);
    expect(XAI_MODEL_PRICING.has('grok-4.20-multi-agent-0309')).toBe(true);
    expect(XAI_MODEL_PRICING.has('grok-build-0.1')).toBe(true);
    expect(XAI_MODEL_PRICING.size).toBe(7);
  });
});

describe('isGrokModelId', () => {
  it('matches grok prefixes', () => {
    expect(isGrokModelId('grok-4.6')).toBe(true);
    expect(isGrokModelId('grok-4.5')).toBe(true);
    expect(isGrokModelId('grok_2')).toBe(true);
    expect(isGrokModelId('gpt-4o')).toBe(false);
  });
});

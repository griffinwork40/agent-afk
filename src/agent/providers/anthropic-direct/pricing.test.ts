import { describe, expect, it } from 'vitest';
import { deriveCallCostUsd } from './pricing.js';

describe('Anthropic speed-aware pricing', () => {
  it('preserves standard Opus 5 pricing', () => {
    expect(deriveCallCostUsd('claude-opus-5', 1_000_000, 1_000_000, 0, 0)).toBe(30);
  });
  it('uses fast rates including cache rates', () => {
    expect(deriveCallCostUsd('claude-opus-5', 3_000_000, 1_000_000, 1_000_000, 1_000_000, { requestSpeed: 'fast' })).toBe(73.5);
  });
  it('actual response speed overrides request speed', () => {
    expect(deriveCallCostUsd('claude-opus-5', 1_000_000, 0, 0, 0, { requestSpeed: 'fast', responseSpeed: 'standard' })).toBe(5);
    expect(deriveCallCostUsd('claude-opus-5', 1_000_000, 0, 0, 0, { requestSpeed: 'standard', responseSpeed: 'fast' })).toBe(10);
  });
});

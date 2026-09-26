/**
 * Tests for `src/whatif/cost.ts`.
 */

import { describe, expect, it } from 'vitest';
import { BudgetTracker, estimateVerifyCost } from './cost.js';

// ---------------------------------------------------------------------------
// estimateVerifyCost
// ---------------------------------------------------------------------------

describe('estimateVerifyCost', () => {
  const baseInput = {
    episodes: 10,
    samples: 2,
    agentModel: 'claude-sonnet-5',
    analystModel: 'claude-sonnet-5',
    systemTokens: { baseline: 5000, candidate: 5100 },
    judgeExternal: false,
  };

  it('returns a positive cost', () => {
    const result = estimateVerifyCost(baseInput);
    expect(result.usd).toBeGreaterThan(0);
  });

  it('call count includes discover + predict + agent calls + judge calls', () => {
    const result = estimateVerifyCost(baseInput);
    // discover(1) + predict(1) + agent(2*2*samples*episodes) + judge(episodes*samples*2)
    // = 2 + 2*2*2*10 + 10*2*2 = 2 + 80 + 40 = 122... wait, let's check formula
    // agentCallsPerEp = 2 envs * 2 calls * samples = 2*2*2 = 8 per episode → 8*10 = 80
    // judgeCallsTotal = episodes * samples * 2 = 10*2*2 = 40
    // total = 2 + 80 + 40 = 122
    expect(result.calls).toBe(122);
  });

  it('breakdown sums to total', () => {
    const result = estimateVerifyCost(baseInput);
    const sum = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(result.usd, 6);
  });

  it('external judge: judge cost is 0 but calls counted', () => {
    const ext = estimateVerifyCost({ ...baseInput, judgeExternal: true });
    const noExt = estimateVerifyCost({ ...baseInput, judgeExternal: false });
    expect(ext.breakdown.judge).toBe(0);
    expect(ext.usd).toBeLessThan(noExt.usd);
    // Calls the same — judge calls still counted.
    expect(ext.calls).toBe(noExt.calls);
  });

  it('more episodes = more cost', () => {
    const low = estimateVerifyCost({ ...baseInput, episodes: 5 });
    const high = estimateVerifyCost({ ...baseInput, episodes: 20 });
    expect(high.usd).toBeGreaterThan(low.usd);
  });

  it('larger system tokens = more cost', () => {
    const small = estimateVerifyCost({ ...baseInput, systemTokens: { baseline: 1000, candidate: 1000 } });
    const large = estimateVerifyCost({ ...baseInput, systemTokens: { baseline: 10000, candidate: 10000 } });
    expect(large.usd).toBeGreaterThan(small.usd);
  });

  it('unknown model: approximate flag set, cost still positive', () => {
    const result = estimateVerifyCost({
      ...baseInput,
      agentModel: 'gpt-unknown-model-xyz',
    });
    expect(result.approximate).toBe(true);
    expect(result.usd).toBeGreaterThan(0);
  });

  it('known models: no approximate flag', () => {
    const result = estimateVerifyCost(baseInput);
    expect(result.approximate).toBeUndefined();
  });

  it('breakdown has discover, predict, agent, judge keys', () => {
    const result = estimateVerifyCost(baseInput);
    expect(Object.keys(result.breakdown).sort()).toEqual(['agent', 'discover', 'judge', 'predict']);
  });
});

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

describe('BudgetTracker', () => {
  it('starts at 0 spent, not exceeded', () => {
    const t = new BudgetTracker(1.0);
    expect(t.spent).toBe(0);
    expect(t.exceeded).toBe(false);
  });

  it('add accumulates correctly', () => {
    const t = new BudgetTracker(1.0);
    t.add(0.3);
    t.add(0.4);
    expect(t.spent).toBeCloseTo(0.7);
  });

  it('exceeded becomes true past the cap', () => {
    const t = new BudgetTracker(0.5);
    t.add(0.6);
    expect(t.exceeded).toBe(true);
  });

  it('not exceeded at exactly the cap', () => {
    const t = new BudgetTracker(0.5);
    t.add(0.5);
    expect(t.exceeded).toBe(false);
  });

  it('remaining decreases with spending', () => {
    const t = new BudgetTracker(2.0);
    t.add(0.5);
    expect(t.remaining()).toBeCloseTo(1.5);
  });

  it('remaining is negative when exceeded', () => {
    const t = new BudgetTracker(0.1);
    t.add(0.5);
    expect(t.remaining()).toBeLessThan(0);
  });
});

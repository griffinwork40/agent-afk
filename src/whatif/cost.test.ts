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
    // discover(1) + predict(1) + agent(2 envs × 1 call × samples × episodes) + judge(episodes × samples × 2 envs)
    // agentCallsPerEp = 2 envs × 1 call × samples = 2*1*2 = 4 per episode → 4*10 = 40
    // judgeCallsTotal = episodes × samples × 2 envs = 10*2*2 = 40
    // total = 2 + 40 + 40 = 82
    expect(result.calls).toBe(82);
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

  it('agent output token assumption: 800 tokens per call is the calibration target', () => {
    // agentOut = 800 is the model's output-token assumption, calibrated against
    // the pilot median (575) with headroom for multi-tool episodes.  This test
    // pins the agent breakdown to its expected value under the known pricing so
    // any silent change to agentOut is caught directly rather than only through
    // the pilot ratio bound (which tolerates up to a ~23% reduction in agentOut
    // without failing).
    const result = estimateVerifyCost({
      ...baseInput,
      // 1 sample, 1 episode, equal system tokens → agent USD = 2 × callCost(agentModel, 5000+1500, 800)
      episodes: 1,
      samples: 1,
      systemTokens: { baseline: 5_000, candidate: 5_000 },
      judgeExternal: true, // isolate agent cost
    });
    // 2 agent calls (1 baseline + 1 candidate), each with 6500 in + 800 out.
    // claude-sonnet-5 rates: $2/$10 per MTok (pricing.ts).
    const agentInputTok = 6_500;
    const agentOutputTok = 800;
    const perCallUsd = (agentInputTok / 1_000_000) * 2.0 + (agentOutputTok / 1_000_000) * 10.0;
    const expectedAgentUsd = 2 * perCallUsd; // baseline + candidate
    // discover + predict overhead from analystModel (same model here)
    const discoverUsd = (20_000 / 1_000_000) * 2.0 + (1_000 / 1_000_000) * 10.0;
    const predictUsd = (15_000 / 1_000_000) * 2.0 + (2_000 / 1_000_000) * 10.0;
    expect(result.breakdown.agent).toBeCloseTo(expectedAgentUsd, 8);
    expect(result.breakdown.discover).toBeCloseTo(discoverUsd, 8);
    expect(result.breakdown.predict).toBeCloseTo(predictUsd, 8);
    expect(result.breakdown.judge).toBe(0);
  });

  it('pilot regression: estimate within 1.0–1.3× of pilot actual $6.21 (issue #2489)', () => {
    // Fixture: paid pilot run 20260928-153056-015fbb.
    // Parameters: claude-sonnet-4-6 agent, 13 targeted episodes, 2 samples,
    // Jev judge (external), system tokens 33 389 (baseline) / 33 415 (candidate).
    // Actual total from traces.jsonl: $6.2121 across 52 successful agent calls
    // (13 episodes × 2 envs × 2 samples = 52), confirming 1 call per tuple.
    // Root cause of the prior 1.92× overestimate: agentCallsPerEp used 2×2×samples
    // instead of the correct 2×1×samples, doubling agent call count and cost.
    const pilotResult = estimateVerifyCost({
      episodes: 13,
      samples: 2,
      agentModel: 'claude-sonnet-4-6',
      analystModel: 'claude-sonnet-4-6',
      systemTokens: { baseline: 33_389, candidate: 33_415 },
      judgeExternal: true,
    });
    const actual = 6.21;
    const ratio = pilotResult.usd / actual;
    // Target: mildly conservative — no more than 1.3× actual, at least 1.0×.
    // NOTE: ratio < 1.0 means the model underestimates (e.g. multi-tool episodes
    // exceeding the 1-call assumption); it does not mean the formula is wrong.
    // The lower bound is a goal of the conservative model, not a mathematical invariant.
    expect(ratio).toBeGreaterThanOrEqual(1.0);
    expect(ratio).toBeLessThanOrEqual(1.3);
    // Call count sanity: 2 + 2×1×2×13 + 13×2×2 = 2 + 52 + 52 = 106
    expect(pilotResult.calls).toBe(106);
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

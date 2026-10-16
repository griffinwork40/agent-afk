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
    maxTurns: 3,
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

  it('multi-turn token model: effectiveInput and effectiveOutput scale with maxTurns', () => {
    // With maxTurns=N, USER_TOKENS_PER_TURN=1000, OUTPUT_TOKENS_PER_TURN=800:
    //   effectiveInput  = sys + N*1000 + (N-1)*800
    //   effectiveOutput = N*800
    // 1 sample, 1 episode, equal system tokens; judgeExternal to isolate agent cost.
    // claude-sonnet-5 rates: $2/M input, $10/M output (pricing.ts).
    const M = 1_000_000;
    const inputRate = 2.0;
    const outputRate = 10.0;
    const sys = 5_000;

    for (const N of [1, 2, 3]) {
      const result = estimateVerifyCost({
        ...baseInput,
        episodes: 1,
        samples: 1,
        maxTurns: N,
        systemTokens: { baseline: sys, candidate: sys },
        judgeExternal: true,
      });
      const nonSys = N * 1_000 + (N - 1) * 800;
      const effIn = sys + nonSys;
      const effOut = N * 800;
      const perCallUsd = (effIn / M) * inputRate + (effOut / M) * outputRate;
      const expectedAgentUsd = 2 * perCallUsd; // baseline + candidate
      const discoverUsd = (20_000 / M) * inputRate + (1_000 / M) * outputRate;
      const predictUsd = (15_000 / M) * inputRate + (2_000 / M) * outputRate;
      expect(result.breakdown.agent).toBeCloseTo(expectedAgentUsd, 8);
      expect(result.breakdown.discover).toBeCloseTo(discoverUsd, 8);
      expect(result.breakdown.predict).toBeCloseTo(predictUsd, 8);
      expect(result.breakdown.judge).toBe(0);
    }
  });

  it('pilot regression: estimate within 0.9–1.15× of pilot actual $6.21 (issues #2489 #3876)', () => {
    // Fixture: paid pilot run 20260928-153056-015fbb.
    // Parameters: claude-sonnet-4-6 agent, 13 targeted episodes, 2 samples,
    // Jev judge (external), system tokens 33 389 (baseline) / 33 415 (candidate).
    // Actual total from traces.jsonl: $6.2121 across 52 successful agent calls
    // (13 episodes × 2 envs × 2 samples = 52), confirming 1 call per tuple.
    //
    // The pilot episodes ran as effectively single-turn (the back-calculated per-call
    // cost of $0.1194 matches the maxTurns=1 model at $0.1152 within 3.6%).
    // Pass maxTurns=1 to reflect the actual run; the multi-turn model would
    // over-estimate by ~1.54× which is correct for 3-turn runs but wrong here.
    //
    // Root cause of the prior 1.92× overestimate: agentCallsPerEp used 2×2×samples
    // instead of the correct 2×1×samples, doubling agent call count and cost.
    const pilotResult = estimateVerifyCost({
      episodes: 13,
      samples: 2,
      maxTurns: 1, // pilot episodes were effectively single-turn
      agentModel: 'claude-sonnet-4-6',
      analystModel: 'claude-sonnet-4-6',
      systemTokens: { baseline: 33_389, candidate: 33_415 },
      judgeExternal: true,
    });
    const actual = 6.21;
    const ratio = pilotResult.usd / actual;
    // Target: within ±15% of actual for a maxTurns=1 run.
    // The multi-turn (N=3) estimator would give 1.28×; maxTurns=1 gives ~0.99×.
    // Lower bound 0.9× leaves room for episodes that genuinely ran <1 full turn
    // (warm cache, no tools); upper bound 1.15× tolerates minor input token variance.
    expect(ratio).toBeGreaterThanOrEqual(0.9);
    expect(ratio).toBeLessThanOrEqual(1.15);
    // Call count sanity: 2 + 2×1×2×13 + 13×2×2 = 2 + 52 + 52 = 106
    expect(pilotResult.calls).toBe(106);
  });

  it('no-op control regression: multi-turn model (maxTurns=3) estimates more than single-turn (issue #3876)', () => {
    // Demonstrates that the single-turn model systematically under-estimates
    // multi-turn episodes (issue #3876), while the maxTurns=3 model corrects this.
    //
    // Fixture parameters approximate the no-op control run 20261015-204001-687bfc:
    //   13 episodes, 3 samples, Jev (external), agent claude-sonnet-4-6 ($3/$15/M),
    //   system tokens ~75 000 (typical AFK system prompt for that agent version).
    // Actual verify portion: ~$20.90 (costUsd $22.35 minus baseline-sample $1.45).
    // 78 agent traces (13 eps × 2 arms × 3 samples).
    const multiTurn = estimateVerifyCost({
      episodes: 13,
      samples: 3,
      maxTurns: 3,
      agentModel: 'claude-sonnet-4-6',
      analystModel: 'claude-sonnet-4-6',
      systemTokens: { baseline: 75_000, candidate: 75_000 },
      judgeExternal: true,
    });
    const singleTurn = estimateVerifyCost({
      episodes: 13,
      samples: 3,
      maxTurns: 1,
      agentModel: 'claude-sonnet-4-6',
      analystModel: 'claude-sonnet-4-6',
      systemTokens: { baseline: 75_000, candidate: 75_000 },
      judgeExternal: true,
    });
    // Multi-turn must be strictly more expensive than single-turn.
    expect(multiTurn.usd).toBeGreaterThan(singleTurn.usd);
    // The multi-turn model must be at or above the no-op actual spend (~$20.90)
    // for a run with these parameters.  The single-turn model is well below —
    // this was the original under-estimation in issue #3876.
    const actualVerify = 20.90;
    expect(multiTurn.usd).toBeGreaterThanOrEqual(actualVerify);
    expect(singleTurn.usd).toBeLessThan(actualVerify); // proves the old model was too low
    // Upper bound: multi-turn model should not over-estimate by more than 2×.
    expect(multiTurn.usd).toBeLessThanOrEqual(actualVerify * 2);
    // Call count unchanged: 2 + 78 + 78 = 158
    expect(multiTurn.calls).toBe(2 + 2 * 13 * 3 + 13 * 3 * 2);
    expect(singleTurn.calls).toBe(2 + 2 * 13 * 3 + 13 * 3 * 2);
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

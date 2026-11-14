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
// estimateVerifyCost: exact formula pins
// ---------------------------------------------------------------------------

/** USD for one call at the given per-MTok rates. */
function usdAt(inTok: number, outTok: number, inRate: number, outRate: number): number {
  return (inTok / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
}

// claude-sonnet-5 = $2/$10, claude-opus-5 = $5/$25 per MTok (pricing.ts).
const SONNET = { inRate: 2.0, outRate: 10.0 };
const OPUS = { inRate: 5.0, outRate: 25.0 };
// Fallback for unknown models is sonnet-class $2/$10 (cost.ts).
const FALLBACK = { inRate: 2.0, outRate: 10.0 };
const UNKNOWN_MODEL = 'zz-not-a-real-model-for-cost-test';

// Agent episodes are priced as one aggregated multi-turn call (cost.ts, #3876):
//   in  = system + maxTurns x 1 000 user + (maxTurns - 1) x 800 history
//   out = maxTurns x 800
const MAX_TURNS = 3;
function agentTokens(systemTokens: number, maxTurns = MAX_TURNS): { inTok: number; outTok: number } {
  return {
    inTok: systemTokens + maxTurns * 1_000 + (maxTurns - 1) * 800,
    outTok: maxTurns * 800,
  };
}

/** USD for one agent call with the given system prompt size. */
function agentUsd(systemTokens: number, rates: { inRate: number; outRate: number }): number {
  const { inTok, outTok } = agentTokens(systemTokens);
  return usdAt(inTok, outTok, rates.inRate, rates.outRate);
}

describe('estimateVerifyCost: exact formula', () => {
  const base = {
    episodes: 3,
    samples: 2,
    agentModel: 'claude-sonnet-5',
    analystModel: 'claude-sonnet-5',
    maxTurns: MAX_TURNS,
    systemTokens: { baseline: 4_000, candidate: 4_000 },
    judgeExternal: false,
  };

  it('judge cost is 2 000 in / 200 out per output, one output per episode x sample x env', () => {
    const r = estimateVerifyCost(base);
    const perJudge = usdAt(2_000, 200, SONNET.inRate, SONNET.outRate);
    expect(r.breakdown.judge).toBeCloseTo(perJudge * 3 * 2 * 2, 10);
  });

  it('total usd is exactly discover + predict + agent + judge', () => {
    const r = estimateVerifyCost(base);
    const discover = usdAt(20_000, 1_000, SONNET.inRate, SONNET.outRate);
    const predict = usdAt(15_000, 2_000, SONNET.inRate, SONNET.outRate);
    const agentPerCall = agentUsd(4_000, SONNET);
    const agent = agentPerCall * 2 * 3 * 2;
    const judge = usdAt(2_000, 200, SONNET.inRate, SONNET.outRate) * 3 * 2 * 2;
    expect(r.usd).toBeCloseTo(discover + predict + agent + judge, 10);
  });

  it('agent and judge cost scale linearly with episodes x samples; discover/predict are fixed', () => {
    const one = estimateVerifyCost({ ...base, episodes: 1, samples: 1 });
    const many = estimateVerifyCost({ ...base, episodes: 7, samples: 3 });
    expect(many.breakdown.agent).toBeCloseTo(one.breakdown.agent! * 21, 10);
    expect(many.breakdown.judge).toBeCloseTo(one.breakdown.judge! * 21, 10);
    expect(many.breakdown.discover).toBe(one.breakdown.discover);
    expect(many.breakdown.predict).toBe(one.breakdown.predict);
  });

  it('samples and episodes are interchangeable for cost and call count', () => {
    const a = estimateVerifyCost({ ...base, episodes: 4, samples: 5 });
    const b = estimateVerifyCost({ ...base, episodes: 5, samples: 4 });
    expect(a.usd).toBeCloseTo(b.usd, 10);
    expect(a.calls).toBe(b.calls);
  });

  it('baseline and candidate system tokens are each priced on their own call', () => {
    // Agent cost is linear in input tokens, so an asymmetric split with the
    // same sum must cost the same as the symmetric split.
    const asym = estimateVerifyCost({ ...base, systemTokens: { baseline: 1_000, candidate: 9_000 } });
    const sym = estimateVerifyCost({ ...base, systemTokens: { baseline: 5_000, candidate: 5_000 } });
    expect(asym.breakdown.agent).toBeCloseTo(sym.breakdown.agent!, 10);

    // Growing only the candidate prompt raises agent cost by exactly the
    // extra input tokens, once per (episode, sample).
    const bigger = estimateVerifyCost({ ...base, systemTokens: { baseline: 4_000, candidate: 14_000 } });
    const delta = usdAt(10_000, 0, SONNET.inRate, SONNET.outRate) * 3 * 2;
    expect(bigger.breakdown.agent! - estimateVerifyCost(base).breakdown.agent!).toBeCloseTo(delta, 10);
  });

  it('agent calls are priced with agentModel; discover, predict and judge with analystModel', () => {
    const r = estimateVerifyCost({
      ...base,
      episodes: 1,
      samples: 1,
      agentModel: 'claude-opus-5',
      analystModel: 'claude-sonnet-5',
    });
    expect(r.breakdown.agent).toBeCloseTo(2 * agentUsd(4_000, OPUS), 10);
    expect(r.breakdown.discover).toBeCloseTo(usdAt(20_000, 1_000, SONNET.inRate, SONNET.outRate), 10);
    expect(r.breakdown.predict).toBeCloseTo(usdAt(15_000, 2_000, SONNET.inRate, SONNET.outRate), 10);
    expect(r.breakdown.judge).toBeCloseTo(2 * usdAt(2_000, 200, SONNET.inRate, SONNET.outRate), 10);
  });

  it('call count does not depend on models, system tokens or judgeExternal', () => {
    const expected = 2 + 2 * 3 * 2 + 3 * 2 * 2;
    for (const variant of [
      base,
      { ...base, judgeExternal: true },
      { ...base, agentModel: UNKNOWN_MODEL, analystModel: 'claude-opus-5' },
      { ...base, systemTokens: { baseline: 0, candidate: 100_000 } },
    ]) {
      expect(estimateVerifyCost(variant).calls).toBe(expected);
    }
  });

  it('zero episodes: only discover + predict are counted and charged', () => {
    const r = estimateVerifyCost({ ...base, episodes: 0 });
    expect(r.calls).toBe(2);
    expect(r.breakdown.agent).toBe(0);
    expect(r.breakdown.judge).toBe(0);
    expect(r.usd).toBeCloseTo(r.breakdown.discover! + r.breakdown.predict!, 10);
  });
});

describe('estimateVerifyCost: unknown-model fallback', () => {
  const base = {
    episodes: 1,
    samples: 1,
    agentModel: 'claude-sonnet-5',
    analystModel: 'claude-sonnet-5',
    maxTurns: MAX_TURNS,
    systemTokens: { baseline: 5_000, candidate: 5_000 },
    judgeExternal: false,
  };

  it('unknown agent model is priced at the sonnet-class fallback rates', () => {
    const r = estimateVerifyCost({ ...base, agentModel: UNKNOWN_MODEL });
    expect(r.approximate).toBe(true);
    expect(r.breakdown.agent).toBeCloseTo(2 * agentUsd(5_000, FALLBACK), 10);
  });

  it('unknown analyst model sets approximate and prices discover/predict/judge at fallback rates', () => {
    const r = estimateVerifyCost({ ...base, analystModel: UNKNOWN_MODEL });
    expect(r.approximate).toBe(true);
    expect(r.breakdown.discover).toBeCloseTo(usdAt(20_000, 1_000, FALLBACK.inRate, FALLBACK.outRate), 10);
    expect(r.breakdown.predict).toBeCloseTo(usdAt(15_000, 2_000, FALLBACK.inRate, FALLBACK.outRate), 10);
    expect(r.breakdown.judge).toBeCloseTo(2 * usdAt(2_000, 200, FALLBACK.inRate, FALLBACK.outRate), 10);
  });

  it('unknown analyst model still flags approximate when the judge is external', () => {
    const r = estimateVerifyCost({ ...base, analystModel: UNKNOWN_MODEL, judgeExternal: true });
    expect(r.approximate).toBe(true);
    expect(r.breakdown.judge).toBe(0);
  });

  it('approximate key is omitted entirely (not set to false) for fully priced runs', () => {
    const r = estimateVerifyCost(base);
    expect('approximate' in r).toBe(false);
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

  it('remaining equals the cap before any spend and 0 at exactly the cap', () => {
    const t = new BudgetTracker(1.25);
    expect(t.remaining()).toBe(1.25);
    t.add(1.25);
    expect(t.remaining()).toBe(0);
    expect(t.exceeded).toBe(false);
  });

  it('remaining reports the exact overspend as a negative number', () => {
    const t = new BudgetTracker(1);
    t.add(1.5);
    expect(t.remaining()).toBeCloseTo(-0.5, 10);
  });

  it('stays exceeded once past the cap as further spend accrues', () => {
    const t = new BudgetTracker(0.5);
    t.add(0.4);
    expect(t.exceeded).toBe(false);
    t.add(0.2);
    expect(t.exceeded).toBe(true);
    t.add(0);
    expect(t.exceeded).toBe(true);
    t.add(1);
    expect(t.exceeded).toBe(true);
    expect(t.spent).toBeCloseTo(1.6, 10);
  });

  it('a zero cap is not exceeded until any spend is recorded', () => {
    const t = new BudgetTracker(0);
    expect(t.exceeded).toBe(false);
    t.add(0);
    expect(t.exceeded).toBe(false);
    t.add(0.0001);
    expect(t.exceeded).toBe(true);
  });

  it('separate trackers do not share state', () => {
    const a = new BudgetTracker(1);
    const b = new BudgetTracker(1);
    a.add(2);
    expect(a.exceeded).toBe(true);
    expect(b.spent).toBe(0);
    expect(b.exceeded).toBe(false);
  });
});

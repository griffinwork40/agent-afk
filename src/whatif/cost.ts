/**
 * Budget estimation and tracking for the what-if verification pipeline.
 *
 * Uses {@link deriveCallCostUsd} from the Anthropic-direct provider for
 * token-accurate pricing.  Unknown models fall back to a conservative
 * sonnet-class estimate and set `approximate: true` on the result.
 *
 * ## Estimation model (per episode × per sample)
 *
 * Agent model calls — each `runner.run()` call is one episode but internally
 * executes `maxTurns` LLM calls.  Conversation history accumulates across
 * turns, so the effective input grows with each turn.  The estimator models
 * this as a single aggregated call with:
 *
 *   effectiveInput  = systemTokens + maxTurns × USER_TOKENS_PER_TURN
 *                   + (maxTurns − 1) × OUTPUT_TOKENS_PER_TURN
 *   effectiveOutput = maxTurns × OUTPUT_TOKENS_PER_TURN
 *
 * where USER_TOKENS_PER_TURN = 1 000 and OUTPUT_TOKENS_PER_TURN = 800.
 * System tokens are charged once (not multiplied by maxTurns); the upward
 * bias comes from ignoring prompt-cache discounts on system + history tokens
 * after turn 1, which cost ~0.1× in practice.
 *
 * Calibration data (issue #3876):
 *   - Pilot run 20260928-153056-015fbb (maxTurns≈1, 52 traces, $6.21 actual):
 *     estimate ~$6.14 (0.99×) — conservative model in the short-episode limit.
 *   - No-op control run 20261015-204001-687bfc (maxTurns=3, 78 agent traces,
 *     $20.90 actual verify portion): estimate ~$22.27 (1.07×) — conservative.
 *   - Large-effect control 20261016-112101-3ae838 (episodes stopped early,
 *     actual $16.06 verify portion): estimate ~$22.27 (1.39×) — over-estimates
 *     for short episodes, which is the safe direction for budget gating.
 *
 * History: the original formula counted ×2 per episode per env, which doubled
 * every agent-call cost.  The old multiplier 2×2×samples = 8 should be
 * 2×1×samples = 4.  maxTurns was then added (issue #3876) to model
 * multi-turn history accumulation; single-turn runs (maxTurns=1) use
 * USER_TOKENS_PER_TURN (1 000) where the prior model used 1 500 — a close
 * but not identical baseline.
 * Provenance: src/whatif/run.verify.ts `runEpisodes` -- each EpTask calls
 * runner.run() exactly once.
 *
 * Judge model calls (×1 per output, i.e. per episode × per sample × 2 envs):
 *   - Input: 2 000 tokens.  Output: 200 tokens.
 *   - Cost is 0 when `judgeExternal` is true, but calls are still counted.
 *
 * Discover call (×1 per run):
 *   - Input: 20 000 tokens.  Output: 1 000 tokens.
 *
 * Predict call (×1 per run):
 *   - Input: 15 000 tokens.  Output: 2 000 tokens.
 *
 * @module whatif/cost
 */

import { deriveCallCostUsd, resolveModelId } from '../agent/providers/whatif-api.js';

// ---------------------------------------------------------------------------
// Per-turn token assumptions
// ---------------------------------------------------------------------------

/**
 * Assumed user + tool tokens per episode turn.
 * Calibrated against runs in issue #3876: short prompts rarely exceed 1 000
 * tokens per turn, and multi-turn history is captured separately via the
 * `(maxTurns − 1) × OUTPUT_TOKENS_PER_TURN` history term.
 */
const USER_TOKENS_PER_TURN = 1_000;

/**
 * Assumed output tokens per episode turn.
 * Calibrated against pilot run 20260928-153056-015fbb (median 575 tokens);
 * raised to 800 to cover multi-tool episodes and output variance.
 */
const OUTPUT_TOKENS_PER_TURN = 800;

// ---------------------------------------------------------------------------
// Fallback pricing for unknown models
// ---------------------------------------------------------------------------

/** Sonnet-class fallback: claude-sonnet-5 rates ($2/$10 per MTok). */
const FALLBACK_INPUT_PER_MTOK = 2.0;
const FALLBACK_OUTPUT_PER_MTOK = 10.0;

function fallbackCost(inputTokens: number, outputTokens: number): number {
  const M = 1_000_000;
  return (
    (inputTokens / M) * FALLBACK_INPUT_PER_MTOK +
    (outputTokens / M) * FALLBACK_OUTPUT_PER_MTOK
  );
}

/**
 * Cost for a single model call. Returns `{ usd, approximate }`.
 * When the model is unknown, uses sonnet-class rates and sets `approximate`.
 */
function callCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { usd: number; approximate: boolean } {
  const derived = deriveCallCostUsd(resolveModelId(model) ?? model, inputTokens, outputTokens, 0, 0);
  if (derived !== undefined) {
    return { usd: derived, approximate: false };
  }
  return { usd: fallbackCost(inputTokens, outputTokens), approximate: true };
}

// ---------------------------------------------------------------------------
// estimateVerifyCost
// ---------------------------------------------------------------------------

export interface VerifyCostInput {
  /** Number of distinct episodes. */
  episodes: number;
  /** Samples per episode per environment. */
  samples: number;
  /**
   * Maximum turns per episode (default 3 when omitted).
   *
   * Each `runner.run()` call executes up to `maxTurns` LLM turns internally.
   * Conversation history grows each turn, so the effective input token count
   * increases with `maxTurns`.  Pass `1` for `--quick` / baseline-sample
   * phases where episodes are intentionally single-turn.
   */
  maxTurns?: number;
  /** Model id for the agent under test. */
  agentModel: string;
  /** Model id for the analyst (predict / discover / judge fallback). */
  analystModel: string;
  /** Assembled system-prompt token counts for each environment. */
  systemTokens: { baseline: number; candidate: number };
  /**
   * When true the primary judge is external (Jev); judge cost is 0 USD but
   * call count is still reported.
   */
  judgeExternal: boolean;
}

export interface VerifyCostEstimate {
  usd: number;
  calls: number;
  breakdown: Record<string, number>;
  /** True when one or more model rows was missing from the pricing table. */
  approximate?: boolean;
}

/**
 * Estimate the total USD cost and call count for one `--verify` run.
 *
 * See the module doc for the per-call token assumptions.
 */
export function estimateVerifyCost(input: VerifyCostInput): VerifyCostEstimate {
  const {
    episodes,
    samples,
    agentModel,
    analystModel,
    systemTokens,
    judgeExternal,
  } = input;

  // Default maxTurns to 3 (the CLI default) when the caller does not supply it.
  const maxTurns = (input.maxTurns !== undefined && input.maxTurns >= 1)
    ? Math.round(input.maxTurns)
    : 3;

  // ── fixed overhead: discover + predict ──────────────────────────────────
  const discoverResult = callCost(analystModel, 20_000, 1_000);
  const predictResult = callCost(analystModel, 15_000, 2_000);

  const discoverUsd = discoverResult.usd;
  const predictUsd = predictResult.usd;

  // ── per-episode-per-sample agent calls ──────────────────────────────────
  // Each runner.run() call executes up to maxTurns LLM turns.  Conversation
  // history accumulates: turn k sees all prior user + assistant tokens in
  // its input.  We model the aggregate cost as a single call with:
  //
  //   effectiveInput  = systemTokens + maxTurns × USER_TOKENS_PER_TURN
  //                   + (maxTurns − 1) × OUTPUT_TOKENS_PER_TURN
  //   effectiveOutput = maxTurns × OUTPUT_TOKENS_PER_TURN
  //
  // System tokens are charged at full rate for every turn (conservative;
  // prompt-cache reads after turn 1 cost ~0.1× in practice, so real spend
  // is lower — the estimator intentionally errs on the high side).
  //
  // Contract: runEpisodes() in run.verify.ts issues exactly one runner.run()
  // per (episode, env, sample) tuple — one baseline call and one candidate
  // call per (episode, sample) pair.
  const historyTokens = (maxTurns - 1) * OUTPUT_TOKENS_PER_TURN;
  const nonSysTokens = maxTurns * USER_TOKENS_PER_TURN + historyTokens;
  const effectiveOut = maxTurns * OUTPUT_TOKENS_PER_TURN;

  const agentCallsPerEp = (1 + 1) * samples; // 1 baseline call + 1 candidate call × samples
  const totalAgentCalls = agentCallsPerEp * episodes;

  const agentBaselineIn = systemTokens.baseline + nonSysTokens;
  const agentCandidateIn = systemTokens.candidate + nonSysTokens;

  const agentBaselineResult = callCost(agentModel, agentBaselineIn, effectiveOut);
  const agentCandidateResult = callCost(agentModel, agentCandidateIn, effectiveOut);

  // Each episode × sample spawns 1 baseline call + 1 candidate call.
  const agentUsdPerEpSample =
    agentBaselineResult.usd + agentCandidateResult.usd;
  const agentUsdTotal = agentUsdPerEpSample * episodes * samples;

  // ── per-output judge calls ────────────────────────────────────────────────
  // 1 judge call per output = 1 per episode × per sample × 2 envs.
  const judgeCallsTotal = episodes * samples * 2;
  let judgeUsd = 0;
  if (!judgeExternal) {
    const judgeResult = callCost(analystModel, 2_000, 200);
    judgeUsd = judgeResult.usd * judgeCallsTotal;
  }

  const totalUsd = discoverUsd + predictUsd + agentUsdTotal + judgeUsd;
  const totalCalls =
    2 + // discover + predict
    totalAgentCalls +
    judgeCallsTotal;

  const approximate =
    discoverResult.approximate ||
    predictResult.approximate ||
    agentBaselineResult.approximate ||
    agentCandidateResult.approximate;

  const breakdown: Record<string, number> = {
    discover: discoverUsd,
    predict: predictUsd,
    agent: agentUsdTotal,
    judge: judgeUsd,
  };

  const result: VerifyCostEstimate = {
    usd: totalUsd,
    calls: totalCalls,
    breakdown,
  };
  if (approximate) result.approximate = true;
  return result;
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

/**
 * Running spend accumulator with cap enforcement.
 *
 * Invariant: `spent` only grows; `exceeded` is latched true and never resets.
 */
export class BudgetTracker {
  private _spent = 0;
  private readonly _max: number;

  constructor(maxUsd: number) {
    this._max = maxUsd;
  }

  /** Record additional spend in USD. */
  add(usd: number): void {
    this._spent += usd;
  }

  /** Total USD spent so far. */
  get spent(): number {
    return this._spent;
  }

  /** True when accumulated spend has exceeded the cap. */
  get exceeded(): boolean {
    return this._spent > this._max;
  }

  /** Remaining budget in USD (may be negative when exceeded). */
  remaining(): number {
    return this._max - this._spent;
  }
}

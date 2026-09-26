/**
 * Budget estimation and tracking for the what-if verification pipeline.
 *
 * Uses {@link deriveCallCostUsd} from the Anthropic-direct provider for
 * token-accurate pricing.  Unknown models fall back to a conservative
 * sonnet-class estimate and set `approximate: true` on the result.
 *
 * ## Estimation model (per episode × per sample)
 *
 * Agent model calls (×2 per episode per env):
 *   - Input: systemTokens (baseline or candidate) + 1 500 user/tool tokens.
 *   - Output: 600 tokens.
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

import { deriveCallCostUsd } from '../agent/providers/anthropic-direct/pricing.js';
import { resolveModelId } from '../agent/session/model-resolution.js';

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

  // ── fixed overhead: discover + predict ──────────────────────────────────
  const discoverResult = callCost(analystModel, 20_000, 1_000);
  const predictResult = callCost(analystModel, 15_000, 2_000);

  const discoverUsd = discoverResult.usd;
  const predictUsd = predictResult.usd;

  // ── per-episode-per-sample agent calls ──────────────────────────────────
  // 2 agent calls per episode per env (baseline + candidate), repeated for
  // each sample. Each call: systemTokens + 1500 user/tool in, 600 out.
  const agentCallsPerEp = 2 * 2 * samples; // 2 envs × 2 calls × samples
  const totalAgentCalls = agentCallsPerEp * episodes;

  const agentBaselineIn = systemTokens.baseline + 1_500;
  const agentCandidateIn = systemTokens.candidate + 1_500;
  const agentOut = 600;

  const agentBaselineResult = callCost(agentModel, agentBaselineIn, agentOut);
  const agentCandidateResult = callCost(agentModel, agentCandidateIn, agentOut);

  // Each episode × sample spawns 2 baseline calls + 2 candidate calls.
  const agentUsdPerEpSample =
    2 * agentBaselineResult.usd + 2 * agentCandidateResult.usd;
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

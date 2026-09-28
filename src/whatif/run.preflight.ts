/**
 * Preflight estimate for a `/whatif --verify` run (issue #2410).
 *
 * Computes the dollar estimate used by the `--max-usd` budget gate and emits
 * a persistent minimum-detectable-effect (MDE) line, so the user learns how
 * large a shift the planned episode count can resolve BEFORE paying for it.
 *
 * @module whatif/run.preflight
 */

import { estimateVerifyCost } from './cost.js';
import { formatMde } from './mde.js';
import type { Episode, StructuralImpact, WhatifDeps, WhatifOptions } from './types.js';

/** Human-readable preflight MDE line for `episodesPerArm` planned episodes. */
export function preflightMdeMessage(
  episodesPerArm: number,
  estimate: { mdePercent: number; nFor10pp: number },
): string {
  return (
    `${episodesPerArm} episodes/arm can detect ~${formatMde(estimate.mdePercent)} shifts; ` +
    `to detect 10pp you need ~${estimate.nFor10pp} episodes/arm`
  );
}

/**
 * Compute the preflight cost estimate and emit the MDE warning via onProgress.
 * Returns the total estimated USD (estimate.usd + already-spent analystCostUsd).
 */
export function preflightEstimate(
  episodes: readonly Episode[],
  options: WhatifOptions,
  structural: StructuralImpact,
  judgeExternal: boolean,
  analystCostUsd: number,
  onProgress: WhatifDeps['onProgress'],
): number {
  const estimate = estimateVerifyCost({
    episodes: episodes.length,
    samples: options.samples,
    agentModel: options.agentModel,
    analystModel: options.analystModel,
    systemTokens: {
      baseline: structural.tokens.baseline,
      candidate: structural.tokens.candidate,
    },
    judgeExternal,
  });
  onProgress?.({
    stage: 'episodes',
    message: preflightMdeMessage(episodes.length, estimate),
    persistent: true,
  });
  return estimate.usd + analystCostUsd;
}

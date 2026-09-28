/**
 * Failure reporting and arm-imbalance detection for the what-if engine.
 *
 * Derives per-episode failure records from raw traces and checks whether
 * failures are distributed unevenly across arms.  All functions are pure
 * (no I/O, no model calls).
 *
 * Imbalance threshold — two independent criteria, EITHER triggers a warning:
 *
 *   1. The absolute difference in per-arm failure RATES exceeds RATE_THRESHOLD
 *      (20 pp).  Rate = failed traces / total traces attempted for that arm.
 *      20 pp is conservative enough to avoid false positives on tiny runs
 *      (e.g. 1/6 vs 0/6 = 17 pp does NOT trigger) while flagging the pilot
 *      scenario (6/12 vs 0/12 = 50 pp clearly triggers).
 *
 *   2. All failures landed in a single arm AND at least MIN_FAILURES (2)
 *      failures were observed.  This catches the extreme concentration case
 *      even when the pool is small: "all 2+ failures in candidate" is
 *      informative even if each arm only had 4 traces.
 *
 * Rationale: the pilot run had 6/16 candidate traces fail and 0/26 baseline
 * traces fail — that is a 37.5 pp rate difference and a one-arm concentration,
 * so both criteria fire.  A run with 1 failure in either arm or a run with
 * equal failure rates trips neither criterion.
 *
 * @module whatif/run.failures
 */

import type { EpisodeTrace } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single episode failure, as reported in results.json and report.md.
 *
 * `probe` is the prediction id the episode was targeting, if any (from
 * `Episode.targets`).  `errorClass` collapses the raw error into a short token
 * recognisable to humans scanning a table.
 */
export interface FailedEpisodeRecord {
  episodeId: string;
  arm: 'baseline' | 'candidate';
  sample: number;
  /** Short error class: 'timeout' | 'error' */
  errorClass: 'timeout' | 'error';
  /** First 120 chars of the error message for quick diagnosis. */
  errorMessage: string;
  /** Probe / prediction id this episode was targeting, if set in Episode. */
  probe?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Arm-imbalance summary.  Present only when failures are significantly
 * unequal across arms (see module doc for thresholds).
 */
export interface ArmImbalance {
  /** Fraction of baseline traces that failed. */
  baselineFailRate: number;
  /** Fraction of candidate traces that failed. */
  candidateFailRate: number;
  /** candidateFailRate - baselineFailRate (signed). */
  rateDiff: number;
  /** True when all failures were in one arm (and >= MIN_FAILURES total). */
  allInOneArm: boolean;
  /** Which arm held all the failures, when allInOneArm is true. */
  concentrationArm?: 'baseline' | 'candidate';
  /** Human-readable summary for CLI output and report.md. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Constants (documented in the module header)
// ---------------------------------------------------------------------------

/**
 * Absolute failure-rate difference threshold that triggers the imbalance flag.
 * 20 pp: conservative enough to avoid false positives on small runs while
 * reliably catching the pilot scenario (50 pp difference).
 */
export const IMBALANCE_RATE_THRESHOLD = 0.20;

/**
 * Minimum number of total failures required for the one-arm concentration
 * criterion to trigger.  Prevents a single stray failure from raising a
 * misleading warning.
 */
export const IMBALANCE_MIN_FAILURES = 2;

// ---------------------------------------------------------------------------
// buildFailedEpisodeRecords
// ---------------------------------------------------------------------------

/**
 * Extract per-failure records from all traces.
 *
 * `episodeTargets` maps episode id to the prediction id it was written for
 * (from `Episode.targets`), so the failure record can include a `probe` field
 * for synthetic probes.
 */
export function buildFailedEpisodeRecords(
  traces: EpisodeTrace[],
  episodeTargets: Map<string, string>,
): FailedEpisodeRecord[] {
  const records: FailedEpisodeRecord[] = [];
  for (const t of traces) {
    if (!t.error) continue;
    const isTimeout = /timed? ?out/i.test(t.error);
    const errorClass: FailedEpisodeRecord['errorClass'] = isTimeout ? 'timeout' : 'error';
    const errorMessage = t.error.split('\n')[0]?.slice(0, 120) ?? t.error.slice(0, 120);
    const probe = episodeTargets.get(t.episodeId);
    records.push({
      episodeId: t.episodeId,
      arm: t.env,
      sample: t.sample,
      errorClass,
      errorMessage,
      ...(probe !== undefined ? { probe } : {}),
      durationMs: t.durationMs,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// detectArmImbalance
// ---------------------------------------------------------------------------

/**
 * Check whether failure counts are significantly imbalanced across arms.
 *
 * Returns an {@link ArmImbalance} when EITHER threshold fires; returns
 * `undefined` when the run has zero failures or the imbalance is within
 * normal variation.
 *
 * `baselineTotal` / `candidateTotal` are the total number of traces attempted
 * for each arm (including failures), so failure rates can be computed even
 * when the arms have different trace counts.
 */
export function detectArmImbalance(
  records: FailedEpisodeRecord[],
  baselineTotal: number,
  candidateTotal: number,
): ArmImbalance | undefined {
  if (records.length === 0) return undefined;

  const baselineFailed = records.filter((r) => r.arm === 'baseline').length;
  const candidateFailed = records.filter((r) => r.arm === 'candidate').length;

  const baselineRate = baselineTotal > 0 ? baselineFailed / baselineTotal : 0;
  const candidateRate = candidateTotal > 0 ? candidateFailed / candidateTotal : 0;
  const rateDiff = candidateRate - baselineRate;
  const absRateDiff = Math.abs(rateDiff);

  const totalFailed = records.length;
  const allInOneArm =
    totalFailed >= IMBALANCE_MIN_FAILURES &&
    (baselineFailed === 0 || candidateFailed === 0);
  const concentrationArm: ArmImbalance['concentrationArm'] =
    allInOneArm ? (candidateFailed > 0 ? 'candidate' : 'baseline') : undefined;

  const rateCriteria = absRateDiff >= IMBALANCE_RATE_THRESHOLD;

  if (!rateCriteria && !allInOneArm) return undefined;

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const rateLine = `baseline ${pct(baselineRate)}, candidate ${pct(candidateRate)} (${rateDiff >= 0 ? '+' : ''}${pct(rateDiff)})`;
  const concLine = allInOneArm
    ? `all ${totalFailed} failure${totalFailed === 1 ? '' : 's'} in the ${concentrationArm} arm`
    : undefined;

  const reasons = [rateCriteria ? `failure-rate difference: ${rateLine}` : null, concLine]
    .filter(Boolean)
    .join('; ');

  const summary =
    `Arm-imbalance warning: failures are concentrated in one arm (${reasons}). ` +
    `This may bias the verdict toward "no change". Consider raising --timeout or ` +
    `investigating whether the tested change causes exploration that exceeds the limit.`;

  return {
    baselineFailRate: baselineRate,
    candidateFailRate: candidateRate,
    rateDiff,
    allInOneArm,
    concentrationArm,
    summary,
  };
}

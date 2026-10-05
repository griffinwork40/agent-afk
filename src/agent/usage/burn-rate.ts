/**
 * Burn-rate projection for the subscription-quota indicator.
 *
 * Computes a time-to-cap estimate from a bounded ring of historical window
 * observations, accounting for the key pathology that motivated this feature's
 * split from the indicator: utilization *decays* while the session idles
 * (the rolling window slides, dropping old tokens), so a naïve delta over two
 * samples wildly over-predicts exhaustion whenever the session is quiet.
 *
 * Suppression rules — a projection is returned ONLY when:
 *   1. There are at least {@link MIN_SAMPLES} samples in the ring.
 *   2. The most recent sample is within {@link MAX_SAMPLE_AGE_MS} (the reading
 *      is fresh enough to act on).
 *   3. Utilization is strictly rising across at least one recent pair (idle /
 *      decaying sessions produce a negative or zero slope and are suppressed).
 *   4. The projected cap time is before `resetsAt` — after the reset the window
 *      drains, so the projection is nonsensical past that point.
 *
 * The projection math uses the rate computed between the OLDEST and NEWEST
 * samples that both show rising utilization (widest span → least noise).
 *
 * Pure module: no I/O, no module state.
 *
 * @module agent/usage/burn-rate
 */

import { WINDOWS_HISTORY_MAX } from './usage-record.js';

/** One historical snapshot, as stored in the observation ring. */
export interface WindowObservationSample {
  /** Epoch ms when this sample was taken. */
  readonly observedAt: number;
  /** Fraction consumed, 0..1. */
  readonly utilization: number;
  /** Epoch ms when the window resets, when reported. */
  readonly resetsAt?: number;
}

/** Minimum number of ring samples before a projection is computed. */
export const MIN_SAMPLES = 3;

/** A sample older than this is too stale to contribute to a projection. */
export const MAX_SAMPLE_AGE_MS = 12 * 60 * 1000; // 12 minutes

/**
 * Result of a successful burn-rate computation. `null` when suppressed (idle,
 * stale, too few samples, or projected cap is after reset).
 */
export interface BurnRateProjection {
  /**
   * Epoch ms when utilization will hit 1.0 at the observed burn rate,
   * relative to `now`. A positive value means it is in the future.
   */
  readonly capsAtMs: number;
  /** Utilization rate in fraction per millisecond (always > 0 when returned). */
  readonly ratePerMs: number;
}

/**
 * Compute a burn-rate projection from a ring of historical samples.
 *
 * @param samples - Ordered oldest-first; the ring keeps them that way.
 * @param now     - Current epoch ms (injectable for tests).
 * @param resetsAt - Epoch ms of the window reset; projection is suppressed when
 *                   the cap would occur after this.
 */
export function computeBurnRate(
  samples: readonly WindowObservationSample[],
  now: number,
  resetsAt?: number,
): BurnRateProjection | null {
  if (samples.length < MIN_SAMPLES) return null;

  // Restrict to recent samples only — contributions from a long-ago idle stint
  // dilute the slope toward zero and mask real burn.
  const cutoff = now - MAX_SAMPLE_AGE_MS;
  const recent = samples.filter((s) => s.observedAt >= cutoff);
  if (recent.length < MIN_SAMPLES) return null;

  // Find the oldest and newest sample among those that form a rising pair.
  // A rising pair: the later sample has strictly higher utilization.
  // We scan forward: if any adjacent pair is rising, the overall slope must be
  // positive, so we use the full-span oldest→newest for the rate (least noise).
  let hasRisingPair = false;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (prev !== undefined && curr !== undefined && curr.utilization > prev.utilization) {
      hasRisingPair = true;
      break;
    }
  }
  if (!hasRisingPair) return null;

  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  if (oldest === undefined || newest === undefined) return null;

  const deltaUtilization = newest.utilization - oldest.utilization;
  const deltaMs = newest.observedAt - oldest.observedAt;
  // Both guards above (MIN_SAMPLES >= 3, rising pair) ensure deltaMs > 0,
  // but a defensive check prevents division-by-zero in any future callsite.
  if (deltaMs <= 0 || deltaUtilization <= 0) return null;

  const ratePerMs = deltaUtilization / deltaMs;

  // Project from the NEWEST sample (not from now, which could be ahead of
  // the last sample if the session went idle after the last header).
  const remaining = 1.0 - newest.utilization;
  const msToCapFromNewest = remaining / ratePerMs;
  const capsAtMs = newest.observedAt + msToCapFromNewest;

  // Suppress when the projected cap is after the window reset — the reset
  // drains utilization, so the window cannot cap before then at this rate.
  if (resetsAt !== undefined && capsAtMs > resetsAt) return null;

  // Suppress when the cap is in the past (stale / mismatched samples).
  if (capsAtMs <= now) return null;

  return { capsAtMs, ratePerMs };
}

/**
 * Maximum ring size: keep only the last N samples. Any older samples are
 * trimmed when a new one is appended. Exported so callers (ledger, tests) use
 * the same constant.
 *
 * @deprecated Use {@link WINDOWS_HISTORY_MAX} directly. Kept as a re-export
 * alias for existing call-sites and tests.
 */
export const RING_SIZE: number = WINDOWS_HISTORY_MAX;

/**
 * Append one sample to an existing ring, trimming to {@link RING_SIZE}.
 * Returns a new array; the input is not mutated.
 */
export function appendSample(
  ring: readonly WindowObservationSample[],
  sample: WindowObservationSample,
): WindowObservationSample[] {
  const next = [...ring, sample];
  return next.length > RING_SIZE ? next.slice(next.length - RING_SIZE) : next;
}

/**
 * Paired per-probe sign-flip analysis for `afk whatif --verify`.
 *
 * ## What this computes (step 3 of issue #2477)
 *
 * For each prediction with probes run in both arms, we compute a SECOND
 * analysis beside the existing Newcombe-interval result. This is purely
 * ADDITIVE: it never changes the headline verdict, existing fields, or
 * verdict logic.
 *
 * ### Pairing rule
 *
 * Each episode id that has at least one graded sample in BOTH arms forms a
 * "paired probe". Episodes present in only one arm (all runs failed in that
 * arm) are unpaired and counted separately. Dropping them biases toward no
 * change (arm-imbalance issue #2494), so we always report how many were
 * dropped.
 *
 * ### Per-probe means
 *
 * For each paired episode:
 *   - baseline_mean_i = mean P(yes) across samples in the baseline arm.
 *   - candidate_mean_i = mean P(yes) across samples in the candidate arm.
 *   - d_i = candidate_mean_i − baseline_mean_i.
 *
 * These use continuous P(yes) values (not binary thresholded), so ties are
 * less common than the binary variant.
 *
 * ### Sign-flip (permutation) test
 *
 * We test H₀: median(d_i) = 0.
 *
 * Zero differences (|d_i| ≤ ZERO_TOLERANCE) contribute no information and
 * are excluded from the test (sign assignment on a zero is arbitrary and
 * would only dilute the statistic). We document the number excluded.
 *
 * ZERO_TOLERANCE = 1e-9 (one part per billion of the [0,1] scale). This is
 * larger than floating-point noise but far below any real difference — a
 * probe scoring 0.001 on one arm and 0.001000001 on the other is treated as
 * tied. We document this constant.
 *
 * Exact enumeration: when k (number of nonzero d_i) ≤ MAX_EXACT_K=16, we
 * enumerate all 2^k sign assignments over the nonzero differences.
 *
 * Monte Carlo: when k > MAX_EXACT_K we draw MONTE_CARLO_DRAWS=100_000
 * uniformly random sign assignments (seeded deterministically by XOR-hashing
 * the sorted absolute differences). The seed is a function of the data, so
 * reproducible given the same grades.
 *
 * Statistic: sum(d_i) for the observed data; compare absolute value against
 * the distribution of |sum(±d_i)| over all sign assignments.
 *
 * ### Minimum achievable p
 *
 * With k nonzero probes and exact enumeration, the minimum achievable two-
 * sided p is 2/2^k (only the all-same-sign assignments, both directions).
 * When min_p > 0.05 the test cannot reject H₀ at conventional significance
 * regardless of the direction or magnitude of the differences.
 *
 * @module whatif/probe-signflip
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Floating-point tolerance for treating a per-probe difference as zero.
 * Differences with |d| ≤ ZERO_TOLERANCE are excluded from the sign-flip
 * test (they carry no directional information). Value: 1e-9.
 */
export const ZERO_TOLERANCE = 1e-9;

/**
 * Maximum k (nonzero difference count) for exact enumeration of 2^k sign
 * assignments. Above this we switch to Monte Carlo.
 */
const MAX_EXACT_K = 16;

/**
 * Number of random sign assignments drawn in Monte Carlo mode (k > MAX_EXACT_K).
 * Fixed for reproducibility given the same data.
 */
const MONTE_CARLO_DRAWS = 100_000;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of the paired per-probe sign-flip analysis for one prediction.
 * Stored as `VerifiedPrediction.probeSignFlip`.
 */
export interface ProbeSignFlipResult {
  /**
   * Number of episodes present in both arms (used in the test).
   */
  nPaired: number;
  /**
   * Number of episodes present in only one arm (dropped from the test).
   * When > 0, these are flagged alongside the arm-imbalance report (#2494).
   */
  nUnpaired: number;
  /**
   * Number of paired probes whose |d_i| > ZERO_TOLERANCE (nonzero diffs).
   * Zeros are excluded from the test and count toward this total's complement.
   */
  nNonzero: number;
  /**
   * Mean of all paired per-probe differences (including zeros).
   * delta = mean(candidate_i − baseline_i) over paired probes.
   */
  meanDelta: number;
  /**
   * Per-probe differences d_i = candidate_mean_i − baseline_mean_i,
   * in episode order. Array length = nPaired.
   */
  probeDiffs: number[];
  /**
   * Two-sided sign-flip p-value computed on the nNonzero differences.
   * null when nPaired === 0 (no data).
   */
  p: number | null;
  /**
   * Minimum achievable two-sided p for this k (= 2 / 2^k), or null when
   * nNonzero === 0.
   */
  minAchievableP: number | null;
  /**
   * Whether the minimum achievable p exceeds 0.05.
   * When true, the test cannot reach significance at this probe count.
   */
  underpoweredForSig: boolean;
  /**
   * 'exact' when k ≤ 16 (full enumeration of 2^k assignments);
   * 'montecarlo' when k > 16 (MONTE_CARLO_DRAWS draws, fixed seed).
   */
  method: 'exact' | 'montecarlo';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple seeded PRNG (Mulberry32) for deterministic Monte Carlo.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Derive a deterministic integer seed from an array of absolute differences.
 * Sorts before hashing so the seed is order-independent.
 */
function seedFromDiffs(absDiffs: number[]): number {
  const sorted = [...absDiffs].sort((a, b) => a - b);
  let h = 0x811c9dc5;
  for (const d of sorted) {
    // Quantize to micro-units to avoid float representation noise.
    const bits = Math.round(d * 1e9) >>> 0;
    h = Math.imul(h ^ bits, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Exact two-sided sign-flip p-value.
 * Enumerates all 2^k sign assignments over `diffs` (which must be nonzero).
 * Counts assignments whose |sum| >= |obs| - EPSILON.
 */
function signflipExact(diffs: number[]): number {
  const k = diffs.length;
  const obs = Math.abs(diffs.reduce((s, d) => s + d, 0));
  let hits = 0;
  const total = 1 << k; // 2^k
  for (let mask = 0; mask < total; mask++) {
    let sum = 0;
    for (let i = 0; i < k; i++) {
      // bit i: 0 = +1, 1 = -1
      sum += (mask >> i) & 1 ? -diffs[i]! : diffs[i]!;
    }
    if (Math.abs(sum) >= obs - 1e-12) hits++;
  }
  return hits / total;
}

/**
 * Monte Carlo two-sided sign-flip p-value.
 * Draws `draws` random sign assignments (seeded from `seed`).
 */
function signflipMonteCarlo(diffs: number[], draws: number, seed: number): number {
  const k = diffs.length;
  const obs = Math.abs(diffs.reduce((s, d) => s + d, 0));
  const rand = mulberry32(seed);
  let hits = 0;
  for (let r = 0; r < draws; r++) {
    let sum = 0;
    for (let i = 0; i < k; i++) {
      sum += rand() < 0.5 ? diffs[i]! : -diffs[i]!;
    }
    if (Math.abs(sum) >= obs - 1e-12) hits++;
  }
  return hits / draws;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * One arm's graded data for a single paired episode:
 * the per-sample P(yes) values.
 */
export interface ArmSamples {
  baseline: number[];
  candidate: number[];
}

/**
 * Compute the paired per-probe sign-flip analysis for one prediction.
 *
 * @param pairedEpisodeData Map from episode id to {baseline, candidate} sample arrays.
 *   Only episodes present in BOTH arms (non-empty arrays) are counted as paired.
 *   Episodes in only one arm are counted as unpaired.
 * @param episodeOrder Episode ids in deterministic run order (for probeDiffs ordering).
 */
export function computeProbeSignFlip(
  pairedEpisodeData: Map<string, ArmSamples>,
  episodeOrder: string[],
): ProbeSignFlipResult {
  // Classify episodes: paired vs unpaired.
  const pairedIds: string[] = [];
  let nUnpaired = 0;

  for (const id of episodeOrder) {
    const arms = pairedEpisodeData.get(id);
    if (!arms) continue;
    const hasBaseline = arms.baseline.length > 0;
    const hasCandidate = arms.candidate.length > 0;
    if (hasBaseline && hasCandidate) {
      pairedIds.push(id);
    } else if (hasBaseline || hasCandidate) {
      nUnpaired++;
    }
  }

  // Also count any episode not in episodeOrder (shouldn't happen, but safe).
  for (const [id, arms] of pairedEpisodeData) {
    if (!episodeOrder.includes(id)) {
      const hasBaseline = arms.baseline.length > 0;
      const hasCandidate = arms.candidate.length > 0;
      if (hasBaseline && hasCandidate) {
        pairedIds.push(id);
      } else if (hasBaseline || hasCandidate) {
        nUnpaired++;
      }
    }
  }

  const nPaired = pairedIds.length;

  if (nPaired === 0) {
    return {
      nPaired: 0,
      nUnpaired,
      nNonzero: 0,
      meanDelta: 0,
      probeDiffs: [],
      p: null,
      minAchievableP: null,
      underpoweredForSig: true,
      method: 'exact',
    };
  }

  // Compute per-probe means and differences.
  const probeDiffs: number[] = [];
  for (const id of pairedIds) {
    const arms = pairedEpisodeData.get(id)!;
    const bMean = arms.baseline.reduce((s, v) => s + v, 0) / arms.baseline.length;
    const cMean = arms.candidate.reduce((s, v) => s + v, 0) / arms.candidate.length;
    probeDiffs.push(cMean - bMean);
  }

  const meanDelta = probeDiffs.reduce((s, d) => s + d, 0) / probeDiffs.length;

  // Filter to nonzero differences for the sign-flip test.
  const nonzeroDiffs = probeDiffs.filter((d) => Math.abs(d) > ZERO_TOLERANCE);
  const nNonzero = nonzeroDiffs.length;

  if (nNonzero === 0) {
    // All zeros — test is degenerate; p is 1.0 (every assignment matches obs=0).
    return {
      nPaired,
      nUnpaired,
      nNonzero: 0,
      meanDelta,
      probeDiffs,
      p: 1.0,
      minAchievableP: null,
      underpoweredForSig: true,
      method: 'exact',
    };
  }

  // Minimum achievable p: two assignments out of 2^k give |sum| = |sum(abs(d))|.
  const minAchievableP = 2.0 / Math.pow(2, nNonzero);
  const underpoweredForSig = minAchievableP > 0.05;

  // Compute p-value.
  let p: number;
  let method: 'exact' | 'montecarlo';

  if (nNonzero <= MAX_EXACT_K) {
    p = signflipExact(nonzeroDiffs);
    method = 'exact';
  } else {
    const seed = seedFromDiffs(nonzeroDiffs.map((d) => Math.abs(d)));
    p = signflipMonteCarlo(nonzeroDiffs, MONTE_CARLO_DRAWS, seed);
    method = 'montecarlo';
  }

  return {
    nPaired,
    nUnpaired,
    nNonzero,
    meanDelta,
    probeDiffs,
    p,
    minAchievableP,
    underpoweredForSig,
    method,
  };
}

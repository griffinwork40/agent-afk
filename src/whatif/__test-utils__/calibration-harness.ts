/**
 * Model-free calibration harness for `afk whatif --verify` verdict statistics.
 *
 * Drives `scorePrediction()` (src/whatif/run.verify.scoring.ts) with
 * synthetic `Episode[]`, `EpisodeTrace[]`, and `JudgeResults` using a
 * seeded PRNG so results are exactly reproducible without any model calls.
 *
 * ## Data model (hierarchical, as required)
 *
 * For each episode `e` in a grid cell:
 *   - Draw a per-episode baseline latent: `p_b_e ~ Beta(mean, ICC)`.
 *   - Per-episode effect delta_e ~ Normal(trueDelta, tau), clamped so
 *     `p_c_e = clip(p_b_e + delta_e)` stays in [0,1].
 *   - Each sample `s` draws a Bernoulli(p_arm_e) score (the judge result).
 *
 * This hierarchy makes #2404 visible: samples from the same episode are
 * correlated through their shared `p_e`. Feeding independent arrays into
 * `compareRates` directly would hide the intra-cluster correlation.
 *
 * ## Latent distribution — Beta parameterised by (mean, ICC)
 *
 * Using a Beta instead of a clamped Normal avoids the artefact where
 * ~21% of episodes pile up at exactly 0 or 1 (from Normal clipping), which
 * mechanically suppressed false confirms and hid the Monte Carlo symptom of
 * #2404.
 *
 * Given `mean` (μ) and `ICC` (ρ = σ²_b / (σ²_b + σ²_w)), and setting
 * σ²_w = μ(1-μ) (Bernoulli variance at the latent rate), the Beta
 * parameters are derived as:
 *
 *   σ²_b = ρ · μ(1-μ) / (1-ρ)
 *   α    = μ   · (μ(1-μ)/σ²_b - 1)
 *   β    = (1-μ) · (μ(1-μ)/σ²_b - 1)
 *
 * When ICC → 0, σ²_b → 0 and the Beta concentrates at μ (no between-episode
 * variance). When ICC → 1, α = β = 0 and the Beta is a Bernoulli (each
 * episode is entirely at 0 or 1).
 *
 * ## Effect heterogeneity — tau dimension
 *
 * `tau` (τ) is the standard deviation of the per-episode effect.  When τ > 0:
 *
 *   delta_e = delta + Normal(0, tau)
 *   p_c_e   = clip(p_b_e + delta_e, [0, 1])
 *
 * tau > 0 is the scenario where #2404 hurts most: samples are clustered
 * within episodes, AND the effect varies across episodes, so the precision
 * of the pooled estimate degrades faster than n_episodes would imply.
 *
 * ## Intra-class correlation (ICC)
 *
 * The between-episode variability is controlled by the ICC parameter (ρ).
 * Two ICC presets are provided:
 *
 *   - LOW_ICC  = 0.083   (nearly independent episodes, σ_b ≈ 0.15)
 *   - HIGH_ICC = 0.390   (strongly correlated replays, σ_b ≈ 0.40)
 *
 * These reproduce the original LOW_ICC_SD=0.15 and HIGH_ICC_SD=0.40 points.
 *
 * ## Usage
 *
 * ```ts
 * import { runGrid, HIGH_ICC, type GridCell } from
 *   '../__test-utils__/calibration-harness.js';
 *
 * const cells = runGrid({ reps: 200, seed: 42, icc: HIGH_ICC });
 * ```
 *
 * @module whatif/__test-utils__/calibration-harness
 */

import { scorePrediction, traceKey, type JudgeResults } from '../run.verify.scoring.js';
import { computeProbeSignFlip } from '../probe-signflip.js';
import type { Episode, EpisodeTrace, Prediction, Verdict } from '../types.js';

// ---------------------------------------------------------------------------
// Seeded PRNG — Mulberry32 (fast, good statistical properties, small state)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Standard Normal via Box-Muller (uses two uniform draws). */
function stdNormal(rand: () => number): number {
  const u = Math.max(1e-15, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ---------------------------------------------------------------------------
// Beta distribution sampler — Johnk's method (α,β > 0)
// ---------------------------------------------------------------------------

/**
 * Draw one sample from Beta(alpha, beta) using Johnk's method.
 * Suitable for α, β > 0.5 (harness uses α,β ≥ 0.5 by construction).
 */
function betaSample(rand: () => number, alpha: number, beta: number): number {
  // Johnk's method: generate X=U^(1/alpha), Y=V^(1/beta); accept if X+Y≤1.
  for (let i = 0; i < 1000; i++) {
    const u = rand();
    const v = rand();
    const x = u ** (1 / alpha);
    const y = v ** (1 / beta);
    if (x + y <= 1) return x / (x + y);
  }
  // Fallback: return mean (extremely rare at these α,β values)
  return alpha / (alpha + beta);
}

// ---------------------------------------------------------------------------
// ICC presets
// ---------------------------------------------------------------------------

/**
 * Low ICC ≈ 0.083 (σ_b ≈ 0.15).
 * Episodes are nearly independent.  Use as a baseline / sanity check.
 */
export const LOW_ICC = 0.083;

/**
 * High ICC ≈ 0.390 (σ_b ≈ 0.40).
 * Episodes share substantial latent variance, mirroring real agent replay
 * behaviour.  Required to expose the Monte Carlo consequence of #2404.
 */
export const HIGH_ICC = 0.390;

// Legacy σ_b constants retained for compatibility with existing tests.

/**
 * Low ICC between-episode σ.  ICC ≈ 0.15² / (0.15² + 0.25) ≈ 0.083.
 * @deprecated Use LOW_ICC instead.
 */
export const LOW_ICC_SD = 0.15;

/**
 * High ICC between-episode σ.  ICC ≈ 0.40² / (0.40² + 0.25) ≈ 0.390.
 * @deprecated Use HIGH_ICC instead.
 */
export const HIGH_ICC_SD = 0.40;

/**
 * Compute the theoretical ICC for a given between-episode σ, assuming
 * baseRate=0.5 (maximises within-episode Bernoulli variance = 0.25).
 *
 * ICC = σ_b² / (σ_b² + σ_w²),  σ_w² ≈ baseRate*(1-baseRate).
 */
export function theoreticalICC(betweenEpisodeSd: number, baseRate = 0.5): number {
  const sigmaBSq = betweenEpisodeSd ** 2;
  const sigmaWSq = baseRate * (1 - baseRate);
  return sigmaBSq / (sigmaBSq + sigmaWSq);
}

// ---------------------------------------------------------------------------
// Beta parameters from ICC and mean
// ---------------------------------------------------------------------------

interface BetaParams {
  alpha: number;
  beta: number;
}

/**
 * Derive Beta(alpha, beta) parameters from a target mean and ICC.
 *
 * σ²_b = ρ · μ(1-μ) / (1-ρ)
 * α    = μ   · (μ(1-μ)/σ²_b - 1)   [clamped to ≥0.5 to keep sampler valid]
 * β    = (1-μ) · (μ(1-μ)/σ²_b - 1) [clamped to ≥0.5]
 */
function betaFromICC(mean: number, icc: number): BetaParams {
  const mu = clamp01(mean);
  const rho = Math.max(1e-6, Math.min(1 - 1e-6, icc));
  const sigmaWSq = mu * (1 - mu);
  const sigmaBSq = (rho * sigmaWSq) / (1 - rho);
  const concentration = Math.max(0, sigmaWSq / sigmaBSq - 1);
  // Clamp to 0.5 to keep Johnk's method efficient; any ≥0.5 works.
  const alpha = Math.max(0.5, mu * concentration);
  const beta = Math.max(0.5, (1 - mu) * concentration);
  return { alpha, beta };
}

// ---------------------------------------------------------------------------
// Grid axes
// ---------------------------------------------------------------------------

export const TRUE_DELTAS = [0, 0.1, 0.3] as const;
export const EPISODE_COUNTS = [3, 6, 12] as const;
export const SAMPLE_COUNTS = [1, 3, 5] as const;
export const TAU_VALUES = [0, 0.05] as const;

export type TrueDelta = (typeof TRUE_DELTAS)[number];
export type EpisodeCount = (typeof EPISODE_COUNTS)[number];
export type SampleCount = (typeof SAMPLE_COUNTS)[number];
export type Tau = (typeof TAU_VALUES)[number];

// ---------------------------------------------------------------------------
// Cell result
// ---------------------------------------------------------------------------

/** Verdict distribution over Monte Carlo repetitions for one grid cell. */
export interface VerdictDistribution {
  confirmed: number;
  refuted: number;
  unclear: number;
  /** Number of repetitions that produced this distribution. */
  reps: number;
}

/** One cell in the calibration grid. */
export interface GridCell {
  trueDelta: TrueDelta;
  episodes: EpisodeCount;
  samples: SampleCount;
  /** Effect heterogeneity σ. 0 = homogeneous effect. */
  tau: Tau;
  dist: VerdictDistribution;
  /** P(confirmed | cell). */
  pConfirmed: number;
  /** P(refuted | cell). */
  pRefuted: number;
  /** P(unclear | cell). */
  pUnclear: number;
}

// ---------------------------------------------------------------------------
// Harness options
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /**
   * Monte Carlo repetitions per grid cell.
   * @default 400
   */
  reps?: number;
  /**
   * Seed for the PRNG; same seed → same results.
   * @default 42
   */
  seed?: number;
  /**
   * Base rate for the baseline arm (population mean p_b).
   * @default 0.5
   */
  baseRate?: number;
  /**
   * Intra-class correlation ρ ∈ (0,1).  Controls the Beta spread.
   * Use {@link LOW_ICC} (≈0.083) or {@link HIGH_ICC} (≈0.390).
   * Higher ICC makes the #2404 n-inflation effect visible in Monte Carlo.
   * @default LOW_ICC (0.083)
   */
  icc?: number;
  /**
   * @deprecated Pass `icc` instead. If both are supplied, `icc` wins.
   * Between-episode std-dev of latent rates (spread around baseRate).
   */
  betweenEpisodeSd?: number;
  /**
   * Direction of the prediction under test. Only 'added' and 'removed'
   * are calibrated here (symmetric).
   * @default 'added'
   */
  direction?: 'added' | 'removed';
  /**
   * Effect heterogeneity dimension: per-episode effect tau values to sweep.
   * When supplied, a separate grid is run for each tau value.
   * @default [0] (no heterogeneity, homogeneous effect)
   */
  tauValues?: readonly number[];
}

// ---------------------------------------------------------------------------
// Core simulation
// ---------------------------------------------------------------------------

/** Synthesise the objects that `scorePrediction` expects, run it, return verdict. */
function simulateOnce(
  rand: () => number,
  trueDelta: number,
  numEpisodes: number,
  numSamples: number,
  alpha: number,
  betaParam: number,
  tau: number,
  direction: 'added' | 'removed',
): Verdict {
  const predId = 'p_cal';
  const signedDelta = direction === 'added' ? trueDelta : -trueDelta;

  const prediction: Prediction = {
    id: predId,
    behavior: 'calibration behavior',
    direction,
    confidence: 'medium',
    reason: 'harness',
    testQuestion: 'Does the output show the calibration behavior?',
    probes: [],
  };

  const episodes: Episode[] = [];
  const traces: EpisodeTrace[] = [];
  const judgeResults: JudgeResults = new Map();

  for (let e = 0; e < numEpisodes; e++) {
    const epId = `ep_${e}`;
    // Mark as targeted synthetic probe so scorePrediction counts it.
    episodes.push({ id: epId, source: 'synthetic', prompt: `probe ${e}`, targets: predId });

    // Per-episode latent rates (Beta hierarchical model).
    const pBaseline = betaSample(rand, alpha, betaParam);

    // Per-episode effect: delta_e ~ Normal(signedDelta, tau), bounded to keep
    // candidate in [0,1] (|delta_e| ≤ 1, clamped to the feasible range).
    const deltaE = tau > 0
      ? clamp01(pBaseline + signedDelta + stdNormal(rand) * tau) - pBaseline
      : signedDelta;
    const pCandidate = clamp01(pBaseline + deltaE);

    for (let s = 0; s < numSamples; s++) {
      // Baseline trace + judge result.
      const bTrace: EpisodeTrace = {
        episodeId: epId,
        env: 'baseline',
        sample: s,
        text: '',
        tools: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
      traces.push(bTrace);
      judgeResults.set(traceKey(bTrace), {
        [predId]: rand() < pBaseline ? 1 : 0,
      });

      // Candidate trace + judge result.
      const cTrace: EpisodeTrace = {
        episodeId: epId,
        env: 'candidate',
        sample: s,
        text: '',
        tools: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
      traces.push(cTrace);
      judgeResults.set(traceKey(cTrace), {
        [predId]: rand() < pCandidate ? 1 : 0,
      });
    }
  }

  const result = scorePrediction(prediction, episodes, traces, judgeResults);
  return result.verdict;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full calibration grid and return one {@link GridCell} per
 * (trueDelta × episodes × samples × tau) combination.
 */
export function runGrid(opts: HarnessOptions = {}): GridCell[] {
  const {
    reps = 400,
    seed = 42,
    baseRate = 0.5,
    direction = 'added',
    tauValues = [0],
  } = opts;

  // Resolve ICC: explicit `icc` wins over legacy `betweenEpisodeSd`.
  const resolvedICC = opts.icc !== undefined
    ? opts.icc
    : opts.betweenEpisodeSd !== undefined
      ? theoreticalICC(opts.betweenEpisodeSd)
      : LOW_ICC;

  const { alpha, beta: betaParam } = betaFromICC(baseRate, resolvedICC);

  const rand = mulberry32(seed);
  const cells: GridCell[] = [];

  for (const tau of tauValues as Tau[]) {
    for (const trueDelta of TRUE_DELTAS) {
      for (const episodes of EPISODE_COUNTS) {
        for (const samples of SAMPLE_COUNTS) {
          const dist: VerdictDistribution = { confirmed: 0, refuted: 0, unclear: 0, reps };

          for (let r = 0; r < reps; r++) {
            const v = simulateOnce(
              rand,
              trueDelta,
              episodes,
              samples,
              alpha,
              betaParam,
              tau,
              direction,
            );
            if (v === 'confirmed') dist.confirmed++;
            else if (v === 'refuted') dist.refuted++;
            else dist.unclear++;
          }

          cells.push({
            trueDelta,
            episodes,
            samples,
            tau,
            dist,
            pConfirmed: dist.confirmed / reps,
            pRefuted: dist.refuted / reps,
            pUnclear: dist.unclear / reps,
          });
        }
      }
    }
  }

  return cells;
}

/**
 * Look up a specific cell from the grid result.
 */
export function findCell(
  cells: GridCell[],
  trueDelta: TrueDelta,
  episodes: EpisodeCount,
  samples: SampleCount,
  tau: Tau = 0,
): GridCell | undefined {
  return cells.find(
    (c) => c.trueDelta === trueDelta && c.episodes === episodes && c.samples === samples && c.tau === tau,
  );
}

// ---------------------------------------------------------------------------
// Sign-flip harness (#2477 step 3)
//
// NOTE: the harness draws both arms from the SAME per-episode latent rate
// p_b_e.  The candidate arm is p_c_e = clip(p_b_e + delta_e).  This perfect
// within-probe correlation overstates the pairing gain vs. real data, where
// the baseline and candidate probe draws are from independent runs.  Use
// these numbers for power/FPR direction only, not as production calibration.
// ---------------------------------------------------------------------------

/**
 * Sign-flip verdict: 'sig' when p < 0.05, 'nonsig' otherwise (including null p).
 * This is not a full verdict analogous to confirmed/refuted/unclear; it only
 * classifies the secondary test result.
 */
export type SignFlipVerdict = 'sig' | 'nonsig';

export interface SignFlipCell {
  trueDelta: TrueDelta;
  episodes: EpisodeCount;
  samples: SampleCount;
  tau: Tau;
  reps: number;
  /** P(p < 0.05) over reps. At delta=0 this is the false-positive rate. */
  pSig: number;
}

/**
 * One sign-flip simulation run.  Uses continuous per-episode latent means
 * (not Bernoulli samples) so the statistic is the per-probe mean P(yes).
 */
function simulateSignFlipOnce(
  rand: () => number,
  trueDelta: number,
  numEpisodes: number,
  numSamples: number,
  alpha: number,
  betaParam: number,
  tau: number,
): SignFlipVerdict {
  const episodeIds: string[] = [];
  const rawSamples = new Map<string, { baseline: number[]; candidate: number[] }>();

  for (let e = 0; e < numEpisodes; e++) {
    const epId = `ep_${e}`;
    episodeIds.push(epId);
    const pBaseline = betaSample(rand, alpha, betaParam);
    const deltaE = tau > 0
      ? clamp01(pBaseline + trueDelta + stdNormal(rand) * tau) - pBaseline
      : trueDelta;
    const pCandidate = clamp01(pBaseline + deltaE);
    const bSamples: number[] = [];
    const cSamples: number[] = [];
    for (let s = 0; s < numSamples; s++) {
      // Use raw Bernoulli draws; per-episode means are averaged inside computeProbeSignFlip.
      bSamples.push(rand() < pBaseline ? 1 : 0);
      cSamples.push(rand() < pCandidate ? 1 : 0);
    }
    rawSamples.set(epId, { baseline: bSamples, candidate: cSamples });
  }

  const r = computeProbeSignFlip(rawSamples, episodeIds);
  return r.p !== null && r.p < 0.05 ? 'sig' : 'nonsig';
}

/**
 * Run the sign-flip calibration grid.
 *
 * Returns one {@link SignFlipCell} per (trueDelta × episodes × samples × tau).
 * pSig at delta=0 is the false-positive rate; at delta>0 it is power.
 */
export function runSignFlipGrid(opts: HarnessOptions = {}): SignFlipCell[] {
  const {
    reps = 400,
    seed = 42,
    baseRate = 0.5,
    tauValues = [0],
  } = opts;

  const resolvedICC = opts.icc !== undefined
    ? opts.icc
    : opts.betweenEpisodeSd !== undefined
      ? theoreticalICC(opts.betweenEpisodeSd)
      : LOW_ICC;

  const { alpha, beta: betaParam } = betaFromICC(baseRate, resolvedICC);
  const rand = mulberry32(seed);
  const cells: SignFlipCell[] = [];

  for (const tau of tauValues as Tau[]) {
    for (const trueDelta of TRUE_DELTAS) {
      for (const episodes of EPISODE_COUNTS) {
        for (const samples of SAMPLE_COUNTS) {
          let sigCount = 0;
          for (let r = 0; r < reps; r++) {
            const v = simulateSignFlipOnce(rand, trueDelta, episodes, samples, alpha, betaParam, tau);
            if (v === 'sig') sigCount++;
          }
          cells.push({ trueDelta, episodes, samples, tau, reps, pSig: sigCount / reps });
        }
      }
    }
  }

  return cells;
}

/**
 * Look up a specific sign-flip cell from the grid result.
 */
export function findSignFlipCell(
  cells: SignFlipCell[],
  trueDelta: TrueDelta,
  episodes: EpisodeCount,
  samples: SampleCount,
  tau: Tau = 0,
): SignFlipCell | undefined {
  return cells.find(
    (c) => c.trueDelta === trueDelta && c.episodes === episodes && c.samples === samples && c.tau === tau,
  );
}

// ---------------------------------------------------------------------------

/**
 * Render the grid as a Markdown table.
 * Columns: trueDelta | episodes | samples | tau | P(confirmed) | P(refuted) | P(unclear)
 */
export function renderMarkdownTable(cells: GridCell[], includeTau = false): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const header = includeTau
    ? [
        '| true_delta | episodes | samples | tau | P(confirmed) | P(refuted) | P(unclear) |',
        '|:----------:|:--------:|:-------:|:---:|:------------:|:----------:|:----------:|',
      ]
    : [
        '| true_delta | episodes | samples | P(confirmed) | P(refuted) | P(unclear) |',
        '|:----------:|:--------:|:-------:|:------------:|:----------:|:----------:|',
      ];
  const rows = cells.map((c) =>
    includeTau
      ? `| ${c.trueDelta.toFixed(1)} | ${c.episodes} | ${c.samples} | ${c.tau.toFixed(2)} | ${pct(c.pConfirmed)} | ${pct(c.pRefuted)} | ${pct(c.pUnclear)} |`
      : `| ${c.trueDelta.toFixed(1)} | ${c.episodes} | ${c.samples} | ${pct(c.pConfirmed)} | ${pct(c.pRefuted)} | ${pct(c.pUnclear)} |`,
  );
  return [...header, ...rows].join('\n');
}

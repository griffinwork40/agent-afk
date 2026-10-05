/**
 * Score collection for the verify phase: turns per-trace judge results into
 * per-question rate comparisons, and decides WHICH episodes each prediction
 * is scored on.
 *
 * Contract (issue #2403): a prediction's verdict rests only on the episodes
 * written to exercise it, its own synthetic probes (`episode.targets ===
 * prediction.id`). Every other episode (replayed real turns, suite prompts,
 * probes written for other predictions) is still graded, because the judge
 * answers every question on every output in one call, but those scores are
 * reported as a separate `background` rate and never pooled into `rates` or
 * the verdict. Pooling them diluted a real effect roughly 10x toward zero:
 * two targeted probes moving 0 -> 1 plus eighteen irrelevant episodes at 0 in
 * both arms read as a 0.1 delta instead of 1.0.
 *
 * Contract: when a prediction has no graded output in either arm (probes
 * failed, budget stop, judge failure) its verdict is forced to `unclear`, so
 * an empty sample can never render as confirmed or refuted.
 *
 * Contract (#2409): a prediction tagged `observable: 'downstream'` at predict
 * time is always `unobservable`, whatever its rates. Its rates and scope are
 * still recorded for transparency. For every other prediction the verdict is
 * exactly `verdictFor` plus the empty-sample guard above: nothing observed in
 * the episodes (intercepted tools, trace contents) can relabel it.
 *
 * Contract (#2404): the episode is the unit of analysis. For each episode
 * the sample scores are averaged into one per-episode mean before flowing
 * into `compareRates`. This keeps n = episode count (not episodes × samples),
 * eliminating the n-inflation bug where correlated repeated samples were
 * treated as independent observations by the Newcombe CI. The reported `n`
 * in `rates` is therefore the episode count; the sample count is tracked
 * separately in `scope`.
 *
 * Discovered differences and the measured-feature table are universal, so
 * they keep using every episode (see `run.verify.ts`).
 *
 * @module whatif/run.verify.scoring
 */

import { compareRates, verdictFor } from './stats.js';
import { unobservableReason } from './observability.js';
import { computeProbeSignFlip } from './probe-signflip.js';
import type { ArmSamples } from './probe-signflip.js';
import type { Episode, EpisodeTrace, Prediction, VerifiedPrediction } from './types.js';

type Arm = 'baseline' | 'candidate';

/** Judge results keyed by {@link traceKey}. */
export type JudgeResults = Map<string, Record<string, number>>;

/** Stable key joining a trace to its judge result. */
export function traceKey(trace: Pick<EpisodeTrace, 'episodeId' | 'env' | 'sample'>): string {
  return `${trace.episodeId}:${trace.env}:${trace.sample}`;
}

// ---------------------------------------------------------------------------
// Per-episode aggregation (#2404)
// ---------------------------------------------------------------------------

/**
 * One episode's contribution to a rate comparison: the mean score across all
 * samples for that episode that had a graded judge result.
 */
interface EpisodeMean {
  episodeId: string;
  /** Mean score across all graded samples for this episode in this arm. */
  mean: number;
  /** Number of samples that contributed a graded result. */
  gradedSamples: number;
}

// Invariant (#2404): collect() returns one EpisodeMean per episode (not per
// sample). The mean is the average of all graded sample scores for that
// episode in the given arm. Episodes with no graded sample in the arm are
// excluded entirely (they contribute no evidence). This keeps n = episode
// count in compareRates, eliminating the ICC-inflated CI caused by treating
// correlated samples as independent observations.
function collectByEpisode(
  qid: string,
  env: Arm,
  goodTraces: EpisodeTrace[],
  judgeResults: JudgeResults,
  include: (episodeId: string) => boolean,
): EpisodeMean[] {
  // Group scores by episode id.
  const episodeScores = new Map<string, number[]>();
  for (const trace of goodTraces) {
    if (trace.env !== env || !include(trace.episodeId)) continue;
    const score = judgeResults.get(traceKey(trace))?.[qid];
    if (score === undefined) continue;
    const arr = episodeScores.get(trace.episodeId);
    if (arr) {
      arr.push(score);
    } else {
      episodeScores.set(trace.episodeId, [score]);
    }
  }

  // Convert to one-mean-per-episode.
  const result: EpisodeMean[] = [];
  for (const [episodeId, scores] of episodeScores) {
    result.push({
      episodeId,
      mean: scores.reduce((s, v) => s + v, 0) / scores.length,
      gradedSamples: scores.length,
    });
  }
  return result;
}

interface Collected {
  /** Per-episode mean scores; length = episode count. */
  episodeMeans: number[];
  /** Episode ids that produced at least one graded score (unordered, unique). */
  episodeIds: Set<string>;
  /** Total number of graded sample observations (for reporting). */
  totalSamples: number;
}

function collect(
  qid: string,
  env: Arm,
  goodTraces: EpisodeTrace[],
  judgeResults: JudgeResults,
  include: (episodeId: string) => boolean,
): Collected {
  const episodeMeans = collectByEpisode(qid, env, goodTraces, judgeResults, include);
  const episodeIds = new Set(episodeMeans.map((em) => em.episodeId));
  const totalSamples = episodeMeans.reduce((s, em) => s + em.gradedSamples, 0);
  return {
    episodeMeans: episodeMeans.map((em) => em.mean),
    episodeIds,
    totalSamples,
  };
}

/**
 * Per-episode mean scores for `qid` in one arm, optionally restricted to the
 * episodes `include` accepts (default: all).
 *
 * Contract (#2404): returns one value per episode (the average of that
 * episode's sample scores), NOT one value per (episode × sample). Pass the
 * result directly to `compareRates`; n in the returned RateComparison will
 * equal the number of episodes.
 */
export function scoresForQuestion(
  qid: string,
  env: Arm,
  goodTraces: EpisodeTrace[],
  judgeResults: JudgeResults,
  include: (episodeId: string) => boolean = () => true,
): number[] {
  return collect(qid, env, goodTraces, judgeResults, include).episodeMeans;
}

/** Ids from `seen`, in the run's episode order (deterministic output). */
function inEpisodeOrder(episodes: Episode[], seen: Set<string>): string[] {
  return episodes.filter((e) => seen.has(e.id)).map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Per-probe sign-flip data collection (#2477 step 3)
// ---------------------------------------------------------------------------

/**
 * Collect all raw per-sample P(yes) scores for each targeted episode in both
 * arms. Used to build the ArmSamples map for computeProbeSignFlip.
 *
 * Returns a Map from episodeId → { baseline: number[], candidate: number[] }.
 * Episodes with no graded output in either arm are still included with empty
 * arrays — the sign-flip routine classifies them as unpaired.
 */
function collectRawSamplesForProbes(
  qid: string,
  goodTraces: EpisodeTrace[],
  judgeResults: JudgeResults,
  targetedIds: Set<string>,
): Map<string, ArmSamples> {
  const result = new Map<string, ArmSamples>();

  // Initialise entries for every targeted episode.
  for (const id of targetedIds) {
    result.set(id, { baseline: [], candidate: [] });
  }

  for (const trace of goodTraces) {
    if (!targetedIds.has(trace.episodeId)) continue;
    const score = judgeResults.get(traceKey(trace))?.[qid];
    if (score === undefined) continue;
    const entry = result.get(trace.episodeId);
    if (!entry) continue;
    if (trace.env === 'baseline') {
      entry.baseline.push(score);
    } else {
      entry.candidate.push(score);
    }
  }

  return result;
}

/**
 * Score one prediction on its own probes, with every other episode reported
 * as a background rate. See the module contract.
 */
export function scorePrediction(
  prediction: Prediction,
  episodes: Episode[],
  goodTraces: EpisodeTrace[],
  judgeResults: JudgeResults,
): VerifiedPrediction {
  const targeted = new Set(episodes.filter((e) => e.targets === prediction.id).map((e) => e.id));
  const isTargeted = (id: string): boolean => targeted.has(id);
  const isOther = (id: string): boolean => !targeted.has(id);

  const b = collect(prediction.id, 'baseline', goodTraces, judgeResults, isTargeted);
  const c = collect(prediction.id, 'candidate', goodTraces, judgeResults, isTargeted);
  const rates = compareRates(b.episodeMeans, c.episodeMeans);

  const bgB = collect(prediction.id, 'baseline', goodTraces, judgeResults, isOther);
  const bgC = collect(prediction.id, 'candidate', goodTraces, judgeResults, isOther);
  const background = bgB.episodeMeans.length > 0 && bgC.episodeMeans.length > 0
    ? compareRates(bgB.episodeMeans, bgC.episodeMeans)
    : undefined;

  // Observability was decided at predict time (#2409), never from the data.
  const downstream = unobservableReason(prediction);

  // Invariant: an arm with no graded output carries no evidence; never let
  // compareRates' zero-filled rates reach verdictFor.
  const verdict = downstream !== undefined
    ? 'unobservable'
    : rates.n.baseline === 0 || rates.n.candidate === 0
      ? 'unclear'
      : verdictFor(prediction, rates);

  // Paired per-probe sign-flip analysis (#2477 step 3).
  // ADDITIVE: computed for all non-unobservable predictions with targeted
  // episodes. Never touches verdict, rates, or any other existing field.
  const episodeOrder = inEpisodeOrder(episodes, targeted);
  const rawSamples = downstream === undefined && targeted.size > 0
    ? collectRawSamplesForProbes(prediction.id, goodTraces, judgeResults, targeted)
    : undefined;
  const probeSignFlip = rawSamples !== undefined
    ? computeProbeSignFlip(rawSamples, episodeOrder)
    : undefined;

  return {
    prediction,
    rates,
    verdict,
    ...(downstream !== undefined ? { unobservableReason: downstream } : {}),
    ...(probeSignFlip !== undefined ? { probeSignFlip } : {}),
    scope: {
      episodes: {
        baseline: inEpisodeOrder(episodes, b.episodeIds),
        candidate: inEpisodeOrder(episodes, c.episodeIds),
      },
      targetedEpisodes: targeted.size,
      totalSamples: b.totalSamples + c.totalSamples,
      ...(background ? { background } : {}),
    },
  };
}

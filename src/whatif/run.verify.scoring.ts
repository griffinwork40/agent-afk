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
 * Discovered differences and the measured-feature table are universal, so
 * they keep using every episode (see `run.verify.ts`).
 *
 * @module whatif/run.verify.scoring
 */

import { compareRates, verdictFor } from './stats.js';
import type { Episode, EpisodeTrace, Prediction, VerifiedPrediction } from './types.js';

type Arm = 'baseline' | 'candidate';

/** Judge results keyed by {@link traceKey}. */
export type JudgeResults = Map<string, Record<string, number>>;

/** Stable key joining a trace to its judge result. */
export function traceKey(trace: Pick<EpisodeTrace, 'episodeId' | 'env' | 'sample'>): string {
  return `${trace.episodeId}:${trace.env}:${trace.sample}`;
}

interface Collected {
  scores: number[];
  /** Episode ids that produced at least one score (unordered, unique). */
  episodeIds: Set<string>;
}

function collect(
  qid: string,
  env: Arm,
  goodTraces: EpisodeTrace[],
  judgeResults: JudgeResults,
  include: (episodeId: string) => boolean,
): Collected {
  const scores: number[] = [];
  const episodeIds = new Set<string>();
  for (const trace of goodTraces) {
    if (trace.env !== env || !include(trace.episodeId)) continue;
    const score = judgeResults.get(traceKey(trace))?.[qid];
    if (score === undefined) continue;
    scores.push(score);
    episodeIds.add(trace.episodeId);
  }
  return { scores, episodeIds };
}

/**
 * Every graded score for `qid` in one arm, optionally restricted to the
 * episodes `include` accepts (default: all).
 */
export function scoresForQuestion(
  qid: string,
  env: Arm,
  goodTraces: EpisodeTrace[],
  judgeResults: JudgeResults,
  include: (episodeId: string) => boolean = () => true,
): number[] {
  return collect(qid, env, goodTraces, judgeResults, include).scores;
}

/** Ids from `seen`, in the run's episode order (deterministic output). */
function inEpisodeOrder(episodes: Episode[], seen: Set<string>): string[] {
  return episodes.filter((e) => seen.has(e.id)).map((e) => e.id);
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
  const rates = compareRates(b.scores, c.scores);

  const bgB = collect(prediction.id, 'baseline', goodTraces, judgeResults, isOther);
  const bgC = collect(prediction.id, 'candidate', goodTraces, judgeResults, isOther);
  const background = bgB.scores.length > 0 && bgC.scores.length > 0
    ? compareRates(bgB.scores, bgC.scores)
    : undefined;

  // Invariant: an arm with no graded output carries no evidence; never let
  // compareRates' zero-filled rates reach verdictFor.
  const verdict = rates.n.baseline === 0 || rates.n.candidate === 0
    ? 'unclear'
    : verdictFor(prediction, rates);

  return {
    prediction,
    rates,
    verdict,
    scope: {
      episodes: {
        baseline: inEpisodeOrder(episodes, b.episodeIds),
        candidate: inEpisodeOrder(episodes, c.episodeIds),
      },
      targetedEpisodes: targeted.size,
      ...(background ? { background } : {}),
    },
  };
}

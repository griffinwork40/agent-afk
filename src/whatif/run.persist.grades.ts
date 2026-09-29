/**
 * Persistence helper for per-output judge grades.
 *
 * Writes `grades.jsonl` into `runDir` alongside `traces.jsonl` and
 * `results.json`. Each line is one `GradeEntry` — one (episode, env, sample,
 * prediction) tuple with its raw P(yes) score. This is the pairing key set
 * required by the sign-flip analysis in #2477 step 3.
 *
 * Contract: this file is written ONLY on `--verify` runs, because grades are
 * produced by the judge phase. Predict-only runs have no judge and write no
 * grades file. Consumers that open the run directory must treat a missing
 * `grades.jsonl` as an empty set, not an error.
 *
 * Contract: the file is additive — it is written in a single `writeFile` call
 * alongside the other artifacts in `persistRun`, so partial states can only
 * arise from a process crash, which leaves the entire run dir inconsistent in
 * any case. It intentionally mirrors `traces.jsonl` but is distinct: one
 * `traces.jsonl` line = one episode run; one `grades.jsonl` line = one
 * (episode run × prediction) pair.
 *
 * @module whatif/run.persist.grades
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EpisodeTrace } from './types.js';
import type { JudgeResults } from './run.verify.scoring.js';
import { traceKey } from './run.verify.scoring.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row in `grades.jsonl`.
 *
 * Pairing keys for sign-flip / ICC analysis (#2477 step 3):
 *   - `episodeId` + `env` + `sample` join back to a row in `traces.jsonl`
 *   - `predictionId` joins to `verify.predictions[].prediction.id` in `results.json`
 *   - `(episodeId, predictionId)` pairs the same probe across both arms
 *   - `pYes` is the raw continuous P(yes) score from the primary judge (0–1)
 */
export interface GradeEntry {
  /** Episode id (e.g. "s1", "r3"). Matches `traces.jsonl[].episodeId`. */
  episodeId: string;
  /** Arm: "baseline" or "candidate". */
  env: 'baseline' | 'candidate';
  /** Sample index (0-based). Matches `traces.jsonl[].sample`. */
  sample: number;
  /** Prediction id (e.g. "p1"). Matches `verify.predictions[].prediction.id`. */
  predictionId: string;
  /** Raw continuous P(yes) score from the primary judge (0–1). */
  pYes: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist per-output judge grades as `grades.jsonl` under `runDir`.
 *
 * Each graded (trace × prediction) pair becomes one line. Only predictions
 * that have a grade in `judgeResults` are emitted; predictions where the
 * judge failed for that trace are omitted (matching the exclusion in scoring).
 *
 * `runDir` must already exist.
 */
export async function persistGrades(
  runDir: string,
  judgeResults: JudgeResults,
  traces: EpisodeTrace[],
  predictionIds: string[],
): Promise<void> {
  const lines: string[] = [];

  for (const trace of traces) {
    if (trace.error) continue; // failed episode: no grade
    const key = traceKey(trace);
    const grades = judgeResults.get(key);
    if (!grades) continue; // judge failure for this trace
    for (const predictionId of predictionIds) {
      const pYes = grades[predictionId];
      if (pYes === undefined) continue; // question not graded (discovered pred may follow later)
      const entry: GradeEntry = {
        episodeId: trace.episodeId,
        env: trace.env as 'baseline' | 'candidate',
        sample: trace.sample,
        predictionId,
        pYes,
      };
      lines.push(JSON.stringify(entry));
    }
  }

  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  await fsp.writeFile(path.join(runDir, 'grades.jsonl'), content, 'utf8');
}

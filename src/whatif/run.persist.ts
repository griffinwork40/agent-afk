/**
 * Persistence helpers for the what-if run output.
 *
 * Writes output files into `runDir`:
 *   - `report.md`       Markdown report
 *   - `results.json`    Full `WhatifReport` as JSON
 *   - `traces.jsonl`    All `EpisodeTrace` records, one per line
 *   - `grades.jsonl`    Per-output judge grades (verify runs only; see #2477)
 *
 * @module whatif/run.persist
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { renderMarkdown } from './report.js';
import { persistGrades } from './run.persist.grades.js';
import type { EpisodeTrace, WhatifReport } from './types.js';
import type { JudgeResults } from './run.verify.scoring.js';

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Persist run artefacts to `runDir`.
 *
 * `runDir` must already exist. Overwrites existing files.
 *
 * When `judgeResults` is supplied (verify runs only), also writes
 * `grades.jsonl` with per-output judge grades keyed by the pairing fields
 * required for sign-flip and ICC analysis (#2477 step 3).
 */
export async function persistRun(
  runDir: string,
  report: WhatifReport,
  traces: EpisodeTrace[],
  judgeResults?: JudgeResults,
): Promise<void> {
  const md = renderMarkdown(report);
  const json = JSON.stringify(report, null, 2);
  const jsonl = traces.map((t) => JSON.stringify(t)).join('\n') + (traces.length > 0 ? '\n' : '');

  const predictionIds = (report.verify?.predictions ?? []).map((vp) => vp.prediction.id);

  await Promise.all([
    fsp.writeFile(path.join(runDir, 'report.md'), md, 'utf8'),
    fsp.writeFile(path.join(runDir, 'results.json'), json, 'utf8'),
    fsp.writeFile(path.join(runDir, 'traces.jsonl'), jsonl, 'utf8'),
    ...(judgeResults !== undefined
      ? [persistGrades(runDir, judgeResults, traces, predictionIds)]
      : []),
  ]);
}

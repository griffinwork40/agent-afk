/**
 * Persistence helpers for the what-if run output.
 *
 * Writes output files into `runDir`:
 *   - `report.md`       Markdown report
 *   - `results.json`    Full `WhatifReport` as JSON
 *   - `traces.jsonl`    All `EpisodeTrace` records, one per line
 *   - `grades.jsonl`    Per-output judge grades (verify runs only; see #2477)
 *   - `sandboxes.json`  Arm-to-root mapping (only when --keep-sandboxes; see #2478)
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
 * Write `sandboxes.json` into `runDir` (NOT inside either arm root).
 *
 * Only called when `--keep-sandboxes` is set.  The file lives in the run
 * directory — outside both arm roots — so writing it never reopens the
 * arm-isolation vulnerability fixed in #2466 / #2467.
 *
 * Errors are swallowed (best-effort): a write failure must not mask the run
 * result when called from the `finally` block of `runWhatif`.
 */
export async function persistSandboxMap(
  runDir: string,
  roots: { baseline: string; candidate: string },
): Promise<void> {
  try {
    await fsp.writeFile(
      path.join(runDir, 'sandboxes.json'),
      JSON.stringify(roots, null, 2) + '\n',
      'utf8',
    );
  } catch {
    // Best-effort — do not let a write failure mask the run result.
  }
}

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

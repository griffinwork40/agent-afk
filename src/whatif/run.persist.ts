/**
 * Persistence helpers for the what-if run output.
 *
 * Writes the three output files into `runDir`:
 *   - `report.md`       Markdown report
 *   - `results.json`    Full `WhatifReport` as JSON
 *   - `traces.jsonl`    All `EpisodeTrace` records, one per line
 *
 * @module whatif/run.persist
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { renderMarkdown } from './report.js';
import type { EpisodeTrace, WhatifReport } from './types.js';

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Persist run artefacts to `runDir`.
 *
 * `runDir` must already exist. Overwrites existing files.
 */
export async function persistRun(
  runDir: string,
  report: WhatifReport,
  traces: EpisodeTrace[],
): Promise<void> {
  const md = renderMarkdown(report);
  const json = JSON.stringify(report, null, 2);
  const jsonl = traces.map((t) => JSON.stringify(t)).join('\n') + (traces.length > 0 ? '\n' : '');

  await Promise.all([
    fsp.writeFile(path.join(runDir, 'report.md'), md, 'utf8'),
    fsp.writeFile(path.join(runDir, 'results.json'), json, 'utf8'),
    fsp.writeFile(path.join(runDir, 'traces.jsonl'), jsonl, 'utf8'),
  ]);
}

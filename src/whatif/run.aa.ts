/**
 * A/A calibration fast-path for the what-if prediction engine (#2415 Step 0).
 *
 * When `--aa` is passed both arms run with zero changes (identical config).
 * The structural diff is expected to be empty; any difference indicates harness
 * asymmetry, not a real behavioural effect.  No analyst model calls are made
 * and no predictions are generated.
 *
 * Extracted from run.ts to keep that file within the 350-code-line ceiling.
 *
 * @module whatif/run.aa
 */

import { computeStructuralImpact } from './structural.js';
import { normalizeSnapshot } from './structural.normalize.js';
import { hookIsolationLimits } from './run.limits.js';
import { buildHeadline } from './report.js';
import { persistRun } from './run.persist.js';
import type {
  Environment,
  WhatifReport,
  RunnerOptions,
  ChangeSpec,
} from './types.js';
import type { WhatifOptions, WhatifDeps } from './types.orchestration.js';

/** Probe prompt used only to capture snapshots — content is irrelevant in A/A mode. */
const AA_PROBE_PROMPT = 'Briefly, what can you help me with in this project?';

/**
 * Capture structural snapshots for both arms (identical in A/A mode) and
 * return a zero-prediction {@link WhatifReport}.
 *
 * Any non-empty `structural.systemDiff` indicates harness asymmetry.
 * The caller is responsible for materialising sandboxes before invoking this.
 */
export async function runAaPhase(
  baseline: Environment,
  candidate: Environment,
  spec: ChangeSpec,
  runDir: string,
  runnerOpts: RunnerOptions,
  autoKeepContextHooks: boolean,
  options: WhatifOptions,
  deps: WhatifDeps,
): Promise<WhatifReport> {
  deps.onProgress?.({
    stage: 'snapshot',
    message: 'A/A mode: capturing structural snapshots (both arms identical)',
  });

  const [baseSnap, candSnap] = await Promise.all([
    deps.runner.snapshot(baseline, AA_PROBE_PROMPT, runnerOpts),
    deps.runner.snapshot(candidate, AA_PROBE_PROMPT, runnerOpts),
  ]);

  const real = { home: options.realHome, cwd: options.realCwd };
  const structural = computeStructuralImpact(
    normalizeSnapshot(baseSnap, baseline, real),
    normalizeSnapshot(candSnap, candidate, real),
  );

  deps.onProgress?.({
    stage: 'report',
    message: '[A/A] Zero changes — any non-empty structural diff indicates harness asymmetry',
  });

  const partial: Omit<WhatifReport, 'headline'> = {
    spec,
    structural,
    predictions: [],
    costUsd: 0,
    runDir,
    limits: [
      'A/A calibration run: both arms used identical configuration.',
      'Structural snapshots only: no episodes ran and no predictions were scored, so this checks config symmetry, not verdict calibration.',
      ...hookIsolationLimits({ keepContextHooks: autoKeepContextHooks, structural }),
    ],
  };

  const report: WhatifReport = { ...partial, headline: buildHeadline(partial) };

  await persistRun(runDir, report, [] /* traces */);

  return report;
}

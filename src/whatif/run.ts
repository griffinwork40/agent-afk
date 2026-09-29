/**
 * Main orchestrator for the what-if prediction engine.
 *
 * `runWhatif` wires together all pipeline stages:
 *   a) Sandbox materialisation
 *   b) Structural snapshots (both envs, concurrent)
 *   c) Level-1 predictions (analyst model)
 *   d) Optional verify phase (episodes → judge → discover → stats)
 *   e) Calibration ledger append
 *   f) Report build and persistence
 *
 * Callers import from `src/whatif/index.ts`; that barrel re-exports everything
 * public from this module.
 *
 * @module whatif/run
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getWhatifDir } from '../paths.js';
import { materializeSandboxes } from './sandbox.js';
import { describeChange } from './operators/index.js';
import { computeStructuralImpact } from './structural.js';
import { normalizeSnapshot } from './structural.normalize.js';
import { hookIsolationLimits, specTargetsHooksOrPlugins } from './run.limits.js';
import { keepContextHooksInEpisode } from '../agent/whatif-episode-gate.js';
import { trackRecordSummary } from './ledger.js';
import { predictChanges, resolveMaxPredictions, DEFAULT_PROBES } from './predict.js';
import { buildAndPersistVerifiedReport } from './run.report.js';
import { buildRepoManifest, pathExistsInCwd } from './repo-manifest.js';
import { groundProbes, makeSetChecker } from './probe-grounding.js';
import {
  collectRealTurns,
  syntheticEpisodes,
  loadSuiteEpisodes,
  type CorpusExclusions,
} from './episodes.js';
import { buildHeadline, standardLimits } from './report.js';
import { mdeGateRefusedMessage } from './mde.js';
import { persistRun } from './run.persist.js';
import { verifyRun } from './run.verify.js';

import { runVerifyPreflight, runBaselineSamplePhase } from './run.preflight.js';
import type {
  EpisodeTrace,
  RunnerOptions,
  WhatifDeps,
  WhatifOptions,
  WhatifProgress,
  WhatifReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Exported error class
// ---------------------------------------------------------------------------

/**
 * Thrown before running any episode when the preflight cost estimate plus
 * analyst spend would exceed `options.maxUsd`.
 */
export class WhatifBudgetError extends Error {
  readonly estimateUsd: number;
  readonly maxUsd: number;

  constructor(estimateUsd: number, maxUsd: number) {
    const ceil = (Math.ceil(estimateUsd * 100) / 100).toFixed(2);
    super(
      `whatif: estimated cost $${estimateUsd.toFixed(4)} exceeds --max-usd $${maxUsd.toFixed(4)}. ` +
        `Raise the budget with --max-usd ${ceil}, or reduce scope with ` +
        `--probes/--max-predictions/--samples/--turns.`,
    );
    this.name = 'WhatifBudgetError';
    this.estimateUsd = estimateUsd;
    this.maxUsd = maxUsd;
  }
}

/**
 * Thrown before running any episode when the run is underpowered (MDE exceeds
 * the gate threshold) and `--force` was not passed.
 *
 * `episodesPerArm` is the minimum probe count per prediction (the unit that
 * drives per-prediction power).
 */
export class WhatifMdeError extends Error {
  readonly episodesPerArm: number;
  readonly kind: 'mde' | 'headroom';
  readonly predictionId?: string;

  constructor(
    minProbesPerPrediction: number,
    message?: string,
    opts?: { kind?: 'mde' | 'headroom'; predictionId?: string },
  ) {
    super(message ?? mdeGateRefusedMessage(minProbesPerPrediction));
    this.name = 'WhatifMdeError';
    this.episodesPerArm = minProbesPerPrediction;
    this.kind = opts?.kind ?? 'mde';
    this.predictionId = opts?.predictionId;
  }
}

// ---------------------------------------------------------------------------
// Internal phase helpers
// ---------------------------------------------------------------------------

interface PredictPhaseResult {
  structural: ReturnType<typeof computeStructuralImpact>;
  predictions: import('./types.js').Prediction[];
  analystCostUsd: number;
  changeKinds: string[];
  droppedProbes: import('./probe-grounding.js').DroppedProbe[];
}

/**
 * Run the snapshot + predict phase: capture both env snapshots concurrently,
 * compute the structural diff, then call the analyst model for predictions.
 */
async function runPredictPhase(
  baseline: import('./types.js').Environment,
  candidate: import('./types.js').Environment,
  spec: import('./types.js').ChangeSpec,
  options: WhatifOptions,
  deps: WhatifDeps,
  runnerOpts: import('./types.js').RunnerOptions,
): Promise<PredictPhaseResult> {
  const PROBE_PROMPT = 'Briefly, what can you help me with in this project?';

  deps.onProgress?.({ stage: 'snapshot', message: 'Capturing structural snapshots' });

  const [baselineSnap, candidateSnap] = await Promise.all([
    deps.runner.snapshot(baseline, PROBE_PROMPT, runnerOpts),
    deps.runner.snapshot(candidate, PROBE_PROMPT, runnerOpts),
  ]);

  const real = { home: options.realHome, cwd: options.realCwd };
  const structural = computeStructuralImpact(
    normalizeSnapshot(baselineSnap, baseline, real),
    normalizeSnapshot(candidateSnap, candidate, real),
  );

  deps.onProgress?.({ stage: 'predict', message: 'Generating predictions' });

  const changeKinds = spec.changes.map((c) => c.kind);
  const changeDescriptions = spec.changes.map((c) => describeChange(c));
  const trackRecord = await trackRecordSummary(changeKinds);

  let analystCostUsd = 0;
  const wrappedComplete: typeof deps.complete = async (req) => {
    const result = await deps.complete(req);
    analystCostUsd += result.costUsd;
    return result;
  };

  const repoManifest = buildRepoManifest(options.realCwd);

  const probesPerPrediction = options.probes ?? DEFAULT_PROBES;
  const maxPredictions = resolveMaxPredictions(probesPerPrediction, options.maxPredictions);

  const rawPredictions = await predictChanges(
    { spec, changeDescriptions, structural, trackRecord, repoManifest, probesPerPrediction, maxPredictions },
    wrappedComplete,
    options.analystModel,
  );

  // Tracked-path set first (empty set outside git → pass-through), then the
  // filesystem, so directories and untracked-but-real files are not dropped.
  const tracked = makeSetChecker(repoManifest.allPaths);
  const { predictions, droppedProbes } = groundProbes(
    rawPredictions,
    (p) => tracked(p) || pathExistsInCwd(options.realCwd, p),
  );

  return { structural, predictions, analystCostUsd, changeKinds, droppedProbes };
}

/**
 * Collect all episode sources for the verify phase.
 */
async function collectVerifyEpisodes(
  options: WhatifOptions & { sessionsDir?: string },
  predictions: import('./types.js').Prediction[],
): Promise<{ episodes: import('./types.js').Episode[]; corpusExclusions: CorpusExclusions }> {
  const corpusExclusions: CorpusExclusions = {
    whatifSessions: 0, excludedSessionIds: 0,
    nonStandaloneTurns: 0, whatifTopicTurns: 0,
  };
  const realTurns = await collectRealTurns({
    limit: options.turns,
    sessionsDir: options.sessionsDir,
    stats: corpusExclusions,
  });
  const synthetic = syntheticEpisodes(predictions);
  const suitesDir = path.join(options.realHome, 'whatif', 'suites');
  const suiteEps = await loadSuiteEpisodes(suitesDir).catch(() => []);
  // Invariant: synthetic probe episodes MUST come before replay turns.
  // run.verify.ts builds tasks in episode order and the budget stop drops the
  // tail; if replay turns come first they consume budget that would otherwise
  // score predictions (replay turns target no prediction after #2427).
  return { episodes: [...synthetic, ...realTurns, ...suiteEps], corpusExclusions };
}

// ---------------------------------------------------------------------------
// Run-dir helper
// ---------------------------------------------------------------------------

function dateStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}` +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

// Preflight helper and probe-count helper extracted to run.preflight.ts (#2511).

// ---------------------------------------------------------------------------
// runWhatif
// ---------------------------------------------------------------------------

/**
 * Run the full what-if pipeline and return a {@link WhatifReport}.
 *
 * Contract additions vs types.ts:
 *   - `options.sessionsDir?` — optional override for the sessions directory
 *     used by `collectRealTurns`. Tests inject a temp dir here.
 */
export async function runWhatif(
  options: WhatifOptions & { sessionsDir?: string },
  deps: WhatifDeps,
): Promise<WhatifReport> {
  const now = deps.now?.() ?? new Date();
  const { spec, realHome, realCwd } = options;

  // ── a) Run directory ──────────────────────────────────────────────────────

  // Run dir is a timestamp plus an opaque suffix — omitting the change title
  // keeps the path opaque to the agent during an episode (issue #2425), and
  // the suffix stops two runs started in the same second from colliding.
  // The title is recorded in results.json so it is never lost.
  const runDir = path.join(
    getWhatifDir(),
    `${dateStamp(now)}-${randomBytes(3).toString('hex')}`,
  );
  await fsp.mkdir(runDir, { recursive: true });

  deps.onProgress?.({ stage: 'sandbox', message: 'Materialising sandboxes' });

  // ── b) Sandboxes ──────────────────────────────────────────────────────────

  // When the change spec directly targets hooks or plugins, keep context hooks
  // on in both episode arms so the hooks under test actually register and can
  // be observed.  Without this, both arms would run with SessionStart and
  // UserPromptSubmit suppressed, making the experiment measure nothing.
  // The manual AFK_WHATIF_KEEP_CONTEXT_HOOKS=1 override takes the same path.
  const autoKeepContextHooks =
    specTargetsHooksOrPlugins(spec) || keepContextHooksInEpisode();

  const sandboxes = await materializeSandboxes({
    realHome,
    realCwd,
    runDir,
    spec,
    baseLaunch: {
      model: options.agentModel,
      env: autoKeepContextHooks ? { AFK_WHATIF_KEEP_CONTEXT_HOOKS: '1' } : {},
    },
  });

  const { baseline, candidate } = sandboxes;

  const runnerOpts: RunnerOptions = {
    timeoutMs: options.episodeTimeoutMs,
    maxTurns: 1,
    signal: deps.signal,
  };

  try {
    // ── c+d) Snapshots + Predictions ─────────────────────────────────────

    const { structural, predictions, analystCostUsd: predictCost, changeKinds, droppedProbes } =
      await runPredictPhase(baseline, candidate, spec, options, deps, runnerOpts);

    let analystCostUsd = predictCost;

    // ── e) Predict-only path ──────────────────────────────────────────────

    if (!options.verify) {
      const limits = [
        ...standardLimits({ verified: false, judgeExternal: false }),
        ...hookIsolationLimits({ keepContextHooks: autoKeepContextHooks, structural }),
      ];
      const partialReport: Omit<WhatifReport, 'headline'> = {
        spec,
        structural,
        predictions,
        costUsd: analystCostUsd,
        runDir,
        limits,
        ...(droppedProbes.length > 0 ? { droppedProbes } : {}),
      };
      const headline = buildHeadline(partialReport);
      const report: WhatifReport = { ...partialReport, headline };

      await persistRun(runDir, report, []);
      return report;
    }

    // ── f) Verify phase ───────────────────────────────────────────────────

    deps.onProgress?.({ stage: 'episodes', message: 'Collecting episodes' });

    const { episodes, corpusExclusions } = await collectVerifyEpisodes(options, predictions);

    // Resolve judge BEFORE preflight estimate (so we know if it's external)
    const resolvedJudge = await deps.makeJudge(options.judge);
    const crossCheckJudge = await deps.makeCrossCheckJudge().catch((err: unknown) => {
      console.warn(`[whatif/run] cross-check judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });

    // Preflight: MDE gate + headroom gate + budget gate (includes sample cost #2511).
    const { noBaselineSample } = await runVerifyPreflight({
      episodes, predictions, structural, force: options.force ?? false,
      samples: options.samples, agentModel: options.agentModel,
      analystModel: options.analystModel, judgeExternal: resolvedJudge.external,
      analystCostUsd, maxUsd: options.maxUsd,
      noBaselineSample: options.noBaselineSample ?? false,
      onProgress: deps.onProgress as ((p: { stage: 'preflight'; message: string }) => void) | undefined,
      closeJudges: async () => { await resolvedJudge.close?.(); await crossCheckJudge?.close?.(); },
    });

    // Baseline-sample preflight (#2511). Extracted to runBaselineSamplePhase.
    // NOTE: sample traces are NOT reused in the final verifyRun (keeps arms paired).
    const baselineSampleResult = await runBaselineSamplePhase({
      noBaselineSample,
      predictions,
      episodes,
      baseline,
      runner: deps.runner,
      judge: resolvedJudge,
      episodeTimeoutMs: options.episodeTimeoutMs,
      maxTurns: options.maxTurns,
      signal: deps.signal,
      onProgress: deps.onProgress as ((p: WhatifProgress) => void) | undefined,
      closeJudges: async () => {
        await resolvedJudge.close?.();
        await crossCheckJudge?.close?.();
      },
      runDir,
    });

    deps.onProgress?.({ stage: 'run', message: 'Running episodes' });

    let verifyResult: Awaited<ReturnType<typeof verifyRun>>['verifyResult'] | undefined;
    let verifyTraces: EpisodeTrace[] = [];
    let verifyJudgeResults: Awaited<ReturnType<typeof verifyRun>>['judgeResults'] | undefined;
    let verifyCost = 0;
    try {
      const out = await verifyRun({
        episodes,
        baseline,
        candidate,
        predictions,
        structural,
        judge: resolvedJudge,
        crossCheckJudge,
        runner: deps.runner,
        complete: deps.complete,
        analystModel: options.analystModel,
        options: {
          samples: options.samples,
          concurrency: options.concurrency,
          maxTurns: options.maxTurns,
          episodeTimeoutMs: options.episodeTimeoutMs,
          maxUsdRemaining: options.maxUsd - analystCostUsd,
          changeKinds,
        },
        onProgress: deps.onProgress,
        signal: deps.signal,
      });
      verifyResult = out.verifyResult;
      verifyTraces = out.allTraces;
      verifyJudgeResults = out.judgeResults;
      verifyCost = out.analystCostUsd;
    } finally {
      await resolvedJudge.close?.();
      await crossCheckJudge?.close?.();
    }

    analystCostUsd += verifyCost;

    return buildAndPersistVerifiedReport({
      spec, structural, predictions, verifyResult: verifyResult!, droppedProbes,
      corpusExclusions, verifyTraces, analystCostUsd, runDir,
      resolvedJudge, autoKeepContextHooks,
      judgeResults: verifyJudgeResults!,
      ...(baselineSampleResult ? { baselineSamplePerPrediction: baselineSampleResult.perPrediction } : {}),
    });
  } finally {
    // Tear down sandboxes unless keepSandboxes
    if (!options.keepSandboxes) {
      await sandboxes.cleanup().catch(() => {
        // Best-effort; do not mask the primary error
      });
    }
  }
}

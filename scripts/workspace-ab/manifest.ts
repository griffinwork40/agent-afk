/**
 * Experiment manifest — the machine-readable record of a completed A/B run.
 *
 * One manifest is written per full N-trial run.  It records all fields
 * required for reproducibility, provenance, and downstream analysis:
 * model, provider, prompt hash, git SHA, runtime version, cost, duration,
 * trial order, per-arm trace identity, and the aggregated dedup metrics.
 *
 * @module scripts/workspace-ab/manifest
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TrialResult } from './compare.js';

// ─── Manifest shape ────────────────────────────────────────────────────────

export interface ArmManifestEntry {
  arm: 'control' | 'treatment';
  trialIndex: number;
  trialOrder: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
  sessionId?: string;
  witnessLabel?: string;
  tracePath?: string;
  stdoutPath: string;
  stderrPath: string;
  /** Aggregated dedup metrics from analyze(). Absent when validation failed. */
  dedupMetrics?: {
    totalCalls: number;
    crossAgentDuplicates: number;
    crossAgentDedupRatio: number;
    crossAgentFileOverlapRatio: number | null;
    distinctAgents: number;
  };
  validationPassed: boolean;
  validationFailures: string[];
}

export interface ExperimentManifest {
  /** ISO-8601 timestamp of experiment start. */
  startedAt: string;
  /** ISO-8601 timestamp of experiment completion. */
  completedAt: string;
  model: string;
  /** SHA-256 hex digest of the experiment prompt (both arms identical). */
  promptHash: string;
  /** Short git SHA of HEAD at experiment time. */
  gitSha: string;
  /** Node.js runtime version (process.version). */
  nodeVersion: string;
  /** Number of paired trials requested. */
  trialCount: number;
  /** Per-arm trial records in trial order. */
  trials: ArmManifestEntry[];
  /** Summary statistics across valid trials. */
  summary: {
    validTrials: number;
    controlAvgDedupRatio: number | null;
    treatmentAvgDedupRatio: number | null;
    /** treatment ratio − control ratio (negative = workspace helped). */
    dedupRatioDelta: number | null;
    controlAvgDurationMs: number | null;
    treatmentAvgDurationMs: number | null;
    totalCostUsd: number | null;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function safeGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── Build manifest ────────────────────────────────────────────────────────

export function buildManifest(opts: {
  startedAt: string;
  model: string;
  promptHash: string;
  trialCount: number;
  trials: TrialResult[];
}): ExperimentManifest {
  const { startedAt, model, promptHash, trialCount, trials } = opts;

  const entries: ArmManifestEntry[] = [];
  for (const trial of trials) {
    for (const armResult of [trial.control, trial.treatment]) {
      const entry: ArmManifestEntry = {
        arm: armResult.arm,
        trialIndex: armResult.trialIndex,
        trialOrder: armResult.trialOrder,
        exitCode: armResult.exitCode,
        success: armResult.success,
        durationMs: armResult.durationMs,
        sessionId: armResult.sessionId,
        witnessLabel: armResult.witnessLabel,
        tracePath: armResult.tracePath,
        stdoutPath: armResult.stdoutPath,
        stderrPath: armResult.stderrPath,
        validationPassed: trial.validation[armResult.arm].valid,
        validationFailures: trial.validation[armResult.arm].failures.map((f) => f.message),
      };
      const metrics = trial.metrics[armResult.arm];
      if (metrics) {
        entry.dedupMetrics = {
          totalCalls: metrics.totalCalls,
          crossAgentDuplicates: metrics.crossAgentDuplicates,
          crossAgentDedupRatio: metrics.crossAgentDedupRatio,
          crossAgentFileOverlapRatio: metrics.crossAgentFileOverlapRatio,
          distinctAgents: metrics.distinctAgents,
        };
      }
      entries.push(entry);
    }
  }

  const validControlRatios = entries
    .filter((e) => e.arm === 'control' && e.validationPassed && e.dedupMetrics)
    .map((e) => e.dedupMetrics!.crossAgentDedupRatio);
  const validTreatmentRatios = entries
    .filter((e) => e.arm === 'treatment' && e.validationPassed && e.dedupMetrics)
    .map((e) => e.dedupMetrics!.crossAgentDedupRatio);
  const validControlDurations = entries
    .filter((e) => e.arm === 'control' && e.validationPassed)
    .map((e) => e.durationMs);
  const validTreatmentDurations = entries
    .filter((e) => e.arm === 'treatment' && e.validationPassed)
    .map((e) => e.durationMs);

  const controlAvg = avg(validControlRatios);
  const treatmentAvg = avg(validTreatmentRatios);

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    model,
    promptHash,
    gitSha: safeGitSha(),
    nodeVersion: process.version,
    trialCount,
    trials: entries,
    summary: {
      // A paired trial is usable only when BOTH arms passed validation and
      // produced dedup metrics; counting them independently and taking Math.min
      // overstates valid pairs when failures are asymmetric (e.g. control passed
      // on 3 trials, treatment passed on 2 different ones — Math.min returns 2
      // but zero pairs actually share the same trial index).
      validTrials: trials.filter((t) => t.usable).length,
      controlAvgDedupRatio: controlAvg,
      treatmentAvgDedupRatio: treatmentAvg,
      dedupRatioDelta:
        controlAvg !== null && treatmentAvg !== null ? treatmentAvg - controlAvg : null,
      controlAvgDurationMs: avg(validControlDurations),
      treatmentAvgDurationMs: avg(validTreatmentDurations),
      totalCostUsd: null, // cost-per-trial data not yet available; reserved for a future instrumentation pass
    },
  };
}

// ─── Write manifest + markdown ─────────────────────────────────────────────

export function writeManifest(manifest: ExperimentManifest, outputDir: string): {
  manifestPath: string;
  markdownPath: string;
} {
  mkdirSync(outputDir, { recursive: true });
  const ts = manifest.startedAt.replace(/[:.]/g, '-');
  const manifestPath = join(outputDir, `manifest-${ts}.json`);
  const markdownPath = join(outputDir, `summary-${ts}.md`);

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(markdownPath, buildMarkdown(manifest));
  return { manifestPath, markdownPath };
}

function pct(n: number | null): string {
  if (n === null) return 'N/A';
  return (n * 100).toFixed(1) + '%';
}

function ms(n: number | null): string {
  if (n === null) return 'N/A';
  return (n / 1000).toFixed(1) + 's';
}

function buildMarkdown(m: ExperimentManifest): string {
  const s = m.summary;
  return [
    `# Workspace A/B Experiment — ${m.startedAt}`,
    '',
    '## Setup',
    '',
    `- **Model**: ${m.model}`,
    `- **Trials**: ${m.trialCount} (${s.validTrials} valid)`,
    `- **Git SHA**: ${m.gitSha}`,
    `- **Node**: ${m.nodeVersion}`,
    `- **Prompt hash**: ${m.promptHash.slice(0, 16)}…`,
    '',
    '## Summary',
    '',
    '| Metric | Control (no workspace) | Treatment (workspace) |',
    '|--------|------------------------|----------------------|',
    `| Avg cross-agent dedup ratio | ${pct(s.controlAvgDedupRatio)} | ${pct(s.treatmentAvgDedupRatio)} |`,
    `| Avg wall-clock duration | ${ms(s.controlAvgDurationMs)} | ${ms(s.treatmentAvgDurationMs)} |`,
    `| Dedup ratio delta (treatment − control) | | **${pct(s.dedupRatioDelta)}** |`,
    '',
    '> A negative delta means workspace reduced redundant cross-agent reads.',
    '',
    '## Trial Detail',
    '',
    m.trials.map((t) => {
      const status = t.validationPassed ? '✅' : `❌ ${t.validationFailures[0] ?? ''}`;
      const ratio = t.dedupMetrics ? pct(t.dedupMetrics.crossAgentDedupRatio) : 'N/A';
      return `- Trial ${t.trialIndex} ${t.arm} (${t.trialOrder}): ${status} ratio=${ratio} dur=${ms(t.durationMs)}`;
    }).join('\n'),
  ].join('\n');
}

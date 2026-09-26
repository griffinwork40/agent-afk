#!/usr/bin/env tsx
/**
 * Fail-closed TypeScript orchestrator for the workspace A/B experiment.
 *
 * Replaces `scripts/run-workspace-ab-test.sh` with a deterministic,
 * type-safe runner that:
 *   - Requires the afk binary to exist before starting (fail-closed).
 *   - Keeps stdout and stderr separate per arm.
 *   - Treats any nonzero arm exit as experiment failure.
 *   - Identifies traces by sessionId/tracePath from JSON output (no ls -t race).
 *   - Validates both traces via validate() before comparing.
 *   - Runs ≥5 paired trials (configurable via --trials, min enforced).
 *   - Alternates arm order per trial to reduce warm-cache/rate-limit bias.
 *   - Records model, promptHash, gitSha, nodeVersion, cost, duration, trialOrder.
 *   - Writes a machine-readable manifest + Markdown summary per run.
 *
 * Usage:
 *   pnpm experiment:workspace [--model <m>] [--trials <n>] [--dry-run] [--help]
 *
 * @module scripts/run-workspace-ab-test
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXPERIMENT_PROMPT, promptHash } from './workspace-ab/prompt.js';
import { runArm } from './workspace-ab/run-arm.js';
import type { ArmResult } from './workspace-ab/run-arm.js';
import { compareTrialPair } from './workspace-ab/compare.js';
import type { TrialResult } from './workspace-ab/compare.js';
import { buildManifest, writeManifest } from './workspace-ab/manifest.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const MIN_TRIALS = 5;
const DEFAULT_TRIALS = 5;
const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_BUDGET_USD = 3;

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseCliArgs(): {
  model: string;
  trials: number;
  maxTurns: number;
  maxBudgetUsd: number;
  dryRun: boolean;
  outputDir: string;
  afkBin: string;
} {
  const { values } = parseArgs({
    options: {
      model:        { type: 'string', default: DEFAULT_MODEL },
      trials:       { type: 'string', default: String(DEFAULT_TRIALS) },
      'max-turns':  { type: 'string', default: String(DEFAULT_MAX_TURNS) },
      'max-budget': { type: 'string', default: String(DEFAULT_MAX_BUDGET_USD) },
      // Invariant: --budget is a deprecated alias for --max-budget; it was the
      // original flag name before the CLI was standardised.  strict:false silently
      // drops unknown flags, so without this alias `--budget 5` would be ignored
      // with no error, leaving the default 3 USD ceiling in effect.
      'budget':     { type: 'string' },
      'dry-run':    { type: 'boolean', default: false },
      'output-dir': { type: 'string' },
      'afk-bin':    { type: 'string' },
      help:         { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: false,
  });

  if (values['budget'] !== undefined && values['max-budget'] === undefined) {
    console.warn('Warning: --budget is deprecated; use --max-budget instead.');
  }

  if (values.help) {
    console.log([
      'Usage: pnpm experiment:workspace [options]',
      '',
      'Options:',
      '  --model <m>       Model alias (default: sonnet)',
      '  --trials <n>      Number of paired trials (min 5, default 5)',
      '  --max-turns <n>   Max conversation turns per arm (default 25)',
      '  --max-budget <$>  Max cost per arm in USD (default 3)',
      '  --budget <$>      Deprecated alias for --max-budget',
      '  --dry-run         Print plan and exit without spawning agents',
      '  --output-dir <d>  Results directory (default: scripts/ab-results/<ts>)',
      '  --afk-bin <p>     Path to afk CLI entry (default: dist/cli/index.js)',
      '  --help            Show this help',
    ].join('\n'));
    process.exit(0);
  }

  const trials = Number(values.trials ?? DEFAULT_TRIALS);
  if (!Number.isInteger(trials) || trials < MIN_TRIALS) {
    console.error(`Error: --trials must be an integer ≥ ${MIN_TRIALS} (got ${values.trials})`);
    process.exit(1);
  }

  const repoRoot = resolve(new URL('.', import.meta.url).pathname, '..');
  const defaultAfkBin = join(repoRoot, 'dist', 'cli', 'index.js');

  return {
    model: String(values.model ?? DEFAULT_MODEL),
    trials,
    maxTurns: Number(values['max-turns'] ?? DEFAULT_MAX_TURNS),
    // Prefer --max-budget; fall back to deprecated --budget alias.
    maxBudgetUsd: Number(values['max-budget'] ?? values['budget'] ?? DEFAULT_MAX_BUDGET_USD),
    dryRun: Boolean(values['dry-run']),
    outputDir: values['output-dir']
      ? resolve(String(values['output-dir']))
      : join(repoRoot, 'scripts', 'ab-results', new Date().toISOString().replace(/[:.]/g, '-')),
    afkBin: values['afk-bin'] ? resolve(String(values['afk-bin'])) : defaultAfkBin,
  };
}

// ─── Pre-flight check ───────────────────────────────────────────────────────

function assertAfkBinExists(afkBin: string): void {
  if (!existsSync(afkBin)) {
    console.error([
      `Error: afk binary not found at ${afkBin}`,
      '',
      'Build first:',
      '  pnpm build',
      '',
      'Or specify a custom path:',
      '  pnpm experiment:workspace --afk-bin /path/to/dist/cli/index.js',
    ].join('\n'));
    process.exit(1);
  }
}

// ─── Credential check ──────────────────────────────────────────────────────

function assertCredentialPresent(): void {
  const { ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN } = process.env;
  if (!ANTHROPIC_API_KEY && !CLAUDE_CODE_OAUTH_TOKEN) {
    console.error([
      'Error: No Anthropic credential found.',
      '',
      'Fix (choose one):',
      '  export ANTHROPIC_API_KEY=sk-ant-...',
      '  afk login',
      '  afk config set env ANTHROPIC_API_KEY <key>',
    ].join('\n'));
    process.exit(1);
  }
}

// ─── Trial order ────────────────────────────────────────────────────────────

/** Alternates which arm runs first to reduce warm-cache / rate-limit bias. */
function trialArmOrder(trialIndex: number): 'control-first' | 'treatment-first' {
  return trialIndex % 2 === 0 ? 'control-first' : 'treatment-first';
}

// ─── Real trace parser (dynamic import to keep this file slim) ─────────────

async function realParseTrace(tracePath: string, allTools: boolean) {
  const mod = await import('../scripts/measure-read-dedup.js').catch(async () =>
    // fallback: try relative from repo root
    import('./measure-read-dedup.js')
  );
  return mod.parseTrace(tracePath, allTools);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();
  const { model, trials, maxTurns, maxBudgetUsd, dryRun, outputDir, afkBin } = opts;

  // Pre-flight
  assertAfkBinExists(afkBin);
  assertCredentialPresent();

  const hash = promptHash(EXPERIMENT_PROMPT);
  const startedAt = new Date().toISOString();

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Workspace A/B Experiment (TypeScript runner)                ║');
  console.log(`║  Model: ${model.padEnd(10)}  Trials: ${trials}  Started: ${startedAt.slice(0, 19)}  ║`);
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`  afk binary:   ${afkBin}`);
  console.log(`  output dir:   ${outputDir}`);
  console.log(`  prompt hash:  ${hash.slice(0, 16)}…`);
  console.log();

  if (dryRun) {
    console.log('[DRY RUN] Plan:');
    for (let i = 0; i < trials; i++) {
      const order = trialArmOrder(i);
      console.log(`  Trial ${i}: order=${order}  control: AFK_WORKSPACE_DISABLED=1  treatment: workspace enabled`);
    }
    console.log();
    console.log('[DRY RUN] Prompt:');
    console.log(EXPERIMENT_PROMPT.slice(0, 300) + '…');
    return;
  }

  const trialResults: TrialResult[] = [];
  let failureCount = 0;

  for (let i = 0; i < trials; i++) {
    const order = trialArmOrder(i);
    console.log(`─── Trial ${i + 1}/${trials} (${order}) ─────────────────────────────────────────────`);

    const armOpts = {
      afkBin,
      model,
      maxTurns,
      maxBudgetUsd,
      prompt: EXPERIMENT_PROMPT,
      outputDir,
    };

    let controlResult: ArmResult;
    let treatmentResult: ArmResult;

    // Run arms in alternating order per trial.
    if (order === 'control-first') {
      console.log(`  [${i}] Running control arm…`);
      controlResult = await runArm({ ...armOpts, arm: 'control', trialIndex: i, trialOrder: order });
      console.log(`  [${i}] Running treatment arm…`);
      treatmentResult = await runArm({ ...armOpts, arm: 'treatment', trialIndex: i, trialOrder: order });
    } else {
      console.log(`  [${i}] Running treatment arm…`);
      treatmentResult = await runArm({ ...armOpts, arm: 'treatment', trialIndex: i, trialOrder: order });
      console.log(`  [${i}] Running control arm…`);
      controlResult = await runArm({ ...armOpts, arm: 'control', trialIndex: i, trialOrder: order });
    }

    console.log(`  [${i}] control: exit=${controlResult.exitCode} dur=${(controlResult.durationMs / 1000).toFixed(1)}s sess=${controlResult.sessionId ?? 'n/a'}`);
    console.log(`  [${i}] treatment: exit=${treatmentResult.exitCode} dur=${(treatmentResult.durationMs / 1000).toFixed(1)}s sess=${treatmentResult.sessionId ?? 'n/a'}`);

    try {
      const trialResult = await compareTrialPair(controlResult, treatmentResult, realParseTrace);
      trialResults.push(trialResult);

      const controlValid = trialResult.validation.control.valid;
      const treatmentValid = trialResult.validation.treatment.valid;
      const cRatio = trialResult.metrics.control?.crossAgentDedupRatio;
      const tRatio = trialResult.metrics.treatment?.crossAgentDedupRatio;

      console.log(`  [${i}] valid: control=${controlValid} treatment=${treatmentValid}`);
      console.log(`  [${i}] dedup ratio: control=${cRatio !== undefined ? (cRatio * 100).toFixed(1) + '%' : 'N/A'} treatment=${tRatio !== undefined ? (tRatio * 100).toFixed(1) + '%' : 'N/A'}`);
    } catch (err) {
      failureCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${i}] FAILED: ${msg}`);
      // Emit partial TrialResult so the manifest records the failure.
      trialResults.push({
        trialIndex: i,
        control: controlResult,
        treatment: treatmentResult,
        validation: {
          control: { valid: false, failures: [{ rule: 'no-closure', message: msg }] },
          treatment: { valid: false, failures: [{ rule: 'no-closure', message: msg }] },
        },
        metrics: {},
        usable: false,
      });
    }
    console.log();
  }

  // ── Write manifest ──────────────────────────────────────────────────────
  const manifest = buildManifest({ startedAt, model, promptHash: hash, trialCount: trials, trials: trialResults });
  const { manifestPath, markdownPath } = writeManifest(manifest, outputDir);

  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════════');
  const s = manifest.summary;
  console.log(`  Valid trials:            ${s.validTrials}/${trials}`);
  console.log(`  Control dedup ratio:     ${s.controlAvgDedupRatio !== null ? (s.controlAvgDedupRatio * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Treatment dedup ratio:   ${s.treatmentAvgDedupRatio !== null ? (s.treatmentAvgDedupRatio * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Delta (treatment−control): ${s.dedupRatioDelta !== null ? (s.dedupRatioDelta * 100).toFixed(1) + 'pp' : 'N/A'}`);
  console.log();
  console.log(`  Manifest: ${manifestPath}`);
  console.log(`  Summary:  ${markdownPath}`);
  console.log();

  if (failureCount > 0) {
    console.error(`Error: ${failureCount} of ${trials} trials failed. Experiment result is incomplete.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

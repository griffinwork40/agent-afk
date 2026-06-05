/**
 * `afk farm` command — Speculative Branch Farm runner.
 *
 * Spawns N isolated git worktrees, runs a subagent on each in parallel via
 * `runSubagentDAG`, then prints a summary and performs an escape check.
 *
 * @module cli/commands/farm
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import chalk from 'chalk';
import { createFarm, setFarmMemoryFactId } from '../../agent/worktree.js';
import { runSubagentDAG } from '../../agent/dag-subagent.js';
import { SubagentManager } from '../../agent/subagent.js';
import { loadSystemPrompt, loadConfigSystemPrompt, getModel } from '../shared-helpers.js';
import {
  scoreBranch,
  writeScore,
  rankBranches,
  DEFAULT_TIMEOUT_MS as SCORE_DEFAULT_TIMEOUT_MS,
  type BranchScore,
} from '../../skills/score/index.js';
import { writeFarmFact } from '../../skills/score/memory-write.js';
import { sendFarmDigest } from '../../skills/score/digest.js';
import type { FarmRunRecord, FarmBranchRecord } from '../../skills/score/farm-run-record.js';
import type { SubagentDAGNode } from '../../agent/dag-subagent.js';
import type { FarmManifest, CreatedBranch } from '../../agent/worktree.js';
import type { DAGRunResult } from '../../agent/dag.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Escape-check helpers
// ---------------------------------------------------------------------------

async function getCommitCount(worktreePath: string, baseSha: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-list', `${baseSha}..HEAD`, '--count'],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function getSourceRepoDirtyFiles(sourceCwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', sourceCwd, 'status', '--porcelain'],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// FarmIsolationViolation
// ---------------------------------------------------------------------------

export class FarmIsolationViolation extends Error {
  public readonly dirtyFiles: string[];
  constructor(dirtyFiles: string[]) {
    super(
      `Source repository has uncommitted changes after farm run. ` +
        `Dirty files:\n${dirtyFiles.map((f) => `  ${f}`).join('\n')}`,
    );
    this.name = 'FarmIsolationViolation';
    this.dirtyFiles = dirtyFiles;
  }
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatScore(score: BranchScore | null | undefined): string {
  if (score === undefined) return chalk.dim('—');
  if (score === null) return chalk.dim('skipped');
  // Compact: tests + lint + LoC. Test signal is binary in v1.
  const testIcon = score.fail === 0 && score.pass > 0
    ? chalk.green('tests✓')
    : chalk.red('tests✗');
  const lintIcon = score.lint_ok === true
    ? chalk.green('lint✓')
    : score.lint_ok === false
    ? chalk.red('lint✗')
    : chalk.dim('lint?');
  const sign = score.loc_delta > 0 ? '+' : '';
  const loc = chalk.dim(`${sign}${score.loc_delta} LoC`);
  return `${testIcon} ${lintIcon} ${loc}`;
}

function printSummary(
  taskName: string,
  taskSlug: string,
  branches: CreatedBranch[],
  branchResults: BranchResult[],
): void {
  const line = '─'.repeat(45);
  console.log(chalk.dim(line));
  console.log(`farm:    ${taskName}`);
  console.log(`slug:    ${taskSlug}`);
  console.log('');

  // Determine if any scoring data is present — drives ranked-order display.
  const anyScored = branchResults.some((r) => r.score != null);
  const orderedResults = anyScored
    ? rankBranches(
        branchResults.map((r) => ({ index: r.index, score: r.score ?? null })),
      ).map((idx) => branchResults.find((r) => r.index === idx)!)
    : branchResults;

  for (let i = 0; i < orderedResults.length; i++) {
    const r = orderedResults[i]!;
    const branch = branches.find((b) => b.index === r.index)!;
    const icon = r.ok ? chalk.green('✓') : chalk.red('✗');
    const ref = pad(branch.branch, 40);
    const detail = r.ok
      ? chalk.dim(`(${r.commitCount} commit${r.commitCount === 1 ? '' : 's'})`)
      : chalk.red(`[error: ${r.error}]`);
    const rank = anyScored ? chalk.cyan(`#${i + 1} `) : '';
    const scoreCol = anyScored ? `  ${formatScore(r.score)}` : '';
    console.log(`${rank}branch-${r.index}  ${icon}  ${ref}   ${detail}${scoreCol}`);
    console.log(chalk.dim(`        worktree: ${branch.path}`));
  }

  console.log(chalk.dim(line));
  const succeeded = branchResults.filter((r) => r.ok).length;
  const total = branchResults.length;
  console.log(`${succeeded}/${total} branches completed.`);

  // All-fail warning per Day 3 spec.
  const anyTestsPassed = branchResults.some(
    (r) => r.score != null && r.score.pass > 0,
  );
  if (anyScored && !anyTestsPassed) {
    console.log(chalk.yellow('⚠  no branch passed tests — ranking falls back to lint + LoC'));
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BranchResult {
  index: number;
  ok: boolean;
  commitCount: number;
  error?: string;
  /** Populated after scoring. null if scoring was disabled or the branch failed before scoring. */
  score?: BranchScore | null;
}

/**
 * Build the FarmRunRecord consumed by memory write-through and Telegram digest.
 *
 * Determines the `winner` index by re-running `rankBranches` over the scored
 * results — same algorithm `printSummary` uses, so memory/digest/CLI all agree
 * on which branch is #1. If no branch has a score (scoring disabled or all
 * failed), `winner` is left undefined.
 */
function buildFarmRunRecord(
  manifest: FarmManifest,
  branchResults: BranchResult[],
  startedAt: string,
): FarmRunRecord {
  const branches: FarmBranchRecord[] = branchResults.map((r) => {
    const meta = manifest.branches.find((b) => b.index === r.index);
    const rec: FarmBranchRecord = {
      index: r.index,
      branch: meta?.branch ?? `(unknown-${r.index})`,
      ok: r.ok,
      commitCount: r.commitCount,
    };
    if (meta?.label !== undefined) rec.label = meta.label;
    if (r.error !== undefined) rec.error = r.error;
    if (r.score !== undefined) rec.score = r.score;
    return rec;
  });

  // Determine winner: rank only branches that have a score, take the first
  // ok-and-tests-passing one.
  const ranked = rankBranches(
    branchResults.map((r) => ({ index: r.index, score: r.score ?? null })),
  );
  let winner: number | undefined;
  for (const idx of ranked) {
    const r = branchResults.find((b) => b.index === idx);
    if (!r || !r.ok || !r.score) continue;
    if (r.score.pass > 0 && r.score.fail === 0) {
      winner = idx;
      break;
    }
  }
  // Fallback: if no branch passed tests but some are `ok` with scoring data,
  // the top-ranked one is still meaningful (lint + LoC tiebreakers).
  if (winner === undefined) {
    for (const idx of ranked) {
      const r = branchResults.find((b) => b.index === idx);
      if (r?.ok && r.score) {
        winner = idx;
        break;
      }
    }
  }

  const record: FarmRunRecord = {
    taskName: manifest.taskName,
    taskSlug: manifest.taskSlug,
    baseSha: manifest.baseRef,
    startedAt,
    completedAt: new Date().toISOString(),
    branches,
  };
  if (winner !== undefined) record.winner = winner;
  if (manifest.human_decision !== undefined) record.human_decision = manifest.human_decision;
  return record;
}

// ---------------------------------------------------------------------------
// Farm runner (exported for testing)
// ---------------------------------------------------------------------------

export interface RunFarmOptions {
  task: string;
  branches: number;
  labels?: string[];
  model?: string;
  baseRef?: string;
  cwd?: string;
  failFast: boolean;
  taskSlug?: string;
  /** Run the Day 3 scorer on successful branches. Default true. */
  score?: boolean;
  /** Per-branch test timeout in ms. Default DEFAULT_TIMEOUT_MS from the score skill. */
  scoreTimeoutMs?: number;
  /** Write a `farm-run` fact to cross-session memory on completion. Default true. */
  memoryWrite?: boolean;
  /** Push a Telegram digest on completion (if AFK_TELEGRAM_* is configured). Default true. */
  digest?: boolean;
  // Injection seams for testing
  _createFarm?: typeof createFarm;
  _runSubagentDAG?: typeof runSubagentDAG;
  _getCommitCount?: typeof getCommitCount;
  _getSourceRepoDirtyFiles?: typeof getSourceRepoDirtyFiles;
  _scoreBranch?: typeof scoreBranch;
  _writeScore?: typeof writeScore;
  _writeFarmFact?: typeof writeFarmFact;
  _sendFarmDigest?: typeof sendFarmDigest;
  _setFarmMemoryFactId?: typeof setFarmMemoryFactId;
}

export async function runFarm(opts: RunFarmOptions): Promise<void> {
  const {
    task,
    branches: count,
    labels,
    model,
    baseRef,
    cwd: sourceCwd = process.cwd(),
    failFast,
    taskSlug,
    score: scoringEnabled = true,
    scoreTimeoutMs = SCORE_DEFAULT_TIMEOUT_MS,
    memoryWrite: memoryWriteEnabled = true,
    digest: digestEnabled = true,
    _createFarm: createFarmFn = createFarm,
    _runSubagentDAG: runDAGFn = runSubagentDAG,
    _getCommitCount: getCountFn = getCommitCount,
    _getSourceRepoDirtyFiles: getDirtyFn = getSourceRepoDirtyFiles,
    _scoreBranch: scoreBranchFn = scoreBranch,
    _writeScore: writeScoreFn = writeScore,
    _writeFarmFact: writeFarmFactFn = writeFarmFact,
    _sendFarmDigest: sendFarmDigestFn = sendFarmDigest,
    _setFarmMemoryFactId: setFarmMemoryFactIdFn = setFarmMemoryFactId,
  } = opts;

  // Captured at runFarm entry so the FarmRunRecord reports actual wall-clock
  // span end-to-end (createFarm → DAG → scoring → exit handling).
  const startedAt = new Date().toISOString();

  // -- Validation --
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    console.error(chalk.red(`--branches must be between 1 and 16 (got ${count})`));
    process.exit(1);
  }
  if (labels !== undefined && labels.length !== count) {
    console.error(
      chalk.red(
        `--labels count (${labels.length}) must equal --branches (${count})`,
      ),
    );
    process.exit(1);
  }

  // -- Create farm --
  let manifest: FarmManifest;
  try {
    manifest = await createFarmFn({
      taskName: task,
      count,
      labels,
      cwd: sourceCwd,
      baseRef,
      taskSlug,
    });
  } catch (err) {
    console.error(chalk.red(`Farm creation failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const baseSha = manifest.baseRef;
  const resolvedModel = model ?? (getModel() as string);
  const systemPrompt = loadConfigSystemPrompt() ?? loadSystemPrompt() ?? '';

  // -- Build DAG nodes --
  const nodes: SubagentDAGNode[] = manifest.branches.map((b) => ({
    id: `branch-${b.index}`,
    agentType: `branch-${b.index}${b.label ? ` (${b.label})` : ''}`,
    systemPrompt,
    promptBuilder: (_inputs: Record<string, unknown>): string => {
      console.log(`[branch-${b.index}] started`);
      return [
        `Task: ${task}`,
        '',
        `You are working in a dedicated git worktree. Your working directory has been set to: ${b.path}`,
        `Your branch is: ${b.branch}`,
        '',
        'Complete the task. All file operations are restricted to this worktree by the runtime.',
      ].join('\n');
    },
    model: resolvedModel,
    idPrefix: `farm-${manifest.taskSlug}-branch-${b.index}`,
    cwd: b.path,
    readRoots: [b.path],
    writeRoots: [b.path],
  }));

  // -- Run DAG --
  const abortController = new AbortController();
  const manager = new SubagentManager({
    parentAbortSignal: abortController.signal,
  });
  const parentSession = {
    sessionId: `farm-${manifest.taskSlug}`,
    abortSignal: abortController.signal,
  };

  let dagResult: DAGRunResult;
  try {
    dagResult = await runDAGFn({ manager, parentSession, nodes, edges: [], failFast });
  } catch (err) {
    // R6: replace process.exit(1) with throw so the finally block runs.
    // External constraint: process.exit() fires before finally — the
    // abortController.abort() cleanup is never reached, leaking the
    // AbortController. throw unwinds through finally first, then propagates
    // to the Commander action handler which sets the exit code.
    console.error(chalk.red(`Farm dispatch failed: ${err instanceof Error ? err.message : String(err)}`));
    throw err;
  } finally {
    abortController.abort(); // ensure cleanup — runs on both success and throw
  }

  // -- Post-run escape check --
  const branchResults: BranchResult[] = [];
  for (const b of manifest.branches) {
    const failedNode = dagResult.failed.find((f) => f.id === `branch-${b.index}`);
    const skipped = dagResult.skipped.includes(`branch-${b.index}`);

    if (failedNode || skipped) {
      const errMsg = failedNode ? failedNode.error.message : 'skipped';
      console.log(`[branch-${b.index}] ✗ failed: ${errMsg}`);
      branchResults.push({ index: b.index, ok: false, commitCount: 0, error: errMsg });
      continue;
    }

    // Commit count escape check
    const commitCount = await getCountFn(b.path, baseSha);
    if (commitCount === 0) {
      const errMsg = 'no commits made';
      console.log(`[branch-${b.index}] ✗ failed: ${errMsg}`);
      branchResults.push({ index: b.index, ok: false, commitCount: 0, error: errMsg });
    } else {
      console.log(`[branch-${b.index}] ✓ done`);
      branchResults.push({ index: b.index, ok: true, commitCount });
    }
  }

  // -- Source repo dirty check --
  const dirtyFiles = await getDirtyFn(sourceCwd);

  // -- Score successful branches (Day 3) --
  // Constraint: sequential (NOT parallel) — concurrent test runs across
  // worktrees risk OOM on small projects and serialize disk I/O badly.
  // Each branch's score writes through to <farmDir>/scores/branch-<n>.json
  // BEFORE the next branch starts, so a crash mid-scoring still surfaces
  // partial results.
  if (scoringEnabled) {
    for (const r of branchResults) {
      if (!r.ok) {
        r.score = null;
        continue;
      }
      const branch = manifest.branches.find((b) => b.index === r.index)!;
      console.log(`[branch-${r.index}] scoring…`);
      const score = await scoreBranchFn({
        branchPath: branch.path,
        baseSha,
        timeoutMs: scoreTimeoutMs,
      });
      r.score = score;
      try {
        await writeScoreFn(manifest.farmDir, r.index, score);
      } catch (err) {
        // Score persistence failure is non-fatal — the in-memory score still
        // ranks the branch for printSummary. Surface for visibility.
        console.error(
          chalk.yellow(`[branch-${r.index}] score.json write failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  }

  // -- Print summary --
  printSummary(task, manifest.taskSlug, manifest.branches, branchResults);

  // -- Build the FarmRunRecord and dispatch to memory + Telegram (Day 4) --
  // Constraint: this MUST happen before process.exit. Memory write is
  // synchronous (sqlite); digest is awaited. Both swallow their own failures
  // (see writeFarmFact / sendFarmDigest) — farm exit code is unaffected by
  // either bookkeeping channel.
  if (memoryWriteEnabled || digestEnabled) {
    const farmRecord = buildFarmRunRecord(manifest, branchResults, startedAt);
    if (memoryWriteEnabled) {
      const memResult = writeFarmFactFn(farmRecord);
      if ('skipped' in memResult) {
        console.error(chalk.yellow(`[memory] write skipped: ${memResult.reason}`));
      } else {
        // Thread the returned factId back into the manifest so the Telegram
        // Respawn handler can cross-reference this run in memory.
        const { factId } = memResult;
        try {
          await setFarmMemoryFactIdFn(manifest.taskSlug, factId);
        } catch (err) {
          // Best-effort: manifest is not the source of truth for factId; log and continue.
          console.error(chalk.yellow(`[memory] setFarmMemoryFactId failed: ${(err as Error).message}`));
        }
      }
    }
    if (digestEnabled) {
      const digestResult = await sendFarmDigestFn(farmRecord);
      if (digestResult.sent) {
        console.log(chalk.dim(`[telegram] digest sent (${digestResult.chatCount} chat${digestResult.chatCount === 1 ? '' : 's'})`));
      } else if (digestResult.reason && digestResult.reason !== 'telegram unconfigured') {
        console.error(chalk.yellow(`[telegram] digest failed: ${digestResult.reason}`));
      }
    }
  }

  // -- Exit handling --
  if (dirtyFiles.length > 0) {
    const violation = new FarmIsolationViolation(dirtyFiles);
    console.error(chalk.red('\n⚠  ISOLATION VIOLATION'));
    console.error(chalk.red(violation.message));
    process.exit(1);
  }

  const allOk = branchResults.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerFarmCommand(program: Command): void {
  program
    .command('farm')
    .description('Run a task across N speculative git worktree branches in parallel')
    .argument('<task>', 'Task description to run on each branch')
    .option('-n, --branches <number>', 'Number of branches to spawn (1-16)', '3')
    .option('--labels <labels>', 'Comma-separated branch labels (count must equal --branches)')
    .option('-m, --model <model>', 'Model to use', getModel() as string)
    .option('--base-ref <ref>', 'Base git ref (default: HEAD)')
    .option('--cwd <path>', 'Source repo root (default: process.cwd())')
    .option('--fail-fast', 'Abort remaining branches on first failure', false)
    .option('--task-slug <slug>', 'Deterministic task slug override (for tests)')
    .option('--no-score', 'Skip the post-run scorer (tests + lint + LoC)')
    .option('--score-timeout <ms>', `Per-branch test timeout in ms (default ${SCORE_DEFAULT_TIMEOUT_MS})`)
    .option('--no-memory', 'Skip writing the farm-run fact to cross-session memory')
    .option('--no-digest', 'Skip pushing the Telegram digest on completion')
    .action(async (task: string, options: {
      branches: string;
      labels?: string;
      model: string;
      baseRef?: string;
      cwd?: string;
      failFast: boolean;
      taskSlug?: string;
      score: boolean; // commander inverts --no-score → { score: false }
      scoreTimeout?: string;
      memory: boolean;  // commander inverts --no-memory → { memory: false }
      digest: boolean;  // commander inverts --no-digest → { digest: false }
    }) => {
      const count = parseInt(options.branches, 10);
      const labels = options.labels
        ? options.labels.split(',').map((l) => l.trim()).filter(Boolean)
        : undefined;

      const scoreTimeoutMs = options.scoreTimeout
        ? parseInt(options.scoreTimeout, 10)
        : undefined;
      if (scoreTimeoutMs !== undefined && (!Number.isFinite(scoreTimeoutMs) || scoreTimeoutMs < 1)) {
        console.error(chalk.red(`--score-timeout must be a positive integer (got "${options.scoreTimeout}")`));
        process.exit(1);
      }

      try {
        await runFarm({
          task,
          branches: count,
          labels,
          model: options.model,
          baseRef: options.baseRef,
          cwd: options.cwd,
          failFast: options.failFast,
          taskSlug: options.taskSlug,
          score: options.score,
          memoryWrite: options.memory,
          digest: options.digest,
          ...(scoreTimeoutMs !== undefined ? { scoreTimeoutMs } : {}),
        });
      } catch (err) {
        console.error(err);
        process.exitCode = 1;
      }
    });
}

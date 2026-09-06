import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { env } from '../../config/env.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';
import type { TelemetryRecord, TelemetryTrigger } from './scheduler.js';
import { runSweep } from '../worktree-sweep.js';
import type { ExecFileFn, SweepResult } from '../worktree-sweep.js';
import { sweepRootSet } from '../worktree-root-registry.js';
import { summarizeRootFailures } from './root-failure-summary.js';
import { countPrunable, formatWorktreePruneSummary } from './worktree-prune-summary.js';
import { debugLog } from '../../utils/debug.js';

/**
 * Wall-clock ceiling on a single `git` invocation inside the sweep.
 *
 * External constraint: git can block indefinitely on things that are not
 * errors — a credential prompt on a repo with an https remote, a stale NFS or
 * SMB handle, a network-mounted worktree whose server went away. The prune
 * tick's per-root loop is deliberately serial (one machine-global advisory
 * lock), so a single blocked child does not fail that root: it hangs the whole
 * tick forever and strands every root ordered behind it, which is precisely
 * the starvation the per-root try/catch was added to prevent. A timeout turns
 * that silent hang into a rejection the existing catch already handles.
 * Generous by design — a slow `git status` on a large worktree is normal.
 */
const PRUNE_GIT_TIMEOUT_MS = 120_000;

// Promisified once at module scope — the daemon's builtin worktree-prune task
// reuses the same node:child_process exec function on every tick; there is no
// reason to re-resolve it dynamically inside the handler.
const promisifiedPruneExecFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

/**
 * `promisifiedPruneExecFile` with a timeout merged into every call. Wrapping
 * here rather than at each `git` call site inside the sweep engine keeps the
 * engine's own signature untouched and applies the ceiling uniformly, including
 * to call sites added later.
 */
const builtinPruneExecFile: ExecFileFn = (file, args, options) =>
  promisifiedPruneExecFile(file, args, { timeout: PRUNE_GIT_TIMEOUT_MS, ...options });

/**
 * Resolve the repo root for the builtin worktree-prune sweep. An explicit
 * `override` (AFK_WORKTREE_SWEEP_ROOT) wins; otherwise discover the repo
 * enclosing `cwd` via `git rev-parse --show-toplevel`. Returns `null` when the
 * cwd is not inside a git repository — the daemon's cwd is frequently $HOME
 * (launchd sets WorkingDirectory=homedir), so the caller skips gracefully
 * instead of erroring `fatal: not a git repository` on every nightly run.
 * Exported for unit testing with a stubbed execFile.
 */
export async function resolveWorktreePruneRoot(
  execFile: ExecFileFn,
  cwd: string,
  override: string | undefined,
): Promise<string | null> {
  if (override !== undefined && override.length > 0) return override;
  try {
    const top = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = top.stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

export interface WorktreePruneTaskOptions {
  now: () => number;
  telemetryPath: () => string;
  writeTelemetry: (record: TelemetryRecord) => void;
}

export async function runBuiltinWorktreePruneTask(
  task: { taskId: string; command: string; cronExpression?: string },
  trigger: TelemetryTrigger,
  options: WorktreePruneTaskOptions,
): Promise<TelemetryRecord> {
  const triggeredAt = new Date(options.now());
  const startTimeMs = options.now();
  const baseRecord = {
    taskId: task.taskId,
    command: task.command,
    trigger,
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: triggeredAt.toISOString(),
  };

  try {
    const primaryRoot = await resolveWorktreePruneRoot(
      builtinPruneExecFile,
      process.cwd(),
      env.AFK_WORKTREE_SWEEP_ROOT,
    );
    // The sweep is per-root, so the daemon's own cwd used to bound what could
    // ever be reclaimed. Visit every root known to hold managed trees (#761).
    const roots = await sweepRootSet(primaryRoot);
    if (roots.length === 0) {
      // An empty set means BOTH causes hold at once: sweepRootSet always yields
      // at least the primary when one resolved, so no primary (daemon cwd outside
      // a git repo, commonly $HOME under launchd) AND nothing registered. Name
      // both — reporting only the cwd half sent operators looking for a daemon
      // misconfiguration when the registry was simply empty. Skip rather than
      // error on every tick; the per-repo REPL boot-prune still covers repos the
      // user actually works in.
      const skipped: TelemetryRecord = {
        ...baseRecord,
        durationMs: options.now() - startTimeMs,
        status: 'skipped',
        responseExcerpt:
          'worktree-prune skipped: no roots to sweep — daemon cwd is not inside a ' +
          'git repository and no managed worktree roots are registered ' +
          '(set AFK_WORKTREE_SWEEP_ROOT to target a repo)',
      };
      options.writeTelemetry(skipped);
      return skipped;
    }

    const maxAgeDaysClean = parseInt(env.AFK_WORKTREE_MAX_AGE_CLEAN ?? '', 10) || 14;
    const maxAgeDaysDirty = parseInt(env.AFK_WORKTREE_MAX_AGE_DIRTY ?? '', 10) || 30;

    const results: SweepResult[] = [];
    const rootFailures: string[] = [];
    const rootFailureDetails: Array<{ repoRoot: string; reason: string }> = [];
    for (const repoRoot of roots) {
      try {
        results.push(await runSweep({
          execFile: builtinPruneExecFile,
          repoRoot,
          dryRun: false, // soft-launch valve inside runSweep handles early dry-runs
          maxAgeDaysClean,
          maxAgeDaysDirty,
          scope: 'all',
          telemetryPath: options.telemetryPath(),
        }));
      } catch (err) {
        const reason = redactPruneError(err);
        rootFailures.push(`[ERROR] sweep failed for ${repoRoot}: ${reason}`);
        rootFailureDetails.push({ repoRoot, reason });
        debugLog(`[worktree-prune] sweep failed for ${repoRoot}: ${reason}`);
      }
    }

    const summary = summarizePruneResults(results, rootFailures, rootFailureDetails, roots.length);
    const record: TelemetryRecord =
      results.length === 0 && roots.length > 0
        ? {
            ...baseRecord,
            durationMs: options.now() - startTimeMs,
            status: 'error',
            errorMessage: summarizeRootFailures(rootFailureDetails),
            responseExcerpt: summary,
          }
        : {
            ...baseRecord,
            durationMs: options.now() - startTimeMs,
            status: 'success',
            responseExcerpt: summary,
          };
    options.writeTelemetry(record);
    return record;
  } catch (err) {
    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: options.now() - startTimeMs,
      status: 'error',
      errorMessage: redactPruneError(err),
    };
    options.writeTelemetry(record);
    return record;
  }
}

function summarizePruneResults(
  results: SweepResult[],
  rootFailures: string[],
  rootFailureDetails: Array<{ repoRoot: string; reason: string }>,
  totalRoots: number,
): string {
  const result = {
    dryRun: results.some((r) => r.dryRun),
    removed: results.flatMap((r) => r.removed),
    warnings: [...rootFailures, ...results.flatMap((r) => r.warnings)],
    candidates: results.flatMap((r) => r.candidates),
  };
  const contestedResults = results.filter((r) => r.contested === true);
  const previewResults = results.filter((r) => r.dryRun && r.contested !== true);
  const liveResults = results.filter((r) => !r.dryRun && r.contested !== true);
  return formatWorktreePruneSummary({
    removed: result.removed.length,
    warnings: result.warnings.length,
    wouldRemove: countPrunable(previewResults.flatMap((r) => r.candidates)),
    liveRoots: liveResults.length,
    previewRoots: previewResults.length,
    contestedRoots: contestedResults.length,
    failedRoots: rootFailureDetails.length,
    totalRoots,
  });
}

function redactPruneError(err: unknown): string {
  return redactInlineSecrets(err instanceof Error ? err.message : String(err));
}

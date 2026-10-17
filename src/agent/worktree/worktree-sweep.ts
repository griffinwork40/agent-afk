/**
 * Worktree sweep engine for agent-afk.
 *
 * Classifies and optionally removes stale, empty, locked, and orphaned
 * git worktrees created under <repo>/.afk-worktrees/.
 *
 * @module agent/worktree-sweep
 */

import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getWorktreeSweepLockPath, getTelemetryPath } from '../../paths.js';
import type { PresenceRecord } from '../awareness/presence.js';
// Runtime value import. Safe despite the mutual reference: the only import
// going the other way (worktree-ignored-probe.ts importing ExecFileFn from
// THIS file) is `import type`, which TypeScript erases at compile time — so
// no runtime require()/import cycle exists between the two modules.
import { readRootSweepCount, recordRootSweep, SOFT_LAUNCH_RUNS } from './worktree-sweep-valve.js';
import { errorMessage } from '../../utils/errors.js';
import {
  countPriorSuccessfulRuns,
  acquireLock,
  LockContestedError,
} from './worktree-sweep.lock.js';
import {
  type WorktreeMeta,
  type WorktreeCandidate,
  type WorktreeVerdict,
  isPathWithin,
  parseWorktreeList,
  classifyCandidate,
} from './worktree-sweep.classify.js';
export { MIN_EMPTY_AGE_MS } from './worktree-sweep.classify.js';
import { applySchedulePin, loadSchedulePinsForSweep } from './worktree-sweep.schedule-pins.js';
import { readLiveSessionCwds } from './worktree-sweep.liveness.js';
import {
  sweepOrphanDirs,
  collectOrphanDirs,
  probeCandidate,
  applyVerdictAction,
  resolveWorktreeAgeMs,
} from './worktree-sweep.actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injected exec function — matches the shape of Node's promisified execFile.
 * Defined here (not re-imported from CLI) to keep agent/ → cli/ dependency
 * arrow clean.
 */
export type ExecFileFn = (
  file: string,
  args: string[],
  opts?: {
    cwd?: string;
    /**
     * Contract: callers that can produce large output MUST set this. Node's
     * default `execFile` maxBuffer is 1MB and an overflow REJECTS the promise
     * rather than truncating, so an unbounded call silently converts "lots of
     * output" into "git failed" — and every failure path in the ignored probe
     * fails safe by protecting, which quietly makes the worktree immortal.
     */
    maxBuffer?: number;
    timeout?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;


export interface SweepOptions {
  execFile: ExecFileFn;
  repoRoot: string;
  dryRun?: boolean;
  maxAgeDaysClean?: number;
  maxAgeDaysDirty?: number;
  scope?: 'interactive' | 'diagnose' | 'all';
  telemetryPath?: string;
  /**
   * Override the advisory-lock path. Defaults to the process-global
   * {@link getWorktreeSweepLockPath}. Injected by tests so each test — and
   * each concurrent vitest process on a shared CI runner — contends an
   * isolated lock under its own tmpdir instead of the single machine-global
   * lock. Without this, parallel sweeps race on one lock file and the loser
   * short-circuits with LockContestedError, returning an empty result — the
   * root cause of the worktree-sweep.test.ts CI flake. Mirrors
   * {@link telemetryPath}, which is injected for the same isolation reason.
   */
  lockPath?: string;
  /**
   * Skip the soft-launch valve that forces dry-run for the first 3
   * successful sweeps. Callers that have their own narrower verdict
   * allowlist (e.g. the REPL boot-time pass, which only reaps `empty`,
   * `orphaned-dir`, `orphaned-registration`, and `dead-owner`) don't
   * need the valve's daemon-cron-specific safety net and would otherwise
   * be stuck in dry-run until the daemon ran 3 times — defeating the
   * point of running on boot at all.
   */
  bypassSoftLaunch?: boolean;
  /**
   * Override the presence reader. Defaults to the real {@link readPresenceFiles}
   * (scans ~/.afk/state/presence/). Injected by tests for hermeticity and to
   * assert against a controlled set of live sessions. A worktree hosting a live
   * session (a presence record whose pid is alive, whose cwd is within the
   * worktree) is never reaped — even if the creator pid in meta is dead.
   */
  readPresence?: () => Promise<PresenceRecord[]>;
  /**
   * Override the schedules file path used by the schedule-pins guard.
   * Defaults to the process-global schedules store (~/.afk/config/schedules.json).
   * Injected by tests for hermeticity.
   */
  schedulesPath?: string;
}

interface SweepCandidateSummary {
  path: string;
  verdict: WorktreeVerdict;
  /** Resolved owner from `.afk-worktree-meta.json`, or 'unknown' when meta is absent. */
  owner: 'interactive' | 'diagnose' | 'unknown';
  /** Age in milliseconds since creation (or directory birth-time if no meta). */
  ageMs: number;
}

export interface SweepResult {
  removed: string[];
  warnings: string[];
  dryRun: boolean;
  candidates: SweepCandidateSummary[];
  /**
   * Set only when the run returned early because another process held the
   * machine-global sweep lock, so nothing was inspected. Additive and optional:
   * a caller that ignores it behaves exactly as before. The daemon's multi-root
   * tick needs it to avoid counting an untouched root as swept.
   */
  contested?: boolean;
}


// ---------------------------------------------------------------------------
// Public entry point: runSweep()
// ---------------------------------------------------------------------------

export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const {
    execFile,
    repoRoot,
    maxAgeDaysClean = 14,
    maxAgeDaysDirty = 30,
    scope = 'all',
    telemetryPath,
  } = options;

  const resolvedTelemetryPath = telemetryPath ?? getTelemetryPath();
  const lockPath = options.lockPath ?? getWorktreeSweepLockPath();

  const result: SweepResult = {
    removed: [],
    warnings: [],
    dryRun: options.dryRun ?? false,
    candidates: [],
  };

  // Soft-launch valve: force dry-run for the first few runs AGAINST THIS ROOT.
  // The counter is per-root because the machine-global telemetry count stopped
  // meaning "this repo has been previewed" the moment the daemon began
  // sweeping every registered root — a freshly registered repo would otherwise
  // inherit an exhausted counter and be swept destructively on first contact.
  // A root with no usable marker falls back to the legacy global count rather
  // than being pinned in dry-run forever. Callers with their own narrower
  // allowlist bypass the valve entirely.
  const priorRuns = options.bypassSoftLaunch
    ? Number.POSITIVE_INFINITY
    : (await readRootSweepCount(repoRoot))
      ?? await countPriorSuccessfulRuns(resolvedTelemetryPath);
  const effectiveDryRun = (options.dryRun === true) || (priorRuns < SOFT_LAUNCH_RUNS);
  result.dryRun = effectiveDryRun;

  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireLock(lockPath);
  } catch (err) {
    if (err instanceof LockContestedError) {
      result.warnings.push(`[WARN] ${err.message}`);
      result.contested = true;
      return result;
    }
    throw err;
  }

  try {
    // List all registered worktrees
    const listResult = await execFile('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
    const parsed = parseWorktreeList(listResult.stdout);

    // Identify .afk-worktrees/ directory
    const afkWorktreesRoot = join(repoRoot, '.afk-worktrees');
    const registeredPaths = new Set(parsed.map((p) => p.path));

    // Detect and sweep orphaned directories (exist on disk, not in git list).
    // The `.afk-worktrees/` tree is owned by the `interactive` surface
    // (diagnose-tmp worktrees live under $TMPDIR, not here), so we skip orphan
    // sweeping entirely when the caller scoped the run to a different owner.
    // Without this guard, `--scope diagnose` would silently delete
    // interactive-owner orphans, contradicting the scope flag.
    if (scope === 'all' || scope === 'interactive') {
      const orphanedDirs = await collectOrphanDirs(afkWorktreesRoot, registeredPaths, result.warnings);
      await sweepOrphanDirs(orphanedDirs, effectiveDryRun, result);
    }

    // Live-session + schedule-pin liveness (see worktree-sweep.liveness.ts and
    // worktree-sweep.schedule-pins.ts). Both are best-effort and never throw.
    const liveSessionCwds = await readLiveSessionCwds(options.readPresence);
    const schedulePins = await loadSchedulePinsForSweep(parsed, result.warnings, options.schedulesPath);

    // Process registered worktrees (skip main/bare)
    let hasOrphanedRegistrations = false;
    const mainPath = parsed[0]?.path;
    // The main worktree's HEAD is the fallback base for the commits-ahead
    // count when a candidate's meta has no recorded `baseSha` (see below).
    const mainHead = parsed[0]?.head;

    for (const entry of parsed) {
      // Skip main worktree and bare repos
      if (entry.path === mainPath || entry.isBare) continue;
      // Skip worktrees not under .afk-worktrees/. Path-boundary test, not a
      // string prefix: `startsWith` also accepted siblings whose name merely
      // begins with the root (`.afk-worktrees-scratch`), letting a tree the
      // engine does not own reach the removal verdicts below. One root made
      // that a narrow window; the multi-root fan-out multiplies it by every
      // registered repo.
      if (!isPathWithin(entry.path, afkWorktreesRoot)) continue;

      // Apply scope filter
      let meta: WorktreeMeta | undefined;
      try {
        const metaRaw = await fs.readFile(join(entry.path, '.afk-worktree-meta.json'), 'utf-8');
        meta = JSON.parse(metaRaw) as WorktreeMeta;
      } catch { /* no meta file — treat as unknown owner */ }

      if (scope !== 'all' && meta?.owner !== scope) continue;

      // Resolve owner for the summary row: prefer meta, fall back to 'unknown'.
      const resolvedOwner: SweepCandidateSummary['owner'] =
        meta?.owner === 'interactive' || meta?.owner === 'diagnose' ? meta.owner : 'unknown';

      // Check if directory exists on disk
      if (!existsSync(entry.path)) {
        result.candidates.push({
          path: entry.path,
          verdict: 'orphaned-registration',
          owner: resolvedOwner,
          ageMs: 0,
        });
        if (!effectiveDryRun) {
          hasOrphanedRegistrations = true;
        }
        continue;
      }

      const ageMs = await resolveWorktreeAgeMs(entry.path, meta);

      const probe = await probeCandidate(
        execFile, repoRoot, entry.path, entry.head, mainHead,
        meta, ageMs, liveSessionCwds, result.warnings,
      );

      const candidate: WorktreeCandidate = {
        path: entry.path,
        head: entry.head,
        branch: entry.branch,
        locked: entry.locked,
        prunable: entry.prunable,
        meta,
        ageMs,
        isDirty: probe.isDirty,
        dirtyReason: probe.dirtyReason,
        commitsAhead: probe.commitsAhead,
        commitsUnpushed: probe.commitsUnpushed,
        ownerLiveness: probe.ownerLiveness,
      };

      const raw = classifyCandidate(candidate, maxAgeDaysClean, maxAgeDaysDirty);
      const verdict = applySchedulePin(raw, entry.path, schedulePins, result.warnings);
      result.candidates.push({ path: entry.path, verdict, owner: resolvedOwner, ageMs });

      if (effectiveDryRun) continue;

      try {
        await applyVerdictAction(
          verdict, execFile, repoRoot,
          entry.path, entry.branch, entry.lockReason,
          candidate, meta, result,
        );
      } catch (err) {
        result.warnings.push(
          `[ERROR] Failed to process ${entry.path} (${verdict}): ${errorMessage(err)}`,
        );
      }
    }

    if (hasOrphanedRegistrations && !effectiveDryRun) {
      try {
        await execFile('git', ['-C', repoRoot, 'worktree', 'prune']);
      } catch (err) {
        result.warnings.push(
          `[ERROR] git worktree prune failed: ${errorMessage(err)}`,
        );
      }
    }
  } finally {
    if (releaseLock) await releaseLock();
  }

  // Credit this root only after a completed pass, and only when the valve was
  // actually in play — a bypassing caller never consumed a preview, so it must
  // not spend one on the daemon's behalf. Best-effort: failing to record costs
  // at most one extra dry-run.
  //
  // Keyed on `options.dryRun` (what the CALLER asked for), never on
  // `effectiveDryRun` (which is also true when the valve itself forced the
  // preview). A valve-forced preview MUST still credit the counter — that is
  // the only thing that ever advances it towards SOFT_LAUNCH_RUNS. An
  // explicit caller-requested dry-run (`list`, `prune` without `--apply`, the
  // agent-facing `list` action) never touched anything, so it must not spend
  // one of the root's previews — three such calls would otherwise exhaust the
  // budget with no daemon preview ever having run, and the daemon's FIRST
  // sweep of that root would then be destructive.
  if (options.bypassSoftLaunch !== true && options.dryRun !== true) await recordRootSweep(repoRoot);

  return result;
}

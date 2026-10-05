/**
 * Worktree sweep engine for agent-afk.
 *
 * Classifies and optionally removes stale, empty, locked, and orphaned
 * git worktrees created under <repo>/.afk-worktrees/.
 *
 * @module agent/worktree-sweep
 */

import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getWorktreeSweepLockPath, getTelemetryPath } from '../../paths.js';
import type { PresenceRecord } from '../awareness/presence.js';
// Runtime value import. Safe despite the mutual reference: the only import
// going the other way (worktree-ignored-probe.ts importing ExecFileFn from
// THIS file) is `import type`, which TypeScript erases at compile time — so
// no runtime require()/import cycle exists between the two modules.
import { probeNonRebuildableIgnoredFiles } from './worktree-ignored-probe.js';
import { readRootSweepCount, recordRootSweep, SOFT_LAUNCH_RUNS } from './worktree-sweep-valve.js';
import { classifyOrphanDir } from './worktree-orphan-guard.js';
import { reconsiderLockedWorktree } from './worktree-sweep.reconsider.js';
import { errorMessage } from '../../utils/errors.js';
import {
  countPriorSuccessfulRuns,
  acquireLock,
  LockContestedError,
} from './worktree-sweep.lock.js';
import {
  type DirtyReason,
  type WorktreeMeta,
  type WorktreeCandidate,
  type WorktreeVerdict,
  MAX_TRUSTED_PID_AGE_MS,
  MIN_EMPTY_AGE_MS,
  isProcessAlive,
  isPathWithin,
  shortBranchName,
  parseWorktreeList,
  classifyCandidate,
} from './worktree-sweep.classify.js';
export { MIN_EMPTY_AGE_MS } from './worktree-sweep.classify.js';
import { applySchedulePin, loadSchedulePinsForSweep } from './worktree-sweep.schedule-pins.js';
import { readLiveSessionCwds } from './worktree-sweep.liveness.js';

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

    // Detect orphaned directories (exist on disk, not in git list)
    const registeredPaths = new Set(parsed.map((p) => p.path));
    let diskEntries: string[] = [];
    // Invariant: the orphan scan is the one path that recursively DELETES a
    // directory chosen by disk listing rather than by git, so its root must be
    // a real directory in this repo. `readdir` follows a symlink, so a
    // `.afk-worktrees` symlink would have the scan enumerate — and `fs.rm`
    // recursively delete — entries that live somewhere else entirely. One
    // daemon-resolved root made that a narrow window; sweeping every registered
    // root (#761) multiplies it by every repo the daemon has ever visited.
    // Skip such a root instead of resolving through the link: nothing legitimate
    // in this engine ever creates `.afk-worktrees` as a symlink.
    let orphanScanRoot: string | null = afkWorktreesRoot;
    try {
      if ((await fs.lstat(afkWorktreesRoot)).isSymbolicLink()) {
        result.warnings.push(
          `[WARN] skipping orphan scan: .afk-worktrees is a symlink, not a directory: ${afkWorktreesRoot}`,
        );
        orphanScanRoot = null;
      }
    } catch { /* absent — handled by the readdir below */ }
    if (orphanScanRoot !== null) {
      try {
        const entries = await fs.readdir(orphanScanRoot, { withFileTypes: true });
        diskEntries = entries
          .filter((e) => e.isDirectory())
          .map((e) => join(afkWorktreesRoot, e.name));
      } catch { /* .afk-worktrees doesn't exist yet — no orphaned dirs */ }
    }

    const orphanedDirs = diskEntries.filter((d) => !registeredPaths.has(d));

    // Process orphaned dirs. The `.afk-worktrees/` tree is owned by the
    // `interactive` surface (diagnose-tmp worktrees live under $TMPDIR, not
    // here), so we skip orphan sweeping entirely when the caller scoped the
    // run to a different owner. Without this guard, `--scope diagnose` would
    // silently delete interactive-owner orphans, contradicting the scope flag.
    if (scope === 'all' || scope === 'interactive') {
      for (const orphanPath of orphanedDirs) {
        let orphanAgeMs = 0;
        try {
          const stat = await fs.stat(orphanPath);
          // Some filesystems report a zero/invalid birth time when creation
          // time is unavailable. Treat that as unknown (age 0), not as an
          // epoch-old directory eligible for immediate removal.
          if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) {
            orphanAgeMs = Math.max(0, Date.now() - stat.birthtimeMs);
          }
        } catch { /* use 0 */ }
        // Invariant: the orphan path has no git information — the directory is
        // absent from `git worktree list`, so `git status` cannot classify it
        // and none of the registered-candidate protections apply. The guard is
        // the substitute floor and it runs in dry-run too, so `list` reports the
        // preservation instead of implying the next tick will delete (#794).
        const guard = await classifyOrphanDir(orphanPath, orphanAgeMs, MIN_EMPTY_AGE_MS);
        result.candidates.push({
          path: orphanPath,
          verdict: guard.remove ? 'orphaned-dir' : 'orphaned-dir-preserved',
          owner: 'interactive',
          ageMs: orphanAgeMs,
        });
        if (!guard.remove) {
          result.warnings.push(
            `[WARN] orphaned dir preserved (${guard.because}` +
              `${guard.detail === undefined ? '' : `: ${guard.detail}`}): ${orphanPath}`,
          );
          continue;
        }
        if (!effectiveDryRun) {
          try {
            await fs.rm(orphanPath, { recursive: true, force: true });
            result.removed.push(orphanPath);
          } catch (err) {
            result.warnings.push(
              `[ERROR] Failed to remove orphaned dir ${orphanPath}: ${errorMessage(err)}`,
            );
          }
        }
      }
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

      // Get age
      let ageMs = 0;
      const createdAt = meta?.createdAt;
      if (createdAt) {
        ageMs = Date.now() - new Date(createdAt).getTime();
      } else {
        try {
          const stat = await fs.stat(entry.path);
          ageMs = Date.now() - stat.birthtimeMs;
        } catch { /* use 0 */ }
      }

      // Check dirty status
      let isDirty = false;
      let dirtyReason: DirtyReason = 'clean';
      let commitsAhead = 0;
      try {
        const statusResult = await execFile('git', ['-C', entry.path, 'status', '--porcelain']);
        isDirty = statusResult.stdout.trim().length > 0;
        if (isDirty) dirtyReason = 'uncommitted changes';
      } catch {
        isDirty = true; /* treat as dirty — safe fallback */
        dirtyReason = 'git status failed';
      }

      // Invariant: bare `--porcelain` reports untracked files but NEVER ignored
      // ones, so a tree holding only ignored content reads clean here and every
      // removal path below runs `remove --force`, deleting it. Committed work
      // survives (branch refs live in the shared .git), but a worktree-local
      // `.env` or scratch file does not (#759). Probe for ignored content a
      // rebuild could NOT restore and treat it as dirty. Rebuildable output
      // (node_modules/, dist/, caches) is deliberately NOT protective — that
      // would make every worktree immortal and defeat the sweep.
      if (!isDirty) {
        const probe = await probeNonRebuildableIgnoredFiles(execFile, entry.path);
        isDirty = probe.protect;
        if (probe.protect) {
          dirtyReason =
            probe.because === 'git-failed'
              ? 'ignored-file probe failed'
              : `non-rebuildable ignored files: ${probe.detail}`;
        }
        // A protect-on-failure is indistinguishable from a real find at the
        // verdict level, so surface it: otherwise a worktree that git can no
        // longer read stays preserved forever with no trace of why.
        if (probe.protect && probe.because === 'git-failed') {
          result.warnings.push(
            `[WARN] ignored-file probe failed for ${entry.path} — preserving (${probe.detail})`,
          );
        }
      }

      if (!isDirty && entry.head) {
        // Contract: `commitsAhead > 0` marks a worktree as holding unmerged
        // committed work, which the classifier preserves (`stale-clean`) and
        // never reaps. Getting this count right is load-bearing for not
        // destroying work.
        //
        // Invariant: when meta has NO `baseSha`, we must NOT fall back to
        // `entry.head` as the base. `rev-list HEAD..HEAD` is always 0, so a
        // baseSha-less worktree that actually holds commits would look empty
        // and be force-removed by the `empty`/`dead-owner` verdicts. Meta is
        // absent/minimal exactly for hand-created `git worktree add` trees
        // adopted by touchWorktreeOccupancy (which writes `{owner:'agent'}`
        // with no baseSha). Fall back to the main worktree's HEAD and count
        // commits reachable from this tree but not from main — the true
        // "unmerged work" signal.
        try {
          const revListArgs =
            meta?.baseSha !== undefined
              ? ['-C', repoRoot, 'rev-list', `${meta.baseSha}..${entry.head}`, '--count']
              : mainHead !== undefined && mainHead !== entry.head
                ? ['-C', repoRoot, 'rev-list', entry.head, '--not', mainHead, '--count']
                : undefined;
          // `revListArgs === undefined` means no recorded base AND the tree
          // sits at the main worktree's commit (or main HEAD is unknown) —
          // genuinely nothing ahead, so leave commitsAhead at 0.
          if (revListArgs !== undefined) {
            const countResult = await execFile('git', revListArgs);
            commitsAhead = parseInt(countResult.stdout.trim(), 10) || 0;
          }
        } catch { commitsAhead = 0; }
      }

      // Invariant: commitsUnpushed starts EQUAL to commitsAhead (fully
      // unpushed) and is only ever lowered by a successful upstream read.
      // Every failure path — no upstream configured, detached HEAD, unreadable
      // remote-tracking ref, git error — leaves it at commitsAhead, so the
      // classifier preserves the tree exactly as it did before this field
      // existed. Never initialise this to 0.
      let commitsUnpushed = commitsAhead;
      if (commitsAhead > 0) {
        try {
          // @{upstream} resolves the branch's configured remote-tracking ref.
          // rev-list @{upstream}..HEAD counts commits present here but not on
          // the remote; 0 means the push landed and the remote holds the work.
          const unpushedResult = await execFile('git', [
            '-C', entry.path, 'rev-list', '@{upstream}..HEAD', '--count',
          ]);
          const parsed = parseInt(unpushedResult.stdout.trim(), 10);
          if (Number.isInteger(parsed) && parsed >= 0) commitsUnpushed = parsed;
        } catch { /* no upstream / unreadable → stay at commitsAhead */ }
      }

      // Constraint: ownerLiveness must only be 'dead'/'alive' when the meta
      // is fresh enough that PID reuse is implausible. Outside the trust
      // window we fall through to 'unknown' and the classifier ignores PID,
      // using the existing age-gated path instead.
      let ownerLiveness: WorktreeCandidate['ownerLiveness'] = 'unknown';
      if (
        typeof meta?.pid === 'number' &&
        Number.isInteger(meta.pid) &&
        meta.pid > 0 &&
        ageMs <= MAX_TRUSTED_PID_AGE_MS
      ) {
        ownerLiveness = isProcessAlive(meta.pid) ? 'alive' : 'dead';
      }

      // A live session working inside this worktree overrides a dead creator
      // pid — never reap an actively-used worktree.
      if (
        ownerLiveness !== 'alive' &&
        liveSessionCwds.some((cwd) => isPathWithin(cwd, entry.path))
      ) {
        ownerLiveness = 'alive';
      }

      const candidate: WorktreeCandidate = {
        path: entry.path,
        head: entry.head,
        branch: entry.branch,
        locked: entry.locked,
        prunable: entry.prunable,
        meta,
        ageMs,
        isDirty,
        dirtyReason,
        commitsAhead,
        commitsUnpushed,
        ownerLiveness,
      };

      const raw = classifyCandidate(candidate, maxAgeDaysClean, maxAgeDaysDirty);
      const verdict = applySchedulePin(raw, entry.path, schedulePins, result.warnings);
      result.candidates.push({ path: entry.path, verdict, owner: resolvedOwner, ageMs });

      if (effectiveDryRun) continue;

      // Invariant: the branch ref is the last copy of committed work once the
      // checkout is gone, so it may be deleted ONLY when the tree held nothing
      // ahead of base. `git branch -d` deletes a branch that is merged to its
      // UPSTREAM (git prints "merged to refs/remotes/origin/X, but not yet
      // merged to HEAD" and exits 0) — precisely the state a pushed worktree is
      // in. Gating on commitsAhead keeps a reaped-but-pushed tree recoverable
      // from the local branch even if its remote branch was later deleted and
      // the tracking ref pruned, which is otherwise unrecoverable-by-gc.
      // Invariant: branch ref may be deleted ONLY when commitsAhead === 0 (all
      // work is on the remote). `git branch -d` deletes a branch merged to its
      // upstream, which is exactly the pushed-worktree state.
      const branchSafeToDelete = candidate.commitsAhead === 0;
      const reapClean = async (): Promise<void> => {
        await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', entry.path]);
        if (entry.branch && branchSafeToDelete) {
          await execFile('git', ['-C', repoRoot, 'branch', '-d', shortBranchName(entry.branch)]).catch(() => {});
        } else if (entry.branch) {
          result.warnings.push(`[INFO] reaped worktree with pushed commits; branch preserved (${shortBranchName(entry.branch)}): ${entry.path}`);
        }
        result.removed.push(entry.path);
      };

      try {
        if (verdict === 'empty' || verdict === 'dead-owner') {
          await reapClean();
        } else if (verdict === 'stale-clean') {
          // Invariant: `stale-clean` fires only on trees with commits ahead
          // of base — a clean tree with zero commits ahead is always caught
          // by `empty` first. Removing here therefore destroys exclusively
          // trees holding committed-but-unmerged work (the branch ref
          // survives, the checkout does not). Preserve + warn instead,
          // mirroring `stale-dirty`; explicit removal paths (`afk worktree
          // prune`-adjacent tooling, the model-facing `worktree` tool) are
          // the sanctioned way to drop these.
          result.warnings.push(
            `[WARN] stale-clean worktree preserved (commits ahead of base): ${entry.path}`,
          );
        } else if (verdict === 'stale-dirty') {
          result.warnings.push(
            `[WARN] stale-dirty worktree preserved (${candidate.dirtyReason}): ${entry.path}`,
          );
        } else if (verdict === 'locked') {
          // Two-phase: auto-unlock when the preservation reason has expired;
          // normal classification removes the tree on the NEXT sweep tick.
          const r = await reconsiderLockedWorktree({ execFile, repoRoot, worktreePath: entry.path, meta, lockReason: entry.lockReason });
          if (r.unlocked) result.warnings.push(`[INFO] auto-unlocked preserved worktree (${r.reason}): ${entry.path}`);
        }
        // 'active' → no-op
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

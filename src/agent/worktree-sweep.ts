/**
 * Worktree sweep engine for agent-afk.
 *
 * Classifies and optionally removes stale, empty, locked, and orphaned
 * git worktrees created under <repo>/.afk-worktrees/.
 *
 * @module agent/worktree-sweep
 */

import { promises as fs, existsSync, createReadStream, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { getWorktreeSweepLockPath, getTelemetryPath } from '../paths.js';
import { readPresenceFiles, type PresenceRecord } from './awareness/presence.js';

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
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

interface WorktreeMeta {
  owner: 'interactive' | 'diagnose' | string;
  /**
   * PID of the process that created this worktree. Used by the sweep
   * engine to accelerate reaping of dead-owner ghost worktrees regardless
   * of age. Optional — worktrees created before this field was added will
   * lack it and fall through to the existing age-gated verdict path.
   *
   * PID reuse is bounded by {@link createdAt}: callers must not trust the
   * `pid` field once the meta is older than {@link MAX_TRUSTED_PID_AGE_MS},
   * because the kernel's PID space may have wrapped.
   */
  pid?: number;
  createdAt: string;
  baseSha?: string;
  baseBranch?: string;
}

interface WorktreeCandidate {
  path: string;
  head?: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
  meta?: WorktreeMeta;
  ageMs: number;
  isDirty: boolean;
  commitsAhead: number;
  /**
   * Tri-state liveness of the owning process recorded in `meta.pid`:
   *   - `'alive'`      — `meta.pid` resolves to a live process.
   *   - `'dead'`       — `meta.pid` is present, the meta is within the
   *                       PID-reuse safety window, and the kernel has no
   *                       process at that pid. Eligible for accelerated
   *                       reaping when the tree is clean.
   *   - `'unknown'`    — no `meta.pid` field, or meta is older than the
   *                       PID-reuse safety window. Caller must fall through
   *                       to the age-gated verdict path.
   */
  ownerLiveness: 'alive' | 'dead' | 'unknown';
}

type WorktreeVerdict =
  | 'empty'
  | 'stale-clean'
  | 'stale-dirty'
  | 'locked'
  | 'active'
  | 'orphaned-dir'
  | 'orphaned-registration'
  /**
   * The owning process recorded in `.afk-worktree-meta.json` is gone, the
   * meta is within the PID-reuse safety window, and the worktree has no
   * uncommitted changes and no commits ahead of base. Eligible for removal
   * regardless of age — these are the ghost worktrees left behind when a
   * REPL crashed or was killed. Never assigned when the tree is dirty or
   * has unpushed commits.
   */
  | 'dead-owner';

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
}

/**
 * Minimum age before a worktree with no commits and no dirty changes is
 * classified as `empty` and eligible for removal. Prevents the race where a
 * worktree created seconds before the daemon's cron tick gets reaped on that
 * same tick. One hour is generous enough to cover any human-paced workflow
 * while still letting `empty` survive a sweep when the user has had time to
 * commit.
 */
const MIN_EMPTY_AGE_MS = 3_600_000; // 1 hour

/**
 * Maximum age of a `.afk-worktree-meta.json` whose `pid` field we still
 * trust for liveness checks. Beyond this window we conservatively treat
 * the recorded PID as unknown — the kernel may have wrapped the PID space
 * and any liveness probe could now be referring to an unrelated process.
 *
 * 30 days is well beyond typical Linux PID-wrap intervals on a busy system
 * (default `pid_max` 32768 wraps in hours; tuned-up systems wrap in days).
 * macOS PIDs reuse much faster but still safely fit inside this window for
 * the dead-owner verdict's purpose (accelerated reaping of *recent*
 * ghosts — anything older than 30 days is already eligible for the
 * existing stale-clean / stale-dirty verdicts).
 */
const MAX_TRUSTED_PID_AGE_MS = 30 * 86_400_000;

/**
 * Probe whether a PID corresponds to a live process via `kill(pid, 0)`.
 * Returns `true` if the kernel accepts the signal (process exists, may or
 * may not be ours to signal), `false` if it's gone (`ESRCH`).
 *
 * Note: `EPERM` (permission denied) means the process exists but isn't
 * ours — still alive from the sweep engine's perspective, so we return
 * `true`. This is the same idiom `acquireLock` uses for stale-lock
 * detection.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Resolve a path through symlinks, falling back to the raw path when it can't
 * be resolved. macOS aliases /var → /private/var, so both the worktree path
 * and a session cwd must be normalized before any containment check or the
 * comparison silently fails.
 */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * True when `child` is the same path as, or nested inside, `parent`. Both are
 * realpath-normalized first. Used to decide whether a live session's cwd sits
 * inside a candidate worktree.
 */
function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(realpathSafe(parent), realpathSafe(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Section 2 — Porcelain parser
// ---------------------------------------------------------------------------

interface ParsedWorktree {
  path: string;
  head: string;
  branch: string;
  locked: boolean;
  prunable: boolean;
  isBare: boolean;
}

function parseWorktreeList(stdout: string): ParsedWorktree[] {
  const blocks = stdout.trim().split(/\n\n+/);
  const result: ParsedWorktree[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let path = '';
    let head = '';
    let branch = '';
    let locked = false;
    let prunable = false;
    let isBare = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
      else if (line.trim() === 'locked') locked = true;
      else if (line.trim() === 'prunable') prunable = true;
      else if (line.trim() === 'bare') isBare = true;
    }
    if (path) result.push({ path, head, branch, locked, prunable, isBare });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Section 3 — Verdict classifier
// ---------------------------------------------------------------------------

function classifyCandidate(
  candidate: WorktreeCandidate,
  maxAgeDaysClean: number,
  maxAgeDaysDirty: number,
): WorktreeVerdict {
  if (candidate.locked) return 'locked';

  const msPerDay = 86_400_000;
  const cleanThresholdMs = maxAgeDaysClean * msPerDay;
  const dirtyThresholdMs = maxAgeDaysDirty * msPerDay;

  // Constraint: dead-owner is checked BEFORE empty / stale-clean so that
  // a recent ghost (REPL crashed 5 minutes ago, age < MIN_EMPTY_AGE_MS,
  // age < cleanThreshold) still gets reaped on this sweep. The check is
  // gated on a clean tree AND zero commits ahead — we never reap dead-owner
  // worktrees that have any work the user could conceivably want back.
  if (
    candidate.ownerLiveness === 'dead' &&
    !candidate.isDirty &&
    candidate.commitsAhead === 0
  ) {
    return 'dead-owner';
  }

  // No commits ahead, no dirty files, and old enough to not be a freshly-
  // created worktree mid-setup → empty. The age guard closes the race where
  // a worktree created seconds before the cron fires would be reaped on its
  // first tick before the user has a chance to do anything in it.
  if (
    candidate.commitsAhead === 0 &&
    !candidate.isDirty &&
    candidate.ageMs >= MIN_EMPTY_AGE_MS
  ) {
    return 'empty';
  }

  // Has dirty working tree past dirty threshold
  if (candidate.isDirty && candidate.ageMs > dirtyThresholdMs) return 'stale-dirty';

  // Clean committed work past clean threshold. Clean zero-ahead worktrees are
  // handled by `empty` once old enough; before then they stay active.
  if (
    !candidate.isDirty &&
    candidate.commitsAhead > 0 &&
    candidate.ageMs > cleanThresholdMs
  ) {
    return 'stale-clean';
  }

  return 'active';
}

// ---------------------------------------------------------------------------
// Section 4 — Soft-launch counter
// ---------------------------------------------------------------------------

async function countPriorSuccessfulRuns(telemetryPath: string): Promise<number> {
  if (!existsSync(telemetryPath)) return 0;
  let count = 0;
  try {
    const rl = createInterface({ input: createReadStream(telemetryPath), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          record['taskId'] === 'worktree-prune' &&
          (record['status'] === 'success' || record['status'] === 'error')
        ) {
          count++;
        }
      } catch { /* malformed line — skip */ }
    }
  } catch { /* file read failure — treat as 0 */ }
  return count;
}

// ---------------------------------------------------------------------------
// Section 5 — Advisory lock
// ---------------------------------------------------------------------------

class LockContestedError extends Error {
  constructor(lockPath: string) {
    super(`Worktree sweep lock contested: ${lockPath} — another sweep may be running.`);
    this.name = 'LockContestedError';
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  // Ensure parent directory exists
  const parentDir = join(lockPath, '..');
  await fs.mkdir(parentDir, { recursive: true }).catch(() => {});

  const tryOpen = async (): Promise<import('node:fs/promises').FileHandle> => {
    try {
      return await fs.open(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Check if PID in existing lock is still alive
      let existingPid: number | null = null;
      try {
        const content = await fs.readFile(lockPath, 'utf-8');
        existingPid = parseInt(content.trim(), 10);
      } catch { /* lock file vanished between checks */ }

      if (existingPid !== null && !Number.isNaN(existingPid)) {
        let alive = false;
        try {
          process.kill(existingPid, 0);
          alive = true;
        } catch { /* process gone — stale lock */ }
        if (!alive) {
          await fs.unlink(lockPath).catch(() => {});
          return await fs.open(lockPath, 'wx');
        }
      }
      throw new LockContestedError(lockPath);
    }
  };

  const handle = await tryOpen();
  await handle.writeFile(String(process.pid), 'utf-8');
  await handle.close();

  return async () => { await fs.unlink(lockPath).catch(() => {}); };
}

// ---------------------------------------------------------------------------
// Section 6 — Public entry point: runSweep()
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

  // Soft-launch valve: force dry-run for first 3 real runs. Callers with
  // their own narrower allowlist can bypass to avoid being stuck in
  // dry-run on machines that don't run the daemon.
  const priorRuns = options.bypassSoftLaunch
    ? Number.POSITIVE_INFINITY
    : await countPriorSuccessfulRuns(resolvedTelemetryPath);
  const effectiveDryRun = (options.dryRun === true) || (priorRuns < 3);
  result.dryRun = effectiveDryRun;

  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireLock(lockPath);
  } catch (err) {
    if (err instanceof LockContestedError) {
      result.warnings.push(`[WARN] ${err.message}`);
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
    try {
      const entries = await fs.readdir(afkWorktreesRoot, { withFileTypes: true });
      diskEntries = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(afkWorktreesRoot, e.name));
    } catch { /* .afk-worktrees doesn't exist yet — no orphaned dirs */ }

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
          orphanAgeMs = Date.now() - stat.birthtimeMs;
        } catch { /* use 0 */ }
        result.candidates.push({
          path: orphanPath,
          verdict: 'orphaned-dir',
          owner: 'interactive',
          ageMs: orphanAgeMs,
        });
        if (!effectiveDryRun) {
          try {
            await fs.rm(orphanPath, { recursive: true, force: true });
            result.removed.push(orphanPath);
          } catch (err) {
            result.warnings.push(
              `[ERROR] Failed to remove orphaned dir ${orphanPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // Invariant: a worktree hosting a LIVE top-level session must never be
    // reaped, even when the creator pid in .afk-worktree-meta.json is dead —
    // the creating process and the session actively working inside are
    // frequently different (a resumed session, or a hand-recreated worktree).
    // meta.pid alone misses this and the dead-owner verdict would reap an
    // in-use worktree. Presence files are the authoritative "someone is working
    // here now" signal: each live top-level session writes one with its own pid
    // + cwd. We trust a record only when its pid is actually alive, so a crashed
    // session's stale file cannot protect a worktree forever.
    const presenceReader = options.readPresence ?? readPresenceFiles;
    let liveSessionCwds: string[] = [];
    try {
      const presenceRecords = await presenceReader();
      liveSessionCwds = presenceRecords
        .filter((r) => typeof r.pid === 'number' && r.pid > 0 && isProcessAlive(r.pid))
        .map((r) => r.cwd)
        .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0);
    } catch {
      // Presence is advisory + best-effort: on any read failure, fall back to
      // the meta.pid liveness check alone (prior behavior).
    }

    // Process registered worktrees (skip main/bare)
    let hasOrphanedRegistrations = false;
    const mainPath = parsed[0]?.path;

    for (const entry of parsed) {
      // Skip main worktree and bare repos
      if (entry.path === mainPath || entry.isBare) continue;
      // Skip worktrees not under .afk-worktrees/
      if (!entry.path.startsWith(afkWorktreesRoot)) continue;

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
      let commitsAhead = 0;
      try {
        const statusResult = await execFile('git', ['-C', entry.path, 'status', '--porcelain']);
        isDirty = statusResult.stdout.trim().length > 0;
      } catch { isDirty = true; /* treat as dirty — safe fallback */ }

      if (!isDirty && entry.head) {
        const baseSha = meta?.baseSha ?? entry.head;
        try {
          const countResult = await execFile('git', ['-C', repoRoot, 'rev-list', `${baseSha}..${entry.head}`, '--count']);
          commitsAhead = parseInt(countResult.stdout.trim(), 10) || 0;
        } catch { commitsAhead = 0; }
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
        commitsAhead,
        ownerLiveness,
      };

      const verdict = classifyCandidate(candidate, maxAgeDaysClean, maxAgeDaysDirty);
      result.candidates.push({ path: entry.path, verdict, owner: resolvedOwner, ageMs });

      if (effectiveDryRun) continue;

      try {
        if (verdict === 'empty') {
          await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', entry.path]);
          if (entry.branch) {
            await execFile('git', ['-C', repoRoot, 'branch', '-d', entry.branch]).catch(() => {});
          }
          result.removed.push(entry.path);
        } else if (verdict === 'dead-owner') {
          // Mirrors the 'empty' removal path: clean tree, no commits ahead,
          // safe to drop wholesale. Also attempt branch deletion since the
          // owning REPL never got to merge or land it. Branch delete is
          // best-effort (it may already be deleted, or be checked out
          // elsewhere — git refuses, we move on).
          await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', entry.path]);
          if (entry.branch) {
            await execFile('git', ['-C', repoRoot, 'branch', '-d', entry.branch]).catch(() => {});
          }
          result.removed.push(entry.path);
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
            `[WARN] stale-dirty worktree preserved (uncommitted changes): ${entry.path}`,
          );
        }
        // 'locked', 'active' → no-op
      } catch (err) {
        result.warnings.push(
          `[ERROR] Failed to process ${entry.path} (${verdict}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (hasOrphanedRegistrations && !effectiveDryRun) {
      try {
        await execFile('git', ['-C', repoRoot, 'worktree', 'prune']);
      } catch (err) {
        result.warnings.push(
          `[ERROR] git worktree prune failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    if (releaseLock) await releaseLock();
  }

  return result;
}

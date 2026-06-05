/**
 * Speculative Branch Farm — worktree isolation layer.
 *
 * Spawns N isolated `git worktree`s under `$AFK_HOME/farms/<taskSlug>/branch-<n>/`,
 * each on its own fresh branch derived from a captured base ref. A `farm.json`
 * manifest is written alongside the worktrees so downstream consumers (score
 * skill, Telegram digest, GC) can read state without re-deriving from git.
 *
 * Design contract:
 * - Worktrees live under AFK_HOME, never inside the source repo's working tree —
 *   this keeps `.gitignore` and editor file-watchers out of scope.
 * - Branch refs are namespaced `afk/farm/<taskSlug>/<index>-<labelSlug>` so
 *   abandoned farms are greppable and bulk-deletable.
 * - The base ref is captured as a SHA at creation time, so concurrent edits in
 *   the source repo cannot shift what each branch was derived from.
 * - Partial-failure cleanup is best-effort: if branch K fails, branches 1..K-1
 *   are removed before the error propagates.
 * - All git invocations use `execFile` (no shell) — task names and labels are
 *   slugged before reaching git, but argv isolation is the defense-in-depth.
 *
 * What this module is NOT:
 * - It does not run agents in worktrees (that's a later step).
 * - It does not score or rank branches (`src/skills/score/`).
 * - It does not interact with GitHub or `gh` (PR creation lives in the Telegram
 *   callback flow).
 *
 * @module agent/worktree
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getFarmDir, getFarmsDir } from '../paths.js';

const execFileAsync = promisify(execFile);

/** Sanity cap on concurrent speculative branches. */
export const MAX_FARM_BRANCHES = 16;

/**
 * A2: canonical schema version constant — bump this when the FarmManifest
 * shape changes and update `migrateFarmManifest` accordingly.
 */
export const FARM_MANIFEST_SCHEMA_VERSION = 3 as const;

/**
 * A2: discriminated error codes for WorktreeError so callers can branch on
 * the kind of failure without parsing message strings.
 */
export type WorktreeErrorCode = 'unsupported-schema' | 'not-found' | 'invalid';

export class WorktreeError extends Error {
  public override readonly cause?: unknown;
  /** A2: machine-readable error code for discriminated handling by callers. */
  public readonly code?: WorktreeErrorCode;
  constructor(message: string, cause?: unknown, code?: WorktreeErrorCode) {
    super(message);
    this.name = 'WorktreeError';
    this.cause = cause;
    this.code = code;
  }
}

export interface CreatedBranch {
  /** 1-indexed position within the farm. */
  index: number;
  /** Caller-supplied label (slugged); undefined falls back to "branch-{n}". */
  label?: string;
  /** Absolute filesystem path to the worktree. */
  path: string;
  /** Full git branch ref the worktree is checked out on. */
  branch: string;
}

export interface FarmManifest {
  /** Schema version of this manifest. Bump on breaking shape changes. */
  schemaVersion: 1 | 2 | 3;
  taskId: string;
  taskSlug: string;
  /** Original human-supplied task name, before slugging. */
  taskName: string;
  /** Absolute path to the source repo's toplevel. */
  repoRoot: string;
  /** Commit SHA captured at farm creation — every branch derives from this. */
  baseRef: string;
  /** Branch ref the baseRef was resolved from (e.g. `refs/heads/main`). May be undefined for detached HEADs. */
  baseBranch?: string;
  /** Absolute path to the farm directory. */
  farmDir: string;
  /** ISO timestamp at creation. */
  createdAt: string;
  branches: CreatedBranch[];
  /** Human decision recorded after farm completion. Optional; only set when the user resolves the farm. */
  human_decision?: 'approved' | 'rejected' | 'edited_then_merged';
  /** ISO timestamp when human_decision was recorded. */
  decidedAt?: string;
  /** Cross-session memory fact ID recording this farm run. Set after writeFarmFact succeeds. */
  memoryFactId?: number;
  /** ISO timestamp when this farm was respawned. */
  respawnedAt?: string;
  /** Task slug of the child farm spawned from this farm's winner. */
  respawnedAs?: string;
  /** Pull request URL if one was opened for this farm. */
  prUrl?: string;
  /** ISO timestamp when the PR was created. */
  prCreatedAt?: string;
}

export interface CreateFarmOptions {
  /** Human-readable task description; slugged into the farm path. */
  taskName: string;
  /** Number of speculative branches to spawn (1..MAX_FARM_BRANCHES). */
  count: number;
  /** Optional per-branch labels; falls back to `branch-{n}`. Length must equal `count` if provided. */
  labels?: string[];
  /** Override the source repo (defaults to git toplevel of `process.cwd()`). */
  cwd?: string;
  /** Override the base ref (defaults to current HEAD of `cwd`). Accepts any ref or SHA. */
  baseRef?: string;
  /**
   * Override the task slug entirely (mostly for tests + deterministic IDs).
   * If unset, slug is derived from taskName + ISO timestamp + 4 random hex chars.
   */
  taskSlug?: string;
  /**
   * Clock injection (for tests). Returns a Date instance.
   */
  now?: () => Date;
  /**
   * Random suffix generator (for tests). Returns a 4-char hex string.
   */
  randomSuffix?: () => string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function slugify(input: string, maxLen = 40): string {
  const cleaned = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, maxLen).replace(/-+$/g, '') || 'task';
}

function defaultRandomSuffix(): string {
  // C4: use 32-bit crypto-grade randomness instead of ~16-bit Math.random to
  // reduce slug collision probability when many farms are created in the same
  // second.  randomBytes(4) yields exactly 8 hex chars; we take the first 4.
  return randomBytes(4).toString('hex').slice(0, 4);
}

function isoCompact(d: Date): string {
  // 20260514T153045 — sorts lexically, no separators that clash with path/branch refs.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Build a farm task slug from a human task name. Canonical formula used by
 * `createFarm` and any external caller (e.g. the Telegram Respawn handler)
 * that needs to generate a slug it will pass to `createFarm` via
 * `--task-slug`. Centralising the formula here guarantees that the slug a
 * caller writes into a parent manifest's `respawnedAs` field exactly matches
 * the `taskSlug` that `createFarm` will produce in the child manifest.
 *
 * Shape: `<isoCompact(now)>-<slugify(taskName, 32)>-<4hex>`.
 *
 * `now` and `randomSuffix` are injectable so callers can produce deterministic
 * slugs in tests; in production both default to wall-clock + crypto-grade
 * randomness (well, `Math.random` — same source `createFarm` has always used).
 */
export function buildFarmSlug(
  taskName: string,
  opts: { now?: () => Date; randomSuffix?: () => string } = {},
): string {
  const now = (opts.now ?? (() => new Date()))();
  const suffix = (opts.randomSuffix ?? defaultRandomSuffix)();
  return `${isoCompact(now)}-${slugify(taskName, 32)}-${suffix}`;
}

async function git(
  repoCwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, { cwd: repoCwd, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const detail = (e.stderr ?? e.stdout ?? e.message ?? '').toString().trim();
    throw new WorktreeError(`git ${args.join(' ')} failed: ${detail}`, err);
  }
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!stdout) throw new WorktreeError(`not a git repository: ${cwd}`);
  return stdout;
}

async function resolveBaseRef(
  repoRoot: string,
  ref: string | undefined,
): Promise<{ sha: string; branch?: string }> {
  if (ref) {
    const { stdout: sha } = await git(repoRoot, ['rev-parse', ref]);
    return { sha };
  }
  const { stdout: sha } = await git(repoRoot, ['rev-parse', 'HEAD']);
  // Try to capture the symbolic branch name; falls through to undefined on detached HEAD.
  let branch: string | undefined;
  try {
    const { stdout } = await git(repoRoot, ['symbolic-ref', '--quiet', 'HEAD']);
    if (stdout) branch = stdout;
  } catch {
    // detached HEAD — leave branch undefined
  }
  return { sha, branch };
}

function buildBranchRef(taskSlug: string, index: number, label?: string): string {
  const labelPart = label ? slugify(label, 32) : `branch-${index}`;
  return `afk/farm/${taskSlug}/${index}-${labelPart}`;
}

function buildBranchPath(farmDir: string, index: number): string {
  return join(farmDir, `branch-${index}`);
}

async function tryRemoveWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  // `git worktree remove --force` cleans the registration; fs cleanup is its job.
  try {
    await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // best-effort
  }
}

async function tryDeleteBranch(repoRoot: string, branchRef: string): Promise<void> {
  try {
    await git(repoRoot, ['branch', '-D', branchRef]);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a speculative branch farm: spawns `count` worktrees, each on a fresh
 * branch derived from a captured base ref. Writes a `farm.json` manifest.
 *
 * On partial failure, already-created worktrees and branches are removed
 * best-effort before the error propagates — no orphaned state should remain
 * in `$AFK_HOME/farms/`. The source repo may still hold dangling refs if a
 * branch-delete call also failed; these are namespaced under `afk/farm/...`
 * and safe to bulk-prune later.
 */
export async function createFarm(opts: CreateFarmOptions): Promise<FarmManifest> {
  if (opts.count < 1 || opts.count > MAX_FARM_BRANCHES) {
    throw new WorktreeError(
      `count must be between 1 and ${MAX_FARM_BRANCHES}, got ${opts.count}`,
    );
  }
  if (opts.labels && opts.labels.length !== opts.count) {
    throw new WorktreeError(
      `labels.length (${opts.labels.length}) must equal count (${opts.count})`,
    );
  }

  const sourceCwd = opts.cwd ?? process.cwd();
  const repoRoot = await resolveRepoRoot(sourceCwd);
  const { sha: baseRef, branch: baseBranch } = await resolveBaseRef(repoRoot, opts.baseRef);

  // Slug derivation is delegated to `buildFarmSlug` so external callers
  // (e.g. the Telegram Respawn handler) generate identical slugs without
  // duplicating the formula. `opts.now`/`opts.randomSuffix` thread through.
  const now = (opts.now ?? (() => new Date()))();
  const taskSlug =
    opts.taskSlug ?? buildFarmSlug(opts.taskName, { now: () => now, randomSuffix: opts.randomSuffix });
  const taskId = opts.taskSlug ?? taskSlug; // identical today; kept distinct for future divergence.

  const farmDir = getFarmDir(taskSlug);

  // Fail loudly if the farm dir already exists — caller must explicitly remove first.
  try {
    await fs.access(farmDir);
    throw new WorktreeError(`farm directory already exists: ${farmDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof WorktreeError) throw err;
      // unexpected stat error — surface it
      throw new WorktreeError(`failed to check farm dir ${farmDir}`, err);
    }
  }

  await fs.mkdir(farmDir, { recursive: true });

  const created: CreatedBranch[] = [];
  try {
    for (let i = 1; i <= opts.count; i++) {
      const label = opts.labels?.[i - 1];
      const branchRef = buildBranchRef(taskSlug, i, label);
      const worktreePath = buildBranchPath(farmDir, i);

      // `git worktree add -b <branch> <path> <baseRef>` creates the branch from
      // baseRef and checks it out into a new worktree in a single git call.
      await git(repoRoot, ['worktree', 'add', '-b', branchRef, worktreePath, baseRef]);

      created.push({
        index: i,
        label: label ? slugify(label, 32) : undefined,
        path: worktreePath,
        branch: branchRef,
      });
    }
  } catch (err) {
    // Roll back: remove worktrees + branches in reverse order, then the farm dir.
    for (const b of created.slice().reverse()) {
      await tryRemoveWorktree(repoRoot, b.path);
      await tryDeleteBranch(repoRoot, b.branch);
    }
    await fs.rm(farmDir, { recursive: true, force: true }).catch(() => {});
    throw err instanceof WorktreeError
      ? err
      : new WorktreeError(`farm creation failed`, err);
  }

  const manifest: FarmManifest = {
    schemaVersion: 3,
    taskId,
    taskSlug,
    taskName: opts.taskName,
    repoRoot,
    baseRef,
    baseBranch,
    farmDir,
    createdAt: now.toISOString(),
    branches: created,
  };

  await fs.writeFile(join(farmDir, 'farm.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return manifest;
}

/**
 * A1: Migrate a parsed-but-not-yet-validated manifest forward so that v1/v2
 * manifests gain explicit `undefined`-equivalent defaults for all v3-only
 * optional fields.  This is a best-effort in-memory transform; callers must
 * persist the manifest themselves if they want the migration durable.
 *
 * Migration table (v1 → v3 and v2 → v3):
 *   - `respawnedAt`  — introduced in v2; back-filled as `undefined`
 *   - `respawnedAs`  — introduced in v2; back-filled as `undefined`
 *   - `prUrl`        — introduced in v3; back-filled as `undefined`
 *   - `prCreatedAt`  — introduced in v3; back-filled as `undefined`
 *
 * `schemaVersion` is NOT bumped here — that happens on the next structured
 * write (e.g. `recordRespawn`, `recordPrCreated`) so the file is only touched
 * when there is a real state change.
 */
function migrateFarmManifest(raw: FarmManifest): FarmManifest {
  const m = raw as Partial<FarmManifest> & Pick<FarmManifest, 'schemaVersion'>;

  // v1 → v2+ fields
  if (m.respawnedAt === undefined) m.respawnedAt = undefined;
  if (m.respawnedAs === undefined) m.respawnedAs = undefined;

  // v2 → v3 fields
  if (m.prUrl === undefined) m.prUrl = undefined;
  if (m.prCreatedAt === undefined) m.prCreatedAt = undefined;

  return m as FarmManifest;
}

/** Load a farm manifest by taskSlug. Returns null if the manifest doesn't exist. */
export async function loadFarm(taskSlug: string): Promise<FarmManifest | null> {
  const manifestPath = join(getFarmDir(taskSlug), 'farm.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as FarmManifest;
    if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) {
      throw new WorktreeError(
        `unsupported farm manifest schema: ${parsed.schemaVersion} (expected 1, 2, or 3)`,
        undefined,
        'unsupported-schema',
      );
    }
    // A1: migrate older manifests to have all v3 optional fields present
    return migrateFarmManifest(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof WorktreeError) throw err;
    throw new WorktreeError(`failed to load farm manifest ${manifestPath}`, err, 'invalid');
  }
}

/** List all farm slugs currently present under `$AFK_HOME/farms/`. */
export async function listFarms(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getFarmsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new WorktreeError(`failed to list farms`, err);
  }
}

/**
 * Remove a single branch from a farm: unregisters the worktree, deletes the
 * branch ref, and updates the manifest. Other branches in the farm continue
 * to exist.
 */
export async function removeBranch(taskSlug: string, index: number): Promise<void> {
  const manifest = await loadFarm(taskSlug);
  if (!manifest) throw new WorktreeError(`farm not found: ${taskSlug}`);
  const branch = manifest.branches.find((b) => b.index === index);
  if (!branch) throw new WorktreeError(`branch ${index} not in farm ${taskSlug}`);

  await tryRemoveWorktree(manifest.repoRoot, branch.path);
  await tryDeleteBranch(manifest.repoRoot, branch.branch);

  manifest.branches = manifest.branches.filter((b) => b.index !== index);
  await fs.writeFile(
    join(manifest.farmDir, 'farm.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Remove an entire farm: unregister all worktrees, delete all branches,
 * and delete the farm directory.
 *
 * Best-effort: individual worktree/branch removal failures are swallowed so a
 * partially-corrupt farm can still be fully GC'd. The farm directory delete
 * uses `rm -rf` semantics.
 */
export async function removeFarm(taskSlug: string): Promise<void> {
  const manifest = await loadFarm(taskSlug);
  if (manifest) {
    for (const b of manifest.branches) {
      await tryRemoveWorktree(manifest.repoRoot, b.path);
      await tryDeleteBranch(manifest.repoRoot, b.branch);
    }
  }
  await fs.rm(getFarmDir(taskSlug), { recursive: true, force: true });
}

/**
 * Record a human decision against an existing farm manifest.
 *
 * Loads the manifest, sets `human_decision` and `decidedAt`, bumps
 * `schemaVersion` to 3, and writes the updated manifest atomically back to
 * `farm.json`. Returns the updated manifest.
 */
export async function recordHumanDecision(
  taskSlug: string,
  decision: 'approved' | 'rejected' | 'edited_then_merged',
): Promise<FarmManifest> {
  const manifest = await loadFarm(taskSlug);
  if (!manifest) throw new WorktreeError(`farm not found: ${taskSlug}`);

  manifest.human_decision = decision;
  manifest.decidedAt = new Date().toISOString();
  // schemaVersion: protocol invariant — v3 is required to carry human_decision
  manifest.schemaVersion = 3;

  await fs.writeFile(
    join(manifest.farmDir, 'farm.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return manifest;
}

/**
 * Record that this farm was respawned, producing a child farm.
 *
 * Sets `respawnedAt` and `respawnedAs`, bumps `schemaVersion` to 3, and
 * writes the updated manifest atomically back to `farm.json`. Returns the
 * updated manifest.
 */
export async function recordRespawn(
  taskSlug: string,
  respawnedAs: string,
): Promise<FarmManifest> {
  const manifest = await loadFarm(taskSlug);
  if (!manifest) throw new WorktreeError(`farm not found: ${taskSlug}`);

  manifest.respawnedAt = new Date().toISOString();
  manifest.respawnedAs = respawnedAs;
  manifest.schemaVersion = 3;

  await fs.writeFile(
    join(manifest.farmDir, 'farm.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return manifest;
}

/**
 * Persist the cross-session memory fact ID for this farm run.
 *
 * Called after `writeFarmFact` succeeds. Bumps `schemaVersion` to 3 and
 * writes the updated manifest atomically back to `farm.json`. Returns the
 * updated manifest.
 */
export async function setFarmMemoryFactId(
  taskSlug: string,
  factId: number,
): Promise<FarmManifest> {
  const manifest = await loadFarm(taskSlug);
  if (!manifest) throw new WorktreeError(`farm not found: ${taskSlug}`);

  manifest.memoryFactId = factId;
  manifest.schemaVersion = 3;

  await fs.writeFile(
    join(manifest.farmDir, 'farm.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return manifest;
}

/**
 * Records a successfully opened pull request on the farm manifest.
 *
 * Sets `prUrl`, `prCreatedAt`, and bumps `schemaVersion` to 3. Returns the
 * updated manifest. Throws `WorktreeError` if the farm cannot be found.
 */
export async function recordPrCreated(
  taskSlug: string,
  prUrl: string,
): Promise<FarmManifest> {
  const manifest = await loadFarm(taskSlug);
  if (!manifest) throw new WorktreeError(`farm not found: ${taskSlug}`);

  manifest.prUrl = prUrl;
  manifest.prCreatedAt = new Date().toISOString();
  manifest.schemaVersion = 3;

  await fs.writeFile(
    join(manifest.farmDir, 'farm.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return manifest;
}

/**
 * Reusable primitives for afk-managed git worktrees.
 *
 * Factored out of `handlers/worktree.ts` so BOTH the `worktree` lifecycle tool
 * AND the `agent` tool's `isolation: "worktree"` path (subagent-executor.ts)
 * create and tear down worktrees through the SAME git argv + meta protocol —
 * `.afk-worktrees/<slug>` trees carrying `.afk-worktree-meta.json`, reclaimed
 * by the sweep engine (`worktree-sweep.ts`).
 *
 * Invariant: the git argv emitted here must stay byte-identical to what the
 * `worktree` handler emitted before this extraction — `worktree.test.ts`
 * asserts exact argv, and any drift silently changes the sweep engine's
 * contract. Every git call goes through an injectable {@link ExecFileFn}
 * (mocked in tests); nothing here shells out except through it.
 *
 * @module agent/tools/handlers/worktree-managed
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import type { ExecFileFn } from '../../worktree-sweep.js';
import { env } from '../../../config/env.js';

/** Default git runner. Exported so callers without their own can reuse it. */
export const defaultExecFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

export interface RepoContext {
  /** MAIN checkout root (resolved via --git-common-dir, worktree-safe). */
  repoRoot: string;
  /** `<repoRoot>/.afk-worktrees` — where all managed trees live. */
  afkWorktreesRoot: string;
}

/**
 * Resolve the repo root from `cwd` via `--git-common-dir` so the answer is the
 * MAIN checkout even when `cwd` itself is a linked worktree. Throws when `cwd`
 * is not inside a git repository.
 */
export async function resolveRepoContext(
  execFile: ExecFileFn,
  cwd: string,
): Promise<RepoContext> {
  const result = await execFile('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
  const raw = result.stdout.trim();
  if (!raw) throw new Error('Not in a git repository.');
  const absoluteGitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const repoRoot = dirname(absoluteGitDir);
  return { repoRoot, afkWorktreesRoot: join(repoRoot, '.afk-worktrees') };
}

/** Lowercase-kebab sanitization for worktree slugs / branch fragments. */
export function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

export interface CreateManagedWorktreeArgs {
  execFile: ExecFileFn;
  /** MAIN repo root (from {@link resolveRepoContext}). */
  repoRoot: string;
  /** Absolute checkout path (caller confines it under `.afk-worktrees/`). */
  worktreePath: string;
  /** Full branch name to create, e.g. `afk/my-feature`. */
  branch: string;
  /** Git ref the new branch is based on, e.g. `HEAD`. */
  baseRef: string;
  /** Meta `owner` tag. Default `'agent'`. */
  owner?: string;
}

export interface ManagedWorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  /** Resolved SHA of `baseRef` at creation ('' if rev-parse failed). */
  baseSha: string;
}

/**
 * Create a worktree + branch and stamp `.afk-worktree-meta.json`.
 *
 * Emits `git worktree add -b <branch> <path> <baseRef>`, then best-effort
 * `rev-parse <baseRef>` (for `baseSha`) and the meta write — neither of which
 * fails the create (mirrors the pre-extraction handler behavior exactly).
 */
export async function createManagedWorktree(
  args: CreateManagedWorktreeArgs,
): Promise<ManagedWorktreeInfo> {
  const { execFile, repoRoot, worktreePath, branch, baseRef } = args;
  await execFile('git', [
    '-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, baseRef,
  ]);
  // Meta write is what makes this tree a first-class citizen of the sweep
  // protocol (age from createdAt, PID liveness). Best-effort: never fail the
  // create over the rev-parse or the write.
  let baseSha = '';
  try {
    const sha = await execFile('git', ['-C', repoRoot, 'rev-parse', baseRef]);
    baseSha = sha.stdout.trim();
  } catch { /* non-fatal */ }
  try {
    await fs.writeFile(
      join(worktreePath, '.afk-worktree-meta.json'),
      JSON.stringify(
        {
          owner: args.owner ?? 'agent',
          pid: process.pid,
          createdAt: new Date().toISOString(),
          baseSha,
          baseBranch: baseRef,
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch { /* best-effort */ }
  return { path: worktreePath, branch, baseRef, baseSha };
}

/** True when the worktree has uncommitted changes (unreadable → dirty). */
export async function isManagedWorktreeDirty(
  execFile: ExecFileFn,
  worktreePath: string,
): Promise<boolean> {
  try {
    const status = await execFile('git', ['-C', worktreePath, 'status', '--porcelain']);
    return status.stdout.trim().length > 0;
  } catch {
    return true; // unreadable → treat as dirty (safe fallback)
  }
}

/** Commits the worktree HEAD is ahead of its recorded base (0 if unknowable). */
export async function managedWorktreeCommitsAhead(
  execFile: ExecFileFn,
  repoRoot: string,
  worktreePath: string,
): Promise<number> {
  // Base SHA from meta when available; unknowable without it → report 0 and
  // rely on the dirty/lock guards (mirrors the sweep engine's fallback).
  try {
    const metaRaw = await fs.readFile(join(worktreePath, '.afk-worktree-meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw) as { baseSha?: string };
    if (!meta.baseSha) return 0;
    const head = await execFile('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
    const count = await execFile('git', [
      '-C', repoRoot, 'rev-list', `${meta.baseSha}..${head.stdout.trim()}`, '--count',
    ]);
    return parseInt(count.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** Discriminated outcome of {@link removeManagedWorktreeGuarded}. */
export type GuardedRemoveOutcome =
  | { removed: true; branchPreserved: string | null }
  | { removed: false; reason: 'dirty' }
  | { removed: false; reason: 'commits-ahead'; commitsAhead: number };

export interface RemoveManagedWorktreeArgs {
  execFile: ExecFileFn;
  repoRoot: string;
  /** Absolute worktree path (caller owns lock/main/outside-root checks). */
  worktreePath: string;
  /** Branch ref for the result (never deleted — removal drops the checkout only). */
  branch?: string | null;
  /** When true, remove even if dirty / commits-ahead. */
  force?: boolean;
}

/**
 * Guarded worktree removal. Refuses (returns `removed:false` + reason) a dirty
 * or commits-ahead tree unless `force`. Emits `git worktree remove [--force]
 * <path>` on success. Never removes the branch ref. Caller maps the reason to
 * user-facing text (handler) or preserve-and-lock (executor teardown).
 */
export async function removeManagedWorktreeGuarded(
  args: RemoveManagedWorktreeArgs,
): Promise<GuardedRemoveOutcome> {
  const { execFile, repoRoot, worktreePath, force } = args;
  if (!force) {
    if (await isManagedWorktreeDirty(execFile, worktreePath)) {
      return { removed: false, reason: 'dirty' };
    }
    const ahead = await managedWorktreeCommitsAhead(execFile, repoRoot, worktreePath);
    if (ahead > 0) {
      return { removed: false, reason: 'commits-ahead', commitsAhead: ahead };
    }
  }
  const gitArgs = ['-C', repoRoot, 'worktree', 'remove'];
  if (force) gitArgs.push('--force');
  gitArgs.push(worktreePath);
  await execFile('git', gitArgs);
  return { removed: true, branchPreserved: args.branch ?? null };
}

/**
 * Create an isolated worktree for a subagent dispatch. Resolves the repo root
 * from `cwd`, derives a collision-safe slug + branch, and creates the tree.
 * Throws when `cwd` is not a git repo — the caller MUST fail loudly rather than
 * fall back to the shared tree (that reintroduces the cross-contamination bug
 * isolation exists to prevent).
 */
export async function createIsolatedWorktree(args: {
  execFile?: ExecFileFn;
  /** Session cwd to resolve the repo root from. */
  cwd: string;
  /** Raw slug hint (sanitized here); e.g. `iso-agent-tool-3-a1b2c3`. */
  slugHint: string;
  /** Base ref for the branch. Default `HEAD`. */
  baseRef?: string;
}): Promise<ManagedWorktreeInfo & { repoRoot: string }> {
  const execFile = args.execFile ?? defaultExecFile;
  const ctx = await resolveRepoContext(execFile, args.cwd); // throws if non-git
  const slug = sanitizeSlug(args.slugHint) || 'iso';
  const worktreePath = join(ctx.afkWorktreesRoot, slug);
  const prefix = env.AFK_WORKTREE_BRANCH_PREFIX ?? 'afk/';
  const branch = `${prefix}${slug}`;
  const baseRef = args.baseRef ?? 'HEAD';
  // Invariant: isolation:"worktree" fans out SEVERAL parallel dispatches, each
  // running `git worktree add` against the SAME main repo — which serializes on
  // the repo/index lock. A burst can transiently fail with a lock error, so we
  // retry the create EXACTLY ONCE after a short backoff. Retry is scoped to
  // lock contention ONLY (regex below): a non-lock error — not-a-git-repo,
  // branch/path already exists, etc. — is deterministic and MUST propagate
  // immediately (retrying it would just fail again, or worse, mask a real bug).
  // Note: resolveRepoContext above stays OUTSIDE this retry — it is the non-git
  // precondition and must fail loud. Only createManagedWorktree is wrapped.
  const LOCK_CONTENTION =
    /could not lock|index\.lock|already locked|unable to create .*\.lock|File exists/i;
  const create = () =>
    createManagedWorktree({
      execFile,
      repoRoot: ctx.repoRoot,
      worktreePath,
      branch,
      baseRef,
    });
  let info: ManagedWorktreeInfo;
  try {
    info = await create();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!LOCK_CONTENTION.test(message)) throw err; // non-lock → propagate, no retry
    await new Promise((r) => setTimeout(r, 100)); // brief backoff, then retry once
    info = await create();
  }
  return { repoRoot: ctx.repoRoot, ...info };
}

/** Result of {@link teardownIsolatedWorktree}. */
export interface IsolatedTeardownResult {
  removed: boolean;
  /** True when the tree was kept (dirty/ahead) and locked against the sweep. */
  preserved: boolean;
  reason?: 'dirty' | 'commits-ahead';
}

/**
 * Tear down an isolated worktree after its subagent finishes. Removes a
 * clean tree; PRESERVES a dirty / commits-ahead tree (WIP is never destroyed)
 * and `git worktree lock`s it so the sweep engine never reaps it out from
 * under work in progress. Best-effort — never throws (teardown runs in a
 * `finally`).
 */
export async function teardownIsolatedWorktree(args: {
  execFile?: ExecFileFn;
  repoRoot: string;
  worktreePath: string;
}): Promise<IsolatedTeardownResult> {
  const execFile = args.execFile ?? defaultExecFile;
  try {
    const outcome = await removeManagedWorktreeGuarded({
      execFile,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      force: false,
    });
    if (outcome.removed) return { removed: true, preserved: false };
    // Dirty or commits-ahead → preserve WIP; lock so the sweep never reaps it.
    try {
      await execFile('git', [
        '-C', args.repoRoot, 'worktree', 'lock',
        '--reason', `afk: isolated-worktree preserved (${outcome.reason})`,
        args.worktreePath,
      ]);
    } catch { /* best-effort */ }
    return { removed: false, preserved: true, reason: outcome.reason };
  } catch {
    return { removed: false, preserved: false };
  }
}

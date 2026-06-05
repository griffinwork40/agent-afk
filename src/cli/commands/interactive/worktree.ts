/**
 * Worktree helper for `afk interactive`.
 *
 * Creates a sibling git worktree under `<repoRoot>/.afk-worktrees/<slug>` and
 * returns a handle whose `cleanup()` removes the worktree only when the tree
 * is clean — preserving uncommitted work otherwise.
 *
 * Resolution of the main repo root uses `git rev-parse --git-common-dir`
 * (not `--show-toplevel`) so the helper still points to the primary repo
 * even when invoked from inside an existing linked worktree.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { env } from '../../../config/env.js';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { recordCdIntent, shellWrapperActive } from '../../../utils/cd-on-exit.js';
import { detectShellFromEnv } from '../shell-init.js';

const execFileDefault = promisify(execFileCallback);

export type ExecFileFn = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export interface WorktreeHandle {
  /**
   * Absolute path to the worktree on disk.
   *
   * Stable for the life of the handle. AFK creates each worktree exactly
   * once, with its final name (see {@link setupWorktreeDeferred}), and never
   * `git worktree move`s it — so this path never changes after creation.
   */
  path: string;
  /**
   * Branch name backing the worktree. Stable for the same reason as
   * {@link WorktreeHandle.path}: the branch is named at creation and never
   * renamed mid-session.
   */
  branch: string;
  /**
   * Remove the worktree if clean; otherwise log and preserve.
   *
   * Best-effort: never throws. Any git failure during cleanup (missing
   * worktree dir, locked file, transient error) is logged via `console.warn`
   * and swallowed so that callers in shutdown paths (e.g. `rl.on('close')`)
   * cannot produce unhandled promise rejections.
   *
   * Reads `path` and `branch` from the handle at invocation time.
   *
   * @param opts.force When `true`, skip the dirty-state check and remove the
   *   worktree unconditionally. Use when the session ended with zero turns —
   *   no work was done so there is nothing to preserve.
   */
  cleanup: (opts?: { force?: boolean }) => Promise<void>;
}

/**
 * Source of truth for the default branch namespace AFK creates worktrees under.
 *
 * Configurable per-install via `interactive.worktreeBranchPrefix` in
 * `afk.config.json` or the `AFK_WORKTREE_BRANCH_PREFIX` env var. The default
 * preserves the historical `afk/` namespace so existing muscle memory
 * (`git branch -D afk/*`, sweep filtering by `git branch -a | grep afk/`)
 * still works. Set to `''` to drop the prefix entirely.
 *
 * Note: this prefix is cosmetic. AFK's worktree sweep engine identifies
 * managed worktrees by directory path (`.afk-worktrees/`) and the
 * `.afk-worktree-meta.json` marker — not by branch name. Release CI
 * (`.github/workflows/*.yml`) triggers on `main` only, so renaming this
 * prefix can't affect publishing.
 */
export const DEFAULT_BRANCH_PREFIX = 'afk/';

/**
 * Allowlist for branch-prefix characters. Mirrors the conservative refname
 * grammar (alphanumerics, dash, dot, underscore, slash) plus a length cap
 * so an attacker-controlled `AFK_WORKTREE_BRANCH_PREFIX` (or config) can't
 * smuggle git CLI flags or shell metacharacters into the composed branch
 * name. The eventual {@link validateBranchName} call catches some of these
 * downstream, but the prefix is concatenated *before* the auto-generated
 * suffix so an early gate gives a clearer error and prevents any character
 * not on this list from reaching the git invocation surface.
 */
const BRANCH_PREFIX_ALLOWED = /^[A-Za-z0-9_\-./]*$/;
const BRANCH_PREFIX_MAX_LENGTH = 64;

/**
 * Validate a branch prefix sourced from untrusted config (env var or
 * `afk.config.json`). Throws on any character outside the allowlist or
 * lengths beyond {@link BRANCH_PREFIX_MAX_LENGTH}. Empty string is allowed
 * (drops the prefix entirely — documented behaviour).
 *
 * Exported so the config loader can vet `interactive.worktreeBranchPrefix`
 * at read time, before the value is ever spliced into a git invocation.
 */
export function validateBranchPrefix(value: string, source: string): string {
  if (value.length > BRANCH_PREFIX_MAX_LENGTH) {
    throw new Error(
      `Invalid branch prefix from ${source}: length ${value.length} exceeds ${BRANCH_PREFIX_MAX_LENGTH}.`,
    );
  }
  if (!BRANCH_PREFIX_ALLOWED.test(value)) {
    throw new Error(
      `Invalid branch prefix from ${source}: '${value}' — only [A-Za-z0-9_-./] are allowed.`,
    );
  }
  if (value.startsWith('-')) {
    throw new Error(
      `Invalid branch prefix from ${source}: '${value}' — must not start with '-' (would be parsed by git as a flag).`,
    );
  }
  return value;
}

/**
 * Resolve the active branch prefix, in priority order:
 *   1. Explicit caller override (`opts.branchPrefix`)
 *   2. `AFK_WORKTREE_BRANCH_PREFIX` env var
 *   3. {@link DEFAULT_BRANCH_PREFIX}
 *
 * Untrusted sources (env, config) are validated against
 * {@link validateBranchPrefix}. The explicit-override path is trusted —
 * callers inside the binary are responsible for vetting their own values.
 * The final composed branch name additionally passes through
 * {@link validateBranchName}.
 */
export function resolveBranchPrefix(override?: string): string {
  if (override !== undefined) return override;
  const envValue = env.AFK_WORKTREE_BRANCH_PREFIX;
  if (envValue !== undefined) {
    return validateBranchPrefix(envValue, 'AFK_WORKTREE_BRANCH_PREFIX');
  }
  return DEFAULT_BRANCH_PREFIX;
}

interface ExecError extends Error {
  stderr?: string;
  stdout?: string;
}

function isExecError(value: unknown): value is ExecError {
  return value instanceof Error;
}

/**
 * Format a Date as `YYYYMMDD-HHMMSS` in local time (zero-padded).
 */
function formatTimestamp(now: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const year = String(now.getFullYear());
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hours = pad2(now.getHours());
  const minutes = pad2(now.getMinutes());
  const seconds = pad2(now.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function generateAutoBranch(prefix: string): string {
  const stamp = formatTimestamp(new Date());
  const suffix = randomBytes(3).toString('hex');
  return `${prefix}${stamp}-${suffix}`;
}

/**
 * Reject branch names that are unsafe to splice into a `git worktree add -b`
 * invocation: empty, leading-dash (parsed as a flag), reserved (`HEAD`), or
 * containing characters git's refname rules disallow.
 */
function validateBranchName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid branch name: '' — branch name cannot be empty.");
  }
  if (name.startsWith('-')) {
    throw new Error(
      `Invalid branch name: '${name}' — must not start with '-' (would be parsed by git as a flag).`,
    );
  }
  if (name === 'HEAD') {
    throw new Error("Invalid branch name: 'HEAD' — reserved by git.");
  }
  if (name.includes('..')) {
    throw new Error(`Invalid branch name: '${name}' — must not contain '..'.`);
  }
  const charBlocklist: Array<{ char: string; label: string }> = [
    { char: '~', label: "'~'" },
    { char: '^', label: "'^'" },
    { char: ':', label: "':'" },
    { char: '?', label: "'?'" },
    { char: '*', label: "'*'" },
    { char: '[', label: "'['" },
    { char: '\\', label: "'\\'" },
    { char: '\0', label: 'NUL byte' },
  ];
  for (const { char, label } of charBlocklist) {
    if (name.includes(char)) {
      throw new Error(`Invalid branch name: '${name}' — must not contain ${label}.`);
    }
  }
  if (/\s/.test(name)) {
    throw new Error(`Invalid branch name: '${name}' — must not contain whitespace.`);
  }
}

async function resolveRepoRoot(execFile: ExecFileFn): Promise<string> {
  let raw: string;
  try {
    const result = await execFile('git', ['rev-parse', '--git-common-dir']);
    raw = result.stdout.trim();
  } catch {
    throw new Error('Not in a git repository (run from inside a git checkout).');
  }
  if (!raw) {
    throw new Error('Not in a git repository (run from inside a git checkout).');
  }
  const absoluteGitDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return dirname(absoluteGitDir);
}

/**
 * Idempotently ensure `<repoRoot>/.gitignore` contains a line that exactly
 * matches `.afk-worktrees/`.
 */
async function ensureGitignoreEntry(repoRoot: string): Promise<void> {
  const gitignorePath = join(repoRoot, '.gitignore');
  const target = '.afk-worktrees/';

  let content = '';
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    content = '';
  }

  const alreadyPresent = content.split('\n').some((line) => line.trim() === target);
  if (alreadyPresent) return;

  let next = content;
  if (next.length > 0 && !next.endsWith('\n')) {
    next += '\n';
  }
  next += `${target}\n`;
  await fs.writeFile(gitignorePath, next, 'utf8');
}

function classifyAddError(err: unknown, branch: string, worktreePath: string): Error {
  if (!isExecError(err)) {
    return new Error(`git worktree add failed: ${String(err)}`);
  }
  const stderr = err.stderr ?? '';
  const message = err.message ?? '';
  const haystack = `${stderr}\n${message}`;

  if (haystack.includes('already checked out') || haystack.includes('is already used by worktree')) {
    return new Error(
      `Branch '${branch}' is already checked out in another worktree. Pick a different name.`,
    );
  }
  if (haystack.includes('already exists')) {
    return new Error(
      `Worktree path '${worktreePath}' already exists. Remove it or pick a different branch name.`,
    );
  }
  return new Error(message || stderr || 'git worktree add failed');
}

/**
 * Create a sibling worktree for the current repository.
 *
 * Thin wrapper: resolves the repo root, ensures the `.gitignore` entry, then
 * creates the worktree via {@link createWorktreeAt}. Use this for the eager
 * path (explicit `--worktree <branch>`, or auto-named with autoname disabled)
 * where the branch identity is known at startup.
 *
 * @param flagValue `true` for an auto-generated branch name, or an explicit
 *                  string branch name.
 * @param opts.execFile Optional injection point used by tests; defaults to a
 *                      `promisify`'d `child_process.execFile`.
 * @param opts.branchPrefix Override for the default `afk/` branch namespace;
 *                          ignored when `flagValue` is an explicit string
 *                          (the caller already chose the full name).
 * @param opts.baseRef Optional git ref to base the new branch on (e.g.
 *                     `origin/main`). Remote-tracking refs are fetched first.
 *                     Falls back to `AFK_WORKTREE_BASE`, then the repo's HEAD.
 */
export async function setupWorktree(
  flagValue: string | true,
  opts?: { execFile?: ExecFileFn; branchPrefix?: string; baseRef?: string },
): Promise<WorktreeHandle> {
  const execFile: ExecFileFn = opts?.execFile ?? execFileDefault;
  const prefix = resolveBranchPrefix(opts?.branchPrefix);
  const repoRoot = await resolveRepoRoot(execFile);
  await ensureGitignoreEntry(repoRoot);
  return createWorktreeAt(repoRoot, flagValue, { execFile, prefix, baseRef: opts?.baseRef });
}

/**
 * A worktree whose on-disk creation is deferred until {@link create} is
 * called — typically on the user's first message, once a human-readable
 * branch name (slug) is known.
 *
 * The repo-root resolution, `.gitignore` upkeep, and explicit base-ref
 * validation/resolution run eagerly inside {@link setupWorktreeDeferred} so
 * startup-only failures are still caught fail-fast. Only the
 * `git worktree add` is deferred.
 *
 * This is the mechanism behind "born-named" worktrees: instead of creating a
 * timestamp-named worktree at startup and later `git worktree move`-ing it
 * (which deletes the live `process.cwd()` out from under in-flight tool
 * calls), the worktree is created exactly once, with its final name, before
 * the first turn runs. No directory is ever moved.
 */
export interface DeferredWorktree {
  /** Absolute repo root, resolved eagerly. */
  repoRoot: string;
  /** The live handle once {@link create} has run, else `undefined`. */
  handle(): WorktreeHandle | undefined;
  /**
   * Create the worktree now. Idempotent: the first call performs the
   * `git worktree add`; subsequent calls return the same handle and ignore
   * their argument. `flagValue` is `true` for a timestamp branch, or an
   * explicit full branch name string.
   */
  create(flagValue: string | true): Promise<WorktreeHandle>;
}

interface ResolvedBaseRef {
  ref: string;
  sha: string;
}

/**
 * Prepare a {@link DeferredWorktree}: validate the repo root, ensure the
 * `.gitignore` entry, and pre-resolve any explicit worktree base up front, but
 * defer the `git worktree add` until the caller knows the branch name. See
 * {@link DeferredWorktree} for the rationale (born-named worktrees, no
 * mid-session `git worktree move`).
 */
export async function setupWorktreeDeferred(
  opts?: { execFile?: ExecFileFn; branchPrefix?: string; baseRef?: string },
): Promise<DeferredWorktree> {
  const execFile: ExecFileFn = opts?.execFile ?? execFileDefault;
  const prefix = resolveBranchPrefix(opts?.branchPrefix);
  const repoRoot = await resolveRepoRoot(execFile);
  await ensureGitignoreEntry(repoRoot);
  // Resolve explicit base refs at setup time so a bad `--worktree-base`,
  // `AFK_WORKTREE_BASE`, or config override fails before the first turn instead
  // of being mistaken for an autoname collision and falling back to the launch
  // checkout without isolation.
  const preResolvedBase = await resolveExplicitBaseRefForSetup(
    repoRoot,
    opts?.baseRef,
    execFile,
  );

  let created: WorktreeHandle | undefined;
  return {
    repoRoot,
    handle: () => created,
    async create(flagValue: string | true): Promise<WorktreeHandle> {
      if (created === undefined) {
        created = await createWorktreeAt(repoRoot, flagValue, {
          execFile,
          prefix,
          preResolvedBase,
        });
      }
      return created;
    },
  };
}

/**
 * Resolve an explicit base-ref override once and return the SHA that should be
 * passed to `git worktree add`. A missing override returns `undefined`, leaving
 * the caller on the best-effort remote-default path.
 */
async function resolveExplicitBaseRefForSetup(
  repoRoot: string,
  baseRefOverride: string | undefined,
  execFile: ExecFileFn,
): Promise<ResolvedBaseRef | undefined> {
  const explicitBaseRef = resolveBaseRef(baseRefOverride);
  if (explicitBaseRef === undefined) return undefined;

  validateBaseRef(explicitBaseRef, 'worktree base ref');
  await fetchIfRemoteRef(repoRoot, explicitBaseRef, execFile);
  return {
    ref: explicitBaseRef,
    sha: await resolveRefToSha(repoRoot, explicitBaseRef, execFile),
  };
}

/**
 * Validate a base ref sourced from untrusted input (CLI flag, env var, or
 * `afk.config.json`). The value is spliced into `git fetch`, `git rev-parse`,
 * and `git worktree add` invocations, so a value starting with `-` could be
 * parsed by git as a flag. execFile (no shell) neutralizes the usual
 * metacharacter classes, so the gate is deliberately minimal: non-empty, no
 * leading dash, no whitespace, no NUL.
 *
 * Exported so the config loader can vet `interactive.worktreeBase` at read
 * time, before the value reaches any git invocation.
 */
export function validateBaseRef(value: string, source: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid worktree base ref from ${source}: '' — base ref cannot be empty.`);
  }
  if (value.startsWith('-')) {
    throw new Error(
      `Invalid worktree base ref from ${source}: '${value}' — must not start with '-' (would be parsed by git as a flag).`,
    );
  }
  if (value.includes('\0')) {
    throw new Error(`Invalid worktree base ref from ${source}: contains a NUL byte.`);
  }
  if (/\s/.test(value)) {
    throw new Error(
      `Invalid worktree base ref from ${source}: '${value}' — must not contain whitespace.`,
    );
  }
}

/**
 * Resolve the active base ref, in priority order:
 *   1. Explicit caller override (`opts.baseRef`, set from `--worktree-base`
 *      or `interactive.worktreeBase`)
 *   2. `AFK_WORKTREE_BASE` env var
 *   3. `undefined` — git uses the repo's current HEAD (the historical default)
 *
 * An empty string from either source is treated as "unset" so it falls
 * through to the HEAD default rather than erroring.
 */
export function resolveBaseRef(override?: string): string | undefined {
  const raw = override ?? env.AFK_WORKTREE_BASE;
  if (raw === undefined || raw.length === 0) return undefined;
  return raw;
}

/**
 * If `ref` names a configured remote's branch (e.g. `origin/main`), fetch it
 * first so the worktree is based on fresh upstream rather than a stale local
 * tracking ref. A local branch with a slash (e.g. `feature/x`) is left alone
 * because its first path segment is not a known remote name.
 *
 * Best-effort: a fetch failure (offline, auth, removed remote) is downgraded
 * to a warning and the existing local copy of the ref is used. A genuinely
 * unresolvable ref then surfaces from {@link resolveRefToSha}.
 */
async function fetchIfRemoteRef(repoRoot: string, ref: string, execFile: ExecFileFn): Promise<void> {
  const slashIdx = ref.indexOf('/');
  if (slashIdx <= 0) return;
  const candidateRemote = ref.slice(0, slashIdx);

  let remotes: string[];
  try {
    const { stdout } = await execFile('git', ['-C', repoRoot, 'remote']);
    remotes = stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  } catch {
    return; // can't enumerate remotes — skip fetch, let rev-parse try the ref as-is
  }
  if (!remotes.includes(candidateRemote)) return; // local ref (e.g. feature/x), not remote/<branch>

  // Peel any revision modifiers (~, ^, @{...}, :path) — `git fetch` wants a
  // branch name, not a full revision expression.
  const branchName = ref.slice(slashIdx + 1).replace(/[~^@:].*$/, '');
  if (branchName.length === 0) return;

  try {
    await execFile('git', ['-C', repoRoot, 'fetch', '--no-tags', candidateRemote, branchName]);
  } catch (err) {
    const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `Worktree base: could not fetch '${candidateRemote}/${branchName}' (${message.trim()}). ` +
        `Using the local copy of '${ref}', which may be stale.`,
    );
  }
}

/**
 * Resolve a ref/revision to a full commit SHA, peeling annotated tags via
 * `^{commit}`. Throws a clear, actionable error when the ref is unknown.
 */
async function resolveRefToSha(repoRoot: string, ref: string, execFile: ExecFileFn): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['-C', repoRoot, 'rev-parse', '--verify', `${ref}^{commit}`]);
    const sha = stdout.trim();
    if (sha.length === 0) throw new Error('empty rev-parse output');
    return sha;
  } catch (err) {
    const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
    throw new Error(
      `Cannot resolve worktree base ref '${ref}': ${message.trim()} — check the ref exists ` +
        `(for a remote branch, make sure the remote is reachable so it can be fetched).`,
    );
  }
}

/**
 * Detect the base ref AFK uses by DEFAULT when no explicit override is given:
 * the primary remote's default branch. Tries `origin/HEAD` first (set by
 * `git clone`, and it already tracks whatever the remote's default is — main,
 * master, trunk, …), then falls back to a conventional `origin/main` /
 * `origin/master` whose tracking ref exists locally. Returns `undefined` when
 * no remote default is discoverable (e.g. a local-only repo with no `origin`),
 * so the caller bases the worktree on the repo's current HEAD instead.
 *
 * All calls are local ref reads — no network. The caller's subsequent fetch is
 * what refreshes the chosen ref from upstream.
 */
async function detectDefaultBaseRef(repoRoot: string, execFile: ExecFileFn): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', [
      '-C', repoRoot, 'symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD',
    ]);
    const ref = stdout.trim();
    if (ref.length > 0) return ref; // e.g. "origin/main"
  } catch { /* origin/HEAD not configured — fall through to conventions */ }

  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      const { stdout } = await execFile('git', [
        '-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`,
      ]);
      if (stdout.trim().length > 0) return candidate;
    } catch { /* candidate's tracking ref doesn't exist locally */ }
  }
  return undefined;
}

/**
 * {@link resolveRefToSha} variant that returns `undefined` instead of throwing
 * when the ref can't be resolved. Used on the DEFAULT (auto-detected) path,
 * where an unresolvable ref should silently fall back to HEAD rather than fail
 * worktree creation — the user didn't explicitly ask for this ref.
 */
async function resolveRefToShaOrUndefined(
  repoRoot: string,
  ref: string,
  execFile: ExecFileFn,
): Promise<string | undefined> {
  try {
    return await resolveRefToSha(repoRoot, ref, execFile);
  } catch {
    return undefined;
  }
}

/**
 * Internal core: create the worktree at an already-resolved `repoRoot`
 * (caller is responsible for `resolveRepoRoot` + `ensureGitignoreEntry`).
 * Shared by {@link setupWorktree} (eager) and {@link setupWorktreeDeferred}
 * (born-named) so both produce byte-identical handles.
 */
async function createWorktreeAt(
  repoRoot: string,
  flagValue: string | true,
  opts: {
    execFile: ExecFileFn;
    prefix: string;
    baseRef?: string;
    preResolvedBase?: ResolvedBaseRef;
  },
): Promise<WorktreeHandle> {
  const { execFile, prefix } = opts;
  const branch = flagValue === true ? generateAutoBranch(prefix) : flagValue;
  validateBranchName(branch);
  const slug = branch.replaceAll('/', '-');
  const worktreePath = join(repoRoot, '.afk-worktrees', slug);

  // Resolve the base ref the new branch is created from:
  //   - An explicit override (--worktree-base / AFK_WORKTREE_BASE /
  //     interactive.worktreeBase) is used as-is and HARD-FAILS if it can't be
  //     resolved — the user asked for that ref specifically. Deferred setup
  //     passes a pre-resolved SHA so first-turn autoname fallback cannot hide
  //     an invalid base ref. Pass `HEAD` to base on the local checkout (opts
  //     out of the remote default below).
  //   - Otherwise AFK defaults to the remote's default branch (origin/main),
  //     fetched fresh, so worktrees start from upstream rather than whatever
  //     stale commit the local checkout happens to be on. This default is
  //     best-effort: when no remote default is discoverable, or it can't be
  //     resolved (offline / never fetched), it SOFT-FALLS-BACK to local HEAD.
  // A remote-tracking ref (origin/<branch>) is fetched before use either way.
  let baseRef: string | undefined;
  let baseSha: string | undefined;
  const explicitBaseRef =
    opts.preResolvedBase ??
    await resolveExplicitBaseRefForSetup(repoRoot, opts.baseRef, execFile);
  if (explicitBaseRef !== undefined) {
    baseSha = explicitBaseRef.sha;
    baseRef = explicitBaseRef.ref;
  } else {
    const detected = await detectDefaultBaseRef(repoRoot, execFile);
    if (detected !== undefined) {
      await fetchIfRemoteRef(repoRoot, detected, execFile);
      const sha = await resolveRefToShaOrUndefined(repoRoot, detected, execFile);
      if (sha !== undefined) {
        baseSha = sha;
        baseRef = detected;
      }
      // sha === undefined → detected ref vanished post-fetch → fall back to HEAD.
    }
    // detected === undefined → no remote default → base off local HEAD.
  }

  const addArgs = ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath];
  if (baseSha !== undefined) addArgs.push(baseSha);
  try {
    await execFile('git', addArgs);
  } catch (err) {
    throw classifyAddError(err, branch, worktreePath);
  }

  // Constraint: cleanup() runs at session shutdown, potentially LONG after
  // the worktree was created. The closure reads `handle.path`/`handle.branch`
  // at invocation time (not construction time) so it remains correct even if
  // a future caller ever mutates the handle; today the worktree is created
  // once with its final name and never moved, so these are effectively stable.
  const handle: WorktreeHandle = {
    path: worktreePath,
    branch,
    cleanup: async (opts?: { force?: boolean }): Promise<void> => {
      // Best-effort: every git invocation below is guarded so a failure during
      // shutdown (e.g. worktree dir manually deleted, transient git lock) cannot
      // surface as an unhandled rejection from `rl.on('close', ...)`.
      const currentPath = handle.path;
      const currentBranch = handle.branch;

      if (opts?.force === true) {
        // Zero-turn session: no work was done, so skip the dirty-state check
        // and remove unconditionally. Log before the git call so the user sees
        // confirmation even if the removal fails.
        // eslint-disable-next-line no-console
        console.log(`Worktree removed (zero turns — no work done): ${currentPath}`);
        try {
          await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', currentPath]);
        } catch (err) {
          const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
          // eslint-disable-next-line no-console
          console.warn(
            `Worktree cleanup: 'git worktree remove --force ${currentPath}' failed (${message}). Manual removal may be needed.`,
          );
          return;
        }
        try {
          await execFile('git', ['-C', repoRoot, 'branch', '-d', currentBranch]);
        } catch (err) {
          const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
          // eslint-disable-next-line no-console
          console.warn(`Could not delete branch '${currentBranch}': ${message}`);
        }
        return;
      }

      let status: { stdout: string; stderr: string };
      try {
        status = await execFile('git', ['-C', currentPath, 'status', '--porcelain']);
      } catch (err) {
        const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `Worktree cleanup: could not check status at ${currentPath} (${message}). Skipping removal — manual cleanup may be needed.`,
        );
        return;
      }

      if (status.stdout.trim().length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `Worktree preserved at ${currentPath} (branch: ${currentBranch}) — uncommitted changes.`,
        );
        // Record the worktree as the parent shell's desired cwd. The
        // optional `afk` shell wrapper (installed via `afk shell-init`)
        // reads this marker after the binary exits and cd's the user
        // into the preserved worktree. Without the wrapper this file
        // is harmless — every subsequent `afk` invocation clears it.
        recordCdIntent(currentPath);
        if (!shellWrapperActive()) {
          // Match the install hint to the user's shell so fish users
          // don't get the bash `eval "$(...)"` form (which fails in
          // fish). Auto-detect falls back to bash if $SHELL is unset.
          const userShell = detectShellFromEnv(env.SHELL);
          const installHint =
            userShell === 'fish'
              ? `afk shell-init fish | source   (add to ~/.config/fish/config.fish)`
              : `eval "$(afk shell-init)"   (add to ~/.zshrc or ~/.bashrc)`;
          // eslint-disable-next-line no-console
          console.log(`  → cd ${currentPath}\n  → Or install one-time:  ${installHint}`);
        }
        return;
      }

      try {
        await execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', currentPath]);
      } catch (err) {
        const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `Worktree cleanup: 'git worktree remove --force ${currentPath}' failed (${message}). Manual removal may be needed.`,
        );
        return;
      }

      try {
        await execFile('git', ['-C', repoRoot, 'branch', '-d', currentBranch]);
      } catch (err) {
        const message = isExecError(err) ? (err.message || err.stderr || '') : String(err);
        // eslint-disable-next-line no-console
        console.warn(`Could not delete branch '${currentBranch}': ${message}`);
      }
    },
  };

  // Write .afk-worktree-meta.json for the sweep engine (best-effort)
  try {
    // When an explicit base ref was used, record its resolved SHA + the ref
    // string the user supplied. Otherwise fall back to the repo's current HEAD
    // (the historical behaviour the sweep engine already understands).
    let metaBaseSha = baseSha ?? '';
    let metaBaseBranch = baseRef ?? '';
    if (baseSha === undefined) {
      try {
        const shaResult = await execFile('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
        metaBaseSha = shaResult.stdout.trim();
      } catch { /* non-fatal */ }
      try {
        const branchResult = await execFile('git', ['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD']);
        metaBaseBranch = branchResult.stdout.trim();
      } catch { /* non-fatal */ }
    }
    // Constraint: PID is the liveness signal the sweep engine uses to
    // accelerate reaping of dead-owner worktrees regardless of age. Recording
    // it here (and only here) means: any worktree created before this field
    // shipped will lack `pid` and fall through to the existing age-gated
    // path — backward compatible. PID reuse is bounded by `createdAt`: the
    // sweep engine refuses to trust `pid` once the meta is older than the
    // configured PID-reuse safety window.
    const meta = {
      owner: 'interactive' as const,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      baseSha: metaBaseSha,
      baseBranch: metaBaseBranch,
    };
    await fs.writeFile(join(worktreePath, '.afk-worktree-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  } catch { /* best-effort — never block worktree creation */ }

  return handle;
}

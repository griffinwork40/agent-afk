/**
 * Thin wrapper around the `git` binary.
 *
 * We shell out via `child_process.execFile` instead of taking a dependency
 * on a JavaScript git implementation — the install/update flow is straight-
 * forward (clone, fetch, list tags, checkout) and pulling in simple-git or
 * nodegit would multiply install size.
 *
 * Every function is injectable via an optional `runner` parameter so tests
 * can substitute a fake without touching the real binary.
 *
 * Security invariant: every git operation that touches the working tree of
 * an untrusted repository — clone, fetch, checkout — is invoked through
 * `withHardening()`, which prepends `-c` flags disabling repo hooks AND
 * filter drivers. These flags suppress arbitrary code execution by the
 * cloned repo before its SKILL.md is ever read. Read-only operations (tag
 * list, rev-parse, symbolic-ref) do not trigger hooks and are not hardened.
 *
 * @module agent/plugins/git
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitRunner {
  (
    args: readonly string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: GitRunner = async (args, cwd, env) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', Array.from(args), {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      throw new Error('git not found on PATH — install git first');
    }
    throw err;
  }
};

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export interface GitOptions {
  runner?: GitRunner;
  /** Environment variables forwarded to the git subprocess. */
  env?: NodeJS.ProcessEnv;
}

export interface CheckoutOptions extends GitOptions {
  /**
   * Pass `git checkout --force`, discarding local modifications to tracked
   * files so the checkout cannot abort on a dirty working tree.
   *
   * Use ONLY for the managed plugin/marketplace cache under
   * `~/.afk/plugins/cache/`, whose working tree is a disposable mirror of a
   * remote ref — never for a user workspace. Without it, a tracked file that
   * drifted in the cache (a partial prior update, a stray edit, a filter that
   * slipped past hardening) wedges every future update with "Your local
   * changes would be overwritten by checkout".
   *
   * `--force` overwrites dirty TRACKED files but leaves UNTRACKED files in
   * place (it is not `clean -fd`), so locally-added content the user has not
   * committed survives the reset.
   */
  force?: boolean;
}

/**
 * `-c` flags prepended to every git invocation that touches working-tree
 * state of an untrusted repo (clone, fetch, checkout).
 *
 * Why not env vars (GIT_CONFIG_COUNT/KEY_0/VALUE_0)? Those require Git ≥ 2.31,
 * which silently no-ops on older releases shipped with Ubuntu 20.04 (2.25),
 * macOS Catalina (2.24), Debian buster (2.20), and CentOS 7 (1.8). Falling
 * back to `-c` (supported since Git 1.7.2, March 2010) gives us deterministic
 * hardening across every supported Git release.
 *
 * What we suppress:
 *   - core.hooksPath=/dev/null    repo hooks (post-checkout, post-merge, etc.)
 *   - filter.process=             long-running filter driver process
 *   - filter.smudge=              checkout-time content transform
 *   - filter.clean=               commit-time content transform
 *
 * The filter.* defang closes a confused-deputy gap: an attacker can ship a
 * `.gitattributes` file that activates an already-installed filter driver
 * (git-lfs, prettier-via-filter, custom build tools) without ever shipping
 * their own filter binary. Setting the filter command to the empty string
 * tells git to skip the filter entirely.
 *
 * Note: this list does NOT include `core.fsmonitor=` because fsmonitor only
 * runs against the user's OWN repos via global config; cloning a hostile repo
 * cannot inject a fsmonitor binary via the repo-level config alone.
 */
const HARDENING_ARGS: readonly string[] = Object.freeze([
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'filter.process=',
  '-c',
  'filter.smudge=',
  '-c',
  'filter.clean=',
]);

/**
 * Prepend the hardening `-c` flags to a git args array.
 *
 * External constraint: `-c <key>=<value>` is a top-level git flag and MUST
 * appear BEFORE the subcommand name (`clone`, `checkout`, …). Hence the
 * spread order: `[...HARDENING_ARGS, ...args]`, never the inverse.
 */
export function withHardening(args: readonly string[]): string[] {
  return [...HARDENING_ARGS, ...args];
}

/**
 * Clone `url` into `dest`. `dest` must not already exist.
 *
 * External constraint: git automatically runs hooks from the cloned repo
 * (post-checkout, post-merge, etc.) during clone/checkout. Without hardening,
 * a malicious plugin can execute code BEFORE its SKILL.md is ever read. We
 * suppress all repo hooks AND filter drivers via `-c` flags (see
 * HARDENING_ARGS).
 */
export async function clone(url: string, dest: string, opts: GitOptions = {}): Promise<void> {
  const runner = opts.runner ?? defaultRunner;
  await runner(withHardening(['clone', '--', url, dest]), undefined, opts.env);
}

/**
 * Run `git fetch --tags --prune` inside `repo`.
 *
 * Hardened: fetch can trigger transfer.fsckObjects callbacks and (with LFS
 * configured) filter-driver invocations. Defense-in-depth — even though we
 * never run `--recurse-submodules`, future maintainers might.
 */
export async function fetch(repo: string, opts: GitOptions = {}): Promise<void> {
  const runner = opts.runner ?? defaultRunner;
  await runner(withHardening(['fetch', '--tags', '--prune']), repo, opts.env);
}

/**
 * List all tags, newest first (by refname semver).
 *
 * Read-only: does not touch working tree, does not run hooks. Not hardened.
 */
export async function listTags(repo: string, opts: GitOptions = {}): Promise<string[]> {
  const runner = opts.runner ?? defaultRunner;
  const { stdout } = await runner(['tag', '--list', '--sort=-v:refname'], repo, opts.env);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Checkout `ref` (tag, branch, or SHA) inside `repo`. Uses `--detach` so we
 * never leave the workspace in a confusing "detached HEAD but tracking a
 * remote branch" state after checking out a tag.
 *
 * Pass `opts.force` to add `--force` for the managed cache — see
 * {@link CheckoutOptions.force}. The ref always stays the final positional
 * argument so callers that inspect the last arg keep working.
 *
 * Hardened: post-checkout hook fires unconditionally on `git checkout`,
 * including `--detach`. This is THE primary RCE vector inside an untrusted
 * cloned repo — previously unprotected before this hardening.
 */
export async function checkout(repo: string, ref: string, opts: CheckoutOptions = {}): Promise<void> {
  const runner = opts.runner ?? defaultRunner;
  const args = ['checkout', '--detach'];
  if (opts.force) args.push('--force');
  args.push(ref);
  await runner(withHardening(args), repo, opts.env);
}

/**
 * Get the commit SHA currently pointed at by HEAD.
 *
 * Read-only: does not touch working tree, does not run hooks. Not hardened.
 */
export async function getCommitSha(repo: string, opts: GitOptions = {}): Promise<string> {
  const runner = opts.runner ?? defaultRunner;
  const { stdout } = await runner(['rev-parse', 'HEAD'], repo, opts.env);
  return stdout.trim();
}

/**
 * Resolve `rev` to its commit SHA, or `null` when it does not resolve.
 *
 * Used by the updaters to (a) tell a mutable branch ref apart from an
 * immutable tag/SHA — `refs/remotes/origin/<branch>` resolves only for a
 * remote-tracking branch — and (b) read the fetched tip of that branch. We
 * pass `--verify --quiet` so an unknown ref exits non-zero with no output
 * instead of printing a partial result; the throw is caught and mapped to
 * `null`.
 *
 * Read-only: does not touch working tree, does not run hooks. Not hardened.
 */
export async function tryRevParse(
  repo: string,
  rev: string,
  opts: GitOptions = {},
): Promise<string | null> {
  const runner = opts.runner ?? defaultRunner;
  try {
    const { stdout } = await runner(['rev-parse', '--verify', '--quiet', rev], repo, opts.env);
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the default branch on the remote `origin`. Falls back to `main`.
 *
 * Read-only: does not touch working tree, does not run hooks. Not hardened.
 */
export async function getDefaultBranch(repo: string, opts: GitOptions = {}): Promise<string> {
  const runner = opts.runner ?? defaultRunner;
  try {
    const { stdout } = await runner(
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      repo,
      opts.env,
    );
    // Output looks like `origin/main`.
    const trimmed = stdout.trim();
    return trimmed.replace(/^origin\//, '') || 'main';
  } catch {
    return 'main';
  }
}

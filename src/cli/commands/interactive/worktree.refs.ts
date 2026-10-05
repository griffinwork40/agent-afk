/**
 * Git ref resolution helpers for the worktree subsystem.
 *
 * Extracted from worktree.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `fetchIfRemoteRef`, `resolveRefToSha`, `resolveRefToShaOrUndefined`,
 *          `detectDefaultBaseRef`.
 */

import type { ExecFileFn } from './worktree.js';
import { isExecError } from './worktree.errors.js';

// ---------------------------------------------------------------------------
// Remote fetch
// ---------------------------------------------------------------------------

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
export async function fetchIfRemoteRef(repoRoot: string, ref: string, execFile: ExecFileFn): Promise<void> {
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

// ---------------------------------------------------------------------------
// SHA resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a ref/revision to a full commit SHA, peeling annotated tags via
 * `^{commit}`. Throws a clear, actionable error when the ref is unknown.
 */
export async function resolveRefToSha(repoRoot: string, ref: string, execFile: ExecFileFn): Promise<string> {
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
 * {@link resolveRefToSha} variant that returns `undefined` instead of throwing
 * when the ref can't be resolved. Used on the DEFAULT (auto-detected) path,
 * where an unresolvable ref should silently fall back to HEAD rather than fail
 * worktree creation — the user didn't explicitly ask for this ref.
 */
export async function resolveRefToShaOrUndefined(
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

// ---------------------------------------------------------------------------
// Default base-ref detection
// ---------------------------------------------------------------------------

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
export async function detectDefaultBaseRef(repoRoot: string, execFile: ExecFileFn): Promise<string | undefined> {
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

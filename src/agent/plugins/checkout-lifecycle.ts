/**
 * Shared git checkout lifecycle helpers used by both the plugin installer /
 * updater and the marketplace installer / updater.
 *
 * This module owns the byte-identical primitives that previously lived in
 * both `src/agent/plugins/install.ts` and `src/agent/marketplaces/install.ts`
 * (and their update counterparts).  Each caller keeps its own manifest
 * interpretation, index writes, confirmation UX, and catalog reconciliation.
 *
 * Exported surface
 * ─────────────────
 *   isLink          — lstat-based symlink probe (no-throw)
 *   removeDest      — rm -rf / unlink depending on whether the path is a link
 *   defaultGitName  — derive a human-friendly dir name from a git/github ParsedSource
 *   hasNonDefaultRef — true when `ref` differs from the remote default branch
 *
 *   advanceCachedCheckout — resolve which ref to check out (latest semver tag
 *     / stored pin / default branch / caller-supplied override), compare against
 *     local HEAD, and execute the checkout when needed.  Returns structured
 *     facts the caller uses to build its index entry.
 *
 * @module agent/plugins/checkout-lifecycle
 */

import { lstatSync, rmSync, unlinkSync } from 'fs';
import { basename } from 'path';
import type { ParsedSource } from './source.js';
import * as git from './git.js';
import { pickLatestSemverTag } from './versions.js';

// ── Filesystem primitives ────────────────────────────────────────────────────

/** Return true when `path` is a symbolic link (no-throw). */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Remove a destination path.
 * - Symbolic links are removed with `unlinkSync` (preserves the target).
 * - Directories and regular files are removed recursively with `rmSync`.
 */
export function removeDest(dest: string): void {
  if (isLink(dest)) {
    unlinkSync(dest);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
}

// ── Name derivation ──────────────────────────────────────────────────────────

/**
 * Derive a human-friendly directory name from a git/github ParsedSource.
 *
 * - `github` sources use the repository name directly.
 * - Raw `git` sources strip the trailing `.git` and take the last path
 *   segment (last `/` or `:` wins to handle SCP-style `git@host:org/repo`).
 */
export function defaultGitName(
  parsed: Extract<ParsedSource, { type: 'git' | 'github' }>,
): string {
  if (parsed.type === 'github') return parsed.repo;
  const cleaned = parsed.url.replace(/\.git$/, '');
  const lastSlash = cleaned.lastIndexOf('/');
  const lastColon = cleaned.lastIndexOf(':');
  const idx = Math.max(lastSlash, lastColon);
  return idx >= 0 ? cleaned.slice(idx + 1) : basename(cleaned);
}

// ── Ref helpers ──────────────────────────────────────────────────────────────

/**
 * Return true when `ref` differs from the remote default branch.
 *
 * Used during install to decide whether an explicit checkout is needed: when
 * the resolved ref IS the default branch, `git clone` already left the working
 * tree there, so a redundant `git checkout` can be skipped.
 */
export async function hasNonDefaultRef(
  dest: string,
  ref: string,
  gitOpts: git.GitOptions,
): Promise<boolean> {
  const current = await git.getDefaultBranch(dest, gitOpts);
  return ref !== current;
}

// ── Checkout lifecycle ────────────────────────────────────────────────────────

/**
 * Facts returned by `advanceCachedCheckout` — everything the caller needs to
 * write its index entry and report the outcome.
 */
export interface CheckoutResult {
  /** The resolved ref name (tag / branch / SHA). */
  targetRef: string;
  /** The commit SHA after checkout. */
  commit: string;
  /**
   * True when the checkout advanced — caller should write an updated index
   * entry and report "updated" status.  False means "up-to-date" or "no-op".
   */
  changed: boolean;
  /**
   * True only when the updater itself picked `targetRef` as the latest semver
   * tag (immutable).  A caller-supplied explicit ref, a stored entry.ref, or
   * the default branch could each be a branch name, so they must keep following
   * the remote-tracking branch.
   */
  pickedSemverTag: boolean;
  /**
   * The ref that is actually checked out: the full `refs/remotes/origin/<name>`
   * for branch tracking, `refs/tags/<name>` for semver tags, or `targetRef` for
   * explicit SHAs / caller-supplied pins.
   */
  checkoutRef: string;
}

/**
 * Options for `advanceCachedCheckout`.  Mirrors the stored index entry fields
 * the updaters already read.
 */
export interface AdvanceCachedCheckoutOptions {
  /** Caller-supplied ref override (`--ref` flag). */
  explicitRef?: string;
  /**
   * The ref recorded in the index entry.  Used as the target when the entry is
   * user-pinned (neither the default branch nor a semver tag).
   */
  storedRef: string | null | undefined;
  /**
   * Whether the stored ref was explicitly pinned by the user.  When true and
   * `storedRef` is a branch name, the branch is followed via origin/<name>
   * rather than re-running the semver-tag picker.
   */
  pinnedRef: boolean | undefined;
  /**
   * Callback that implements the "is this ref pinned?" heuristic, because the
   * rule differs between plugins (`isPinnedRef`) and marketplaces
   * (`isMarketplacePinnedRef`).  Receives (entry, defaultBranch); returns true
   * when the stored ref should be treated as a user pin.
   */
  isPinned: (defaultBranch: string) => boolean;
}

/**
 * Resolve which ref to check out, compare against local HEAD, and execute the
 * checkout when the working tree is stale.
 *
 * This is the byte-identical tail shared between `plugins/update.ts` and
 * `marketplaces/update.ts` — ref-resolution provenance, remote-ref comparison,
 * branch-vs-tag discrimination, dirty-file warning, and the forced checkout.
 *
 * Warn before discarding tracked edits (matches marketplace behaviour).
 * `git.trackedChanges` returns [] on error so a probe failure never blocks.
 *
 * @param dir   Absolute path to the cloned repo (plugin or marketplace cache).
 * @param opts  Caller-supplied options (see above).
 * @param gitOpts  Injectable git runner (for tests).
 * @param label A human-readable label used in the warn message ("plugin" or "marketplace").
 * @param name  The plugin/marketplace name used in the warn message.
 */
export async function advanceCachedCheckout(
  dir: string,
  opts: AdvanceCachedCheckoutOptions,
  gitOpts: git.GitOptions,
  label: string,
  name: string,
): Promise<CheckoutResult> {
  const defaultBranch = await git.getDefaultBranch(dir, gitOpts);

  let targetRef: string;
  // `pickedSemverTag` records PROVENANCE: true only when the updater itself
  // selected `targetRef` as the latest semver tag — the one case where the
  // target is known-immutable. An explicit pin, a tracked entry.ref, or the
  // default branch could each be a branch, so they must keep following the
  // remote-tracking branch.
  let pickedSemverTag = false;

  if (opts.explicitRef) {
    // Caller explicitly re-pins — honour the new ref and mark it pinned.
    targetRef = opts.explicitRef;
  } else if (opts.isPinned(defaultBranch) && opts.storedRef) {
    // Stored ref was user-pinned: advance a branch pin to the remote tip;
    // a SHA/tag pin stays put (isBranch will be false → up-to-date or tag).
    targetRef = opts.storedRef;
  } else {
    // Auto-picked: run the semver-tag picker as before.
    const tags = await git.listTags(dir, gitOpts);
    const latest = pickLatestSemverTag(tags);
    if (latest !== null) {
      targetRef = latest;
      pickedSemverTag = true;
    } else {
      targetRef = opts.storedRef ?? defaultBranch;
    }
  }

  // Invariant: a tag/SHA is immutable, so ref-name equality means nothing
  // moved. A branch is mutable — `git fetch` advanced
  // refs/remotes/origin/<branch> but left local HEAD untouched — so we must
  // compare commits and check out the fetched remote tip. Checking out the
  // bare branch name would `--detach` at the STALE local branch (git.checkout
  // always passes --detach), re-freezing the install.
  //
  // Tag vs branch is decided by SELECTION PROVENANCE, not by which refs exist:
  // git permits refs/tags/<x> and refs/heads/<x> to coexist, so a name alone
  // is ambiguous. Only a target the updater picked as the latest semver tag is
  // known-immutable — it wins and is checked out via its explicit refs/tags/
  // ref (never the bare name, which is ambiguous when both exist). Every other
  // target (explicit pin, tracked entry.ref, default branch) keeps following
  // the remote-tracking branch, so a branch-tracked install still advances even
  // when a same-named tag exists.
  const remoteRef = `refs/remotes/origin/${targetRef}`;
  const remoteSha = pickedSemverTag ? null : await git.tryRevParse(dir, remoteRef, gitOpts);
  const isBranch = remoteSha !== null;
  const localSha = await git.getCommitSha(dir, gitOpts);
  const upToDate = isBranch ? remoteSha === localSha : targetRef === opts.storedRef;

  if (upToDate) {
    return {
      targetRef,
      commit: localSha,
      changed: false,
      pickedSemverTag,
      checkoutRef: isBranch ? remoteRef : pickedSemverTag ? `refs/tags/${targetRef}` : targetRef,
    };
  }

  // Warn before the force so the user knows which local edits will be reset.
  // `trackedChanges` returns [] on error, so a probe failure never blocks the
  // checkout. Untracked files are excluded — they survive --force intact.
  const dirty = await git.trackedChanges(dir, gitOpts);
  if (dirty.length > 0) {
    console.warn(
      `[${label}] updating "${name}": the following locally-edited tracked file(s) will be reset to the upstream version:\n` +
        dirty.map((f) => `  ${f}`).join('\n'),
    );
  }

  const checkoutRef = isBranch
    ? remoteRef
    : pickedSemverTag
      ? `refs/tags/${targetRef}`
      : targetRef;

  await git.checkout(dir, checkoutRef, { ...gitOpts, force: true });
  const commit = await git.getCommitSha(dir, gitOpts);

  return { targetRef, commit, changed: true, pickedSemverTag, checkoutRef };
}

/**
 * Perform a ref-resolution and (optionally) checkout during a fresh `git
 * clone` — i.e., the INSTALL path, not the update path.
 *
 * Returns the resolved ref name and the commit SHA recorded after any
 * checkout.  The caller is responsible for everything else (rename, index
 * upsert, etc.).
 *
 * @param dest   Absolute path to the cloned repo.
 * @param explicitRef  Caller-supplied `--ref` override, or undefined for auto-pick.
 * @param gitOpts      Injectable git runner.
 */
export async function prepareCachedCheckout(
  dest: string,
  explicitRef: string | undefined,
  gitOpts: git.GitOptions,
): Promise<{ ref: string; commit: string }> {
  let ref: string;
  if (explicitRef) {
    ref = explicitRef;
  } else {
    const tags = await git.listTags(dest, gitOpts);
    const latest = pickLatestSemverTag(tags);
    ref = latest ?? (await git.getDefaultBranch(dest, gitOpts));
  }

  if (explicitRef || (await hasNonDefaultRef(dest, ref, gitOpts))) {
    await git.checkout(dest, ref, gitOpts);
  }

  const commit = await git.getCommitSha(dest, gitOpts);
  return { ref, commit };
}

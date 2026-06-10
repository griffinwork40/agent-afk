/**
 * Plugin updater.
 *
 * For git-sourced plugins: fetch tags, re-run the latest-semver picker, and
 * only checkout if the new ref differs from the one in the index. For local
 * (symlinked) plugins: no-op with a clear message, since the symlink target
 * IS the source of truth.
 *
 * @module agent/plugins/update
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getPluginsDir, getPluginsIndexPath } from '../../paths.js';
import * as git from './git.js';
import {
  readIndex,
  upsertPlugin,
  type PluginIndex,
  type PluginIndexEntry,
} from './index-store.js';
import { pickLatestSemverTag } from './versions.js';
import { readPluginManifest } from './plugin-manifest.js';
// Invalidate the process-lifetime scan cache after any update attempt so
// the running session sees freshly-pulled SKILL.md files (or edits to a
// symlink target for local plugins) without a restart. (F2)
import { _resetPluginScanCache } from '../plugins-scanner.js';

export interface UpdateOptions {
  /** Pin to an explicit ref instead of picking the latest tag. */
  ref?: string;
}

export interface UpdateDeps {
  pluginsDir?: string;
  indexPath?: string;
  gitRunner?: git.GitRunner;
  now?: () => Date;
}

export type UpdateOutcome =
  | {
      name: string;
      status: 'updated';
      fromRef: string | null;
      toRef: string;
      commit: string;
      /** Manifest `version` after checkout, when the plugin.json carries one. */
      version: string | null;
    }
  | { name: string; status: 'up-to-date'; ref: string; commit: string; version: string | null }
  | { name: string; status: 'skipped-local' }
  | { name: string; status: 'missing-dir'; dir: string };

export async function updatePlugin(
  name: string,
  options: UpdateOptions = {},
  deps: UpdateDeps = {},
): Promise<UpdateOutcome> {
  const pluginsDir = deps.pluginsDir ?? getPluginsDir();
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const now = deps.now ?? (() => new Date());
  const gitOpts = deps.gitRunner ? { runner: deps.gitRunner } : {};

  const index = readIndex(indexPath);
  const entry = index.plugins[name];
  if (!entry) throw new Error(`plugin "${name}" is not installed`);

  const dir = join(pluginsDir, name);
  if (!existsSync(dir)) {
    return { name, status: 'missing-dir', dir };
  }

  // Invariant: any update attempt against a present plugin dir must refresh
  // the scan cache, even on the up-to-date or skipped-local fast paths —
  // the symlink target or working tree may have changed since the cache was
  // populated. Cheap re-scan beats stale discovery. (F2)
  _resetPluginScanCache();

  if (entry.sourceType === 'local') {
    return { name, status: 'skipped-local' };
  }

  await git.fetch(dir, gitOpts);
  let targetRef: string;
  // `pickedSemverTag` records PROVENANCE: true only when the updater itself
  // selected `targetRef` as the latest semver tag — the one case where the
  // target is known-immutable. An explicit pin, a tracked `entry.ref`, or the
  // default branch could each be a branch, so they must keep following the
  // remote-tracking branch.
  let pickedSemverTag = false;
  if (options.ref) {
    targetRef = options.ref;
  } else {
    const tags = await git.listTags(dir, gitOpts);
    const latest = pickLatestSemverTag(tags);
    if (latest !== null) {
      targetRef = latest;
      pickedSemverTag = true;
    } else {
      targetRef = entry.ref ?? (await git.getDefaultBranch(dir, gitOpts));
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
  const upToDate = isBranch ? remoteSha === localSha : targetRef === entry.ref;

  if (upToDate) {
    return {
      name,
      status: 'up-to-date',
      ref: targetRef,
      commit: localSha,
      version: readPluginManifest(dir).version,
    };
  }

  // force: the cache under ~/.afk/plugins/cache/ is a disposable mirror of the
  // remote, not a user workspace. Discard any tracked-file drift so a dirty
  // cache (partial prior update, stray edit) can't wedge the checkout. Untracked
  // files survive --force, so locally-added content is preserved.
  await git.checkout(dir, isBranch ? remoteRef : pickedSemverTag ? `refs/tags/${targetRef}` : targetRef, { ...gitOpts, force: true });
  const commit = await git.getCommitSha(dir, gitOpts);
  const version = readPluginManifest(dir).version;
  const ts = now().toISOString();
  const updated: PluginIndexEntry = {
    ...entry,
    ref: targetRef,
    commit,
    updatedAt: ts,
  };
  upsertPlugin(name, updated, indexPath);
  return { name, status: 'updated', fromRef: entry.ref, toRef: targetRef, commit, version };
}

export async function updateAll(
  deps: UpdateDeps = {},
): Promise<UpdateOutcome[]> {
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const idx: PluginIndex = readIndex(indexPath);
  const results: UpdateOutcome[] = [];
  for (const name of Object.keys(idx.plugins)) {
    try {
      results.push(await updatePlugin(name, {}, deps));
    } catch (err) {
      // Convert thrown errors to a structured outcome so callers can report
      // every plugin, not just up to the first failure.
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, status: 'missing-dir', dir: msg });
    }
  }
  return results;
}

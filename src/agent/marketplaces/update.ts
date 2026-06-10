/**
 * Marketplace updater.
 *
 * For git-sourced marketplaces: fetch tags, pick the latest semver (or use a
 * caller-supplied ref), checkout if it differs from the recorded ref, then
 * report which plugins were added or removed compared to the previous
 * manifest. For local (symlinked) marketplaces: no-op — the symlink target
 * IS the source of truth.
 *
 * @module agent/marketplaces/update
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getMarketplaceDir, getPluginsIndexPath } from '../../paths.js';
import * as git from '../plugins/git.js';
import {
  readIndex,
  upsertMarketplace,
  type MarketplaceIndexEntry,
  type PluginIndex,
} from '../plugins/index-store.js';
import { pickLatestSemverTag } from '../plugins/versions.js';
import { readPluginManifest } from '../plugins/plugin-manifest.js';
import {
  readManifest,
  tryReadManifest,
  type MarketplaceManifest,
} from './manifest.js';
import { isLocalPluginSource, resolvePluginSourceDir } from './resolve.js';

export interface UpdateMarketplaceOptions {
  ref?: string;
}

export interface UpdateMarketplaceDeps {
  cacheDir?: string;
  indexPath?: string;
  gitRunner?: git.GitRunner;
  now?: () => Date;
}

/** Post-update version of one plugin listed in the marketplace catalog. */
export interface MarketplacePluginVersion {
  name: string;
  /** Manifest `version`, or `null` for non-local sources / missing plugin.json. */
  version: string | null;
}

export type UpdateMarketplaceOutcome =
  | {
      name: string;
      status: 'updated';
      fromRef: string | null;
      toRef: string;
      commit: string;
      addedPlugins: string[];
      removedPlugins: string[];
      /** Each catalog plugin's `plugin.json` version after the update. */
      pluginVersions: MarketplacePluginVersion[];
    }
  | { name: string; status: 'up-to-date'; ref: string; commit: string }
  | { name: string; status: 'skipped-local' }
  | { name: string; status: 'missing-dir'; dir: string };

export async function updateMarketplace(
  name: string,
  options: UpdateMarketplaceOptions = {},
  deps: UpdateMarketplaceDeps = {},
): Promise<UpdateMarketplaceOutcome> {
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const now = deps.now ?? (() => new Date());
  const gitOpts = deps.gitRunner ? { runner: deps.gitRunner } : {};

  const index = readIndex(indexPath);
  const entry = index.marketplaces[name];
  if (!entry) throw new Error(`marketplace "${name}" is not installed`);

  const dir = deps.cacheDir ? join(deps.cacheDir, name) : getMarketplaceDir(name);
  if (!existsSync(dir)) {
    return { name, status: 'missing-dir', dir };
  }

  if (entry.sourceType === 'local') {
    return { name, status: 'skipped-local' };
  }

  const beforePlugins = new Set(
    (tryReadManifest(dir)?.plugins ?? []).map((p) => p.name),
  );

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
  // always passes --detach), re-freezing the marketplace.
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
    return { name, status: 'up-to-date', ref: targetRef, commit: localSha };
  }

  // force: the cache under ~/.afk/plugins/cache/ is a disposable mirror of the
  // remote, not a user workspace. Discard any tracked-file drift so a dirty
  // cache (partial prior update, stray edit) can't wedge the checkout. Untracked
  // files survive --force, so locally-added content is preserved.
  await git.checkout(dir, isBranch ? remoteRef : pickedSemverTag ? `refs/tags/${targetRef}` : targetRef, { ...gitOpts, force: true });
  const commit = await git.getCommitSha(dir, gitOpts);
  const ts = now().toISOString();
  const updated: MarketplaceIndexEntry = {
    ...entry,
    ref: targetRef,
    commit,
    updatedAt: ts,
  };
  upsertMarketplace(name, updated, indexPath);

  const afterManifest = readManifest(dir);
  const afterPlugins = new Set(afterManifest.plugins.map((p) => p.name));
  const addedPlugins = [...afterPlugins].filter((p) => !beforePlugins.has(p));
  const removedPlugins = [...beforePlugins].filter((p) => !afterPlugins.has(p));

  return {
    name,
    status: 'updated',
    fromRef: entry.ref,
    toRef: targetRef,
    commit,
    addedPlugins,
    removedPlugins,
    pluginVersions: resolvePluginVersions(dir, afterManifest),
  };
}

/**
 * Read each catalog plugin's `plugin.json` version after an update. Only
 * local (relative/absolute path) sources resolve to an on-disk plugin dir;
 * git-URL / `owner/repo` sources have no version until separately installed,
 * so they report `null`.
 */
function resolvePluginVersions(
  marketplaceDir: string,
  manifest: MarketplaceManifest,
): MarketplacePluginVersion[] {
  return manifest.plugins.map((p) => {
    const version = isLocalPluginSource(p.source)
      ? readPluginManifest(resolvePluginSourceDir(marketplaceDir, p.source)).version
      : null;
    return { name: p.name, version };
  });
}

export async function updateAllMarketplaces(
  deps: UpdateMarketplaceDeps = {},
): Promise<UpdateMarketplaceOutcome[]> {
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const idx: PluginIndex = readIndex(indexPath);
  const results: UpdateMarketplaceOutcome[] = [];
  for (const name of Object.keys(idx.marketplaces)) {
    try {
      results.push(await updateMarketplace(name, {}, deps));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, status: 'missing-dir', dir: msg });
    }
  }
  return results;
}


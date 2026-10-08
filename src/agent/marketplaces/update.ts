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
  isMarketplacePinnedRef,
  type MarketplaceIndexEntry,
  type PluginIndex,
} from '../plugins/index-store.js';
import { readPluginManifest } from '../plugins/plugin-manifest.js';
import { advanceCachedCheckout } from '../plugins/checkout-lifecycle.js';
import {
  readManifest,
  tryReadManifest,
  type MarketplaceManifest,
} from './manifest.js';
import { isLocalPluginSource, resolvePluginSourceDir } from './resolve.js';
import { errorMessage } from '../../utils/errors.js';

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

  const result = await advanceCachedCheckout(
    dir,
    {
      explicitRef: options.ref,
      storedRef: entry.ref,
      pinnedRef: entry.pinnedRef,
      isPinned: (defaultBranch) => isMarketplacePinnedRef(entry, defaultBranch),
    },
    gitOpts,
    'marketplace',
    name,
  );

  if (!result.changed) {
    if (options.ref !== undefined) {
      upsertMarketplace(name, { ...entry, ref: result.targetRef, commit: result.commit, pinnedRef: true, updatedAt: now().toISOString() }, indexPath);
    }
    return { name, status: 'up-to-date', ref: result.targetRef, commit: result.commit };
  }

  const ts = now().toISOString();
  const updated: MarketplaceIndexEntry = {
    ...entry,
    ref: result.targetRef,
    commit: result.commit,
    updatedAt: ts,
    ...(options.ref !== undefined ? { pinnedRef: true } : {}),
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
    toRef: result.targetRef,
    commit: result.commit,
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
      const msg = errorMessage(err);
      results.push({ name, status: 'missing-dir', dir: msg });
    }
  }
  return results;
}


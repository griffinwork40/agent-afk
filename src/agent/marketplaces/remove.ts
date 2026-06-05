/**
 * Marketplace removal.
 *
 * Deletes the marketplace dir (or symlink) under
 * `~/.afk/plugins/cache/<name>/` and prunes the index entry. Cascades:
 * `<marketplace>:<plugin>` index entries are dropped (they pointed at
 * directories inside the now-removed cache), and any flat plugin entries
 * tagged with `marketplace: name` are also removed — those plugins were
 * installed via the marketplace shorthand and tracked through it.
 *
 * Idempotent — calling twice is a no-op on the second call.
 *
 * @module agent/marketplaces/remove
 */

import { existsSync, lstatSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getMarketplaceCacheDir, getPluginsIndexPath } from '../../paths.js';
import { readIndex, removeMarketplace as removeMarketplaceFromIndex } from '../plugins/index-store.js';

export interface RemoveMarketplaceOptions {
  cacheDir?: string;
  indexPath?: string;
}

export interface RemoveMarketplaceResult {
  name: string;
  removedDir: boolean;
  removedIndexEntry: boolean;
  /** Plugin index keys that were cascaded out. */
  removedPluginEntries: string[];
}

export function removeMarketplace(
  name: string,
  opts: RemoveMarketplaceOptions = {},
): RemoveMarketplaceResult {
  const cacheDir = opts.cacheDir ?? getMarketplaceCacheDir();
  const indexPath = opts.indexPath ?? getPluginsIndexPath();

  const dir = join(cacheDir, name);
  let removedDir = false;
  if (isSymlink(dir)) {
    unlinkSync(dir);
    removedDir = true;
  } else if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removedDir = true;
  }

  const before = readIndex(indexPath);
  const hadEntry = Object.prototype.hasOwnProperty.call(before.marketplaces, name);
  const cascaded = Object.entries(before.plugins)
    .filter(([, entry]) => entry.marketplace === name)
    .map(([key]) => key);

  if (hadEntry || cascaded.length > 0) {
    removeMarketplaceFromIndex(name, indexPath);
  }

  return {
    name,
    removedDir,
    removedIndexEntry: hadEntry,
    removedPluginEntries: cascaded,
  };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

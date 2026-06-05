/**
 * Plugin removal.
 *
 * Walks the plugins dir + index entry for `name`, deletes the dir (or the
 * symlink) if present, then prunes the index entry. Idempotent — calling
 * twice is a no-op on the second call.
 *
 * @module agent/plugins/remove
 */

import { existsSync, lstatSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPluginsDir, getPluginsIndexPath } from '../../paths.js';
import { readIndex, removePlugin as removeIndexEntry } from './index-store.js';
// Path-traversal guard reused from the installer. (Audit S8)
import { assertSafePluginName } from './install.js';
// Invalidate the process-lifetime scan cache after removal so the running
// session stops serving the deleted plugin. (Audit F2)
import { _resetPluginScanCache } from '../plugins-scanner.js';

export interface RemoveOptions {
  pluginsDir?: string;
  indexPath?: string;
}

export interface RemoveResult {
  name: string;
  removedDir: boolean;
  removedIndexEntry: boolean;
}

export function removePlugin(name: string, opts: RemoveOptions = {}): RemoveResult {
  // Guard against path traversal via a malformed index entry. (Audit S8)
  // Constraint: assertSafePluginName must run before any FS operation so a
  // crafted name such as "../../../home" never reaches join(pluginsDir, name).
  assertSafePluginName(name);

  const pluginsDir = opts.pluginsDir ?? getPluginsDir();
  const indexPath = opts.indexPath ?? getPluginsIndexPath();

  const dir = join(pluginsDir, name);
  let removedDir = false;
  if (isSymlink(dir)) {
    unlinkSync(dir);
    removedDir = true;
  } else if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removedDir = true;
  }

  const index = readIndex(indexPath);
  const hadEntry = Object.prototype.hasOwnProperty.call(index.plugins, name);
  if (hadEntry) {
    removeIndexEntry(name, indexPath);
  }

  // Invalidate scan cache so the running session stops serving the removed
  // plugin immediately. Called unconditionally — a no-op removal (ghost plugin)
  // still leaves the cache in a consistent state. (Audit F2)
  _resetPluginScanCache();

  return { name, removedDir, removedIndexEntry: hadEntry };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

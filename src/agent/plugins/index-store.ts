/**
 * Plugin index persistence.
 *
 * The AFK plugin CLI writes a single `.index.json` under the user-scope
 * plugins directory. The scanner consults it to skip disabled plugins,
 * `plugin list` reads it to render status, and `install`/`update`/`remove`
 * mutate it. All writes are atomic (temp + rename) to avoid leaving a half-
 * written file if the process dies mid-save.
 *
 * Schema versions:
 *   - v1 — `{ version: 1, plugins: {...} }`. Plugin keys are directory names.
 *   - v2 — `{ version: 2, plugins: {...}, marketplaces: {...} }`. Plugin keys
 *          may also be `<marketplace>:<plugin>` for plugins resolved through
 *          a marketplace catalog. v1 files auto-promote to v2 on read.
 *
 * @module agent/plugins/index-store
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { getPluginsIndexPath } from '../../paths.js';

export type SourceType = 'git' | 'github' | 'local' | 'marketplace';

export interface PluginIndexEntry {
  /** Original user-supplied source string (git URL, `owner/repo`, local path, or `<mp>:<plugin>`). */
  source: string;
  /** How the source was classified at install time. */
  sourceType: SourceType;
  /** The ref (tag/branch/SHA) currently checked out. `null` for local/marketplace plugins. */
  ref: string | null;
  /** The commit SHA currently checked out. `null` for local/marketplace plugins. */
  commit: string | null;
  /** Whether the scanner should include this plugin. */
  enabled: boolean;
  /** ISO timestamp of first install. */
  installedAt: string;
  /** ISO timestamp of most recent install/update. */
  updatedAt: string;
  /** Manifest `name` from `.claude-plugin/plugin.json`, if different from dir name. */
  manifestName?: string;
  /** For `sourceType: 'marketplace'`, the marketplace this plugin came from. */
  marketplace?: string;
}

export interface MarketplaceIndexEntry {
  /** Original user-supplied source string (git URL, `owner/repo`, or local path). */
  source: string;
  /** How the source was classified at install time. */
  sourceType: 'git' | 'github' | 'local';
  /** The ref (tag/branch/SHA) currently checked out. `null` for local marketplaces. */
  ref: string | null;
  /** The commit SHA currently checked out. `null` for local marketplaces. */
  commit: string | null;
  /** ISO timestamp of first install. */
  installedAt: string;
  /** ISO timestamp of most recent install/update. */
  updatedAt: string;
}

export interface PluginIndex {
  version: 2;
  plugins: Record<string, PluginIndexEntry>;
  marketplaces: Record<string, MarketplaceIndexEntry>;
}

/**
 * Read the index at `path`. Missing or unreadable files return an empty
 * index — callers should treat missing-file as the empty case because the
 * scanner must continue to work when no one has ever installed a plugin.
 *
 * v1 files are auto-promoted to v2 in memory (an empty `marketplaces` map is
 * added). The promotion is not persisted until something writes the index.
 */
export function readIndex(path: string = getPluginsIndexPath()): PluginIndex {
  if (!existsSync(path)) return cloneEmpty();
  try {
    const text = readFileSync(path, 'utf8');
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object') return cloneEmpty();
    const obj = raw as { version?: unknown; plugins?: unknown; marketplaces?: unknown };

    const plugins =
      obj.plugins && typeof obj.plugins === 'object'
        ? (obj.plugins as Record<string, PluginIndexEntry>)
        : {};

    if (obj.version === 1) {
      // Auto-promote v1 → v2 in memory.
      return { version: 2, plugins, marketplaces: {} };
    }

    if (obj.version === 2) {
      const marketplaces =
        obj.marketplaces && typeof obj.marketplaces === 'object'
          ? (obj.marketplaces as Record<string, MarketplaceIndexEntry>)
          : {};
      return { version: 2, plugins, marketplaces };
    }

    // Unknown / future version — fall back to empty.
    return cloneEmpty();
  } catch {
    return cloneEmpty();
  }
}

/**
 * Atomically write `index` to `path`. Creates parent dirs if needed.
 */
export function writeIndex(index: PluginIndex, path: string = getPluginsIndexPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.index.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const payload = JSON.stringify(index, null, 2);
  try {
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * Insert or overwrite a plugin entry by `name`.
 */
export function upsertPlugin(
  name: string,
  entry: PluginIndexEntry,
  path: string = getPluginsIndexPath(),
): PluginIndex {
  const index = readIndex(path);
  index.plugins[name] = entry;
  writeIndex(index, path);
  return index;
}

/**
 * Remove a plugin entry by `name`. No-op if absent.
 */
export function removePlugin(name: string, path: string = getPluginsIndexPath()): PluginIndex {
  const index = readIndex(path);
  if (name in index.plugins) {
    delete index.plugins[name];
    writeIndex(index, path);
  }
  return index;
}

/**
 * Flip `enabled` on a plugin. Throws if the plugin is not in the index.
 */
export function setEnabled(
  name: string,
  enabled: boolean,
  path: string = getPluginsIndexPath(),
): PluginIndex {
  const index = readIndex(path);
  const entry = index.plugins[name];
  if (!entry) {
    throw new Error(`plugin "${name}" is not in the index`);
  }
  entry.enabled = enabled;
  entry.updatedAt = new Date().toISOString();
  writeIndex(index, path);
  return index;
}

/**
 * Insert or overwrite a marketplace entry by `name`.
 */
export function upsertMarketplace(
  name: string,
  entry: MarketplaceIndexEntry,
  path: string = getPluginsIndexPath(),
): PluginIndex {
  const index = readIndex(path);
  index.marketplaces[name] = entry;
  writeIndex(index, path);
  return index;
}

/**
 * Remove a marketplace entry by `name`. No-op if absent.
 *
 * Also cascades: any plugin entry whose `marketplace` field matches `name` is
 * removed. (The corresponding plugin dir lives inside the marketplace cache,
 * which is removed by the marketplace `remove` orchestrator.)
 */
export function removeMarketplace(
  name: string,
  path: string = getPluginsIndexPath(),
): PluginIndex {
  const index = readIndex(path);
  let mutated = false;
  if (name in index.marketplaces) {
    delete index.marketplaces[name];
    mutated = true;
  }
  for (const [key, entry] of Object.entries(index.plugins)) {
    if (entry.marketplace === name) {
      delete index.plugins[key];
      mutated = true;
    }
  }
  if (mutated) writeIndex(index, path);
  return index;
}

function cloneEmpty(): PluginIndex {
  return { version: 2, plugins: {}, marketplaces: {} };
}

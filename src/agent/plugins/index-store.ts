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
  /**
   * True when `ref` was explicitly supplied by the user (`--ref`) at install or
   * last update. False/absent means the updater auto-picked it (latest semver tag
   * or default branch).
   *
   * Legacy migration rule: when `pinnedRef` is `undefined` (pre-fix entry), treat
   * it as pinned when `ref` is non-null AND is not a semver tag AND is not the
   * repo's default branch. Auto-pick only ever stores a semver tag or the default
   * branch, so any other value in an old entry must have come from `--ref`.
   * Use `isPinnedRef()` to evaluate this rule consistently.
   */
  pinnedRef?: boolean;
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
  /**
   * User-supplied option values for this plugin's `userConfig` keys.
   * Map of manifest key → string value.  Set by `afk plugin config <name> <key> <value>`.
   * Sensitive keys are stored here but NEVER exported to hook env vars; stale
   * keys (removed from the manifest) are silently skipped at export time.
   */
  options?: Record<string, string>;
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
  /**
   * True when `ref` was explicitly supplied by the user (`--ref`) at install or
   * last update. False/absent means the updater auto-picked it (latest semver tag
   * or default branch).
   *
   * Legacy migration rule: same as PluginIndexEntry.pinnedRef — use
   * `isMarketplacePinnedRef()` to evaluate consistently.
   */
  pinnedRef?: boolean;
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

/**
 * Evaluate whether a PluginIndexEntry ref is user-pinned.
 *
 * Rule: explicit `pinnedRef: true` → pinned. `pinnedRef: false` → auto-picked.
 * `pinnedRef: undefined` (legacy entry) → apply the migration heuristic: treat
 * as pinned when `entry.ref` is non-null AND does not parse as semver AND is not
 * the repo's default branch. Auto-pick only ever stores a semver tag (e.g.
 * `v2.0.0`) or the default branch (e.g. `main`), so any other stored ref must
 * have originated from `--ref`.
 */
export function isPinnedRef(entry: Pick<PluginIndexEntry, 'ref' | 'pinnedRef'>, defaultBranch: string): boolean {
  if (entry.pinnedRef === true) return true;
  if (entry.pinnedRef === false) return false;
  const ref = entry.ref;
  if (!ref) return false;
  if (ref === defaultBranch) return false;
  const SEMVER_RE = /^v?\d+\.\d+\.\d+/;
  return !SEMVER_RE.test(ref);
}

/**
 * Evaluate whether a MarketplaceIndexEntry ref is user-pinned.
 * Identical semantics to isPinnedRef; duplicated so callers receive the
 * correct entry type without casting.
 */
export function isMarketplacePinnedRef(entry: Pick<MarketplaceIndexEntry, 'ref' | 'pinnedRef'>, defaultBranch: string): boolean {
  if (entry.pinnedRef === true) return true;
  if (entry.pinnedRef === false) return false;
  const ref = entry.ref;
  if (!ref) return false;
  if (ref === defaultBranch) return false;
  const SEMVER_RE = /^v?\d+\.\d+\.\d+/;
  return !SEMVER_RE.test(ref);
}

/**
 * Set a single option key for a plugin. Throws if the plugin is not in the index.
 * The caller is responsible for validating that `key` is declared in the manifest
 * and is not sensitive (see `validateOptionKey` in `plugin-user-config.ts`).
 */
export function setPluginOption(
  name: string,
  key: string,
  value: string,
  path: string = getPluginsIndexPath(),
): PluginIndex {
  const index = readIndex(path);
  const entry = index.plugins[name];
  if (!entry) {
    throw new Error(`plugin "${name}" is not in the index`);
  }
  entry.options = { ...(entry.options ?? {}), [key]: value };
  entry.updatedAt = new Date().toISOString();
  writeIndex(index, path);
  return index;
}

/**
 * Unset (remove) a single option key for a plugin. No-op when the key is absent.
 * Throws if the plugin is not in the index.
 */
export function unsetPluginOption(
  name: string,
  key: string,
  path: string = getPluginsIndexPath(),
): PluginIndex {
  const index = readIndex(path);
  const entry = index.plugins[name];
  if (!entry) {
    throw new Error(`plugin "${name}" is not in the index`);
  }
  if (entry.options && key in entry.options) {
    const updated = { ...entry.options };
    delete updated[key];
    entry.options = Object.keys(updated).length > 0 ? updated : undefined;
    entry.updatedAt = new Date().toISOString();
    writeIndex(index, path);
  }
  return index;
}

function cloneEmpty(): PluginIndex {
  return { version: 2, plugins: {}, marketplaces: {} };
}

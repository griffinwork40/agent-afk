/**
 * Installed-plugin inventory for status surfaces (`/reload-plugins`, future
 * `/plugins` listings).
 *
 * Joins three sources into one row per loaded plugin:
 *   - the on-disk scan (`scanLocalPlugins`) — the spine, listing exactly the
 *     plugin dirs a session loads;
 *   - each plugin's `.claude-plugin/plugin.json` manifest — canonical name +
 *     semver `version` (the version signal for marketplace/local plugins,
 *     whose index `ref`/`commit` are null);
 *   - the plugin index — `ref`/`commit`/`source` for git-tracked installs.
 *
 * Pure read. No FS writes, no network. Dependency-injectable (`roots`,
 * `indexPath`) so tests can point it at a tmp tree.
 *
 * @module agent/plugins/inventory
 */

import { basename } from 'path';
import {
  getBundledPluginsDir,
  getPluginsDir,
  getPluginsIndexPath,
  getProjectPluginsDir,
} from '../../paths.js';
import { scanLocalPlugins } from '../plugins-scanner.js';
import { readIndex, type PluginIndexEntry } from './index-store.js';
import { readPluginManifest } from './plugin-manifest.js';

export interface InstalledPlugin {
  /** Manifest `name` when present, else the directory basename. */
  name: string;
  /** Manifest `version` (semver string) when present in plugin.json. */
  version: string | null;
  /** Git ref (tag/branch/SHA) from the index — null for local/marketplace plugins. */
  ref: string | null;
  /** Commit SHA from the index — null for local/marketplace plugins. */
  commit: string | null;
  /** Original source string from the index (git URL, `owner/repo`, `<mp>:<plugin>`, path). */
  source: string | null;
  /** How the source was classified at install time, when indexed. */
  sourceType: PluginIndexEntry['sourceType'] | null;
  /** Absolute plugin directory on disk. */
  dir: string;
}

export interface ListInstalledPluginsDeps {
  /**
   * Plugin roots to scan, in priority order. Defaults to
   * [project, user, bundled] — the same set `collectSkillEntries` loads, so
   * the plugin-row list stays consistent with the "N plugin" skill breakdown
   * (the bundled `awa-bundled` plugin contributes skills too).
   */
  roots?: string[];
  /** Path to the plugin index. Defaults to the user-scope index. */
  indexPath?: string;
}

/**
 * Best-effort match a scanned plugin dir to its index entry. The index key is
 * either the flat dir name or `<marketplace>:<plugin>`, so we try the dir
 * basename and the manifest name against both the full key and its bare tail,
 * plus the entry's recorded `manifestName`.
 */
function findIndexEntry(
  dirBase: string,
  manifestName: string | null,
  plugins: Record<string, PluginIndexEntry>,
): PluginIndexEntry | null {
  const candidates = new Set<string>([dirBase]);
  if (manifestName) candidates.add(manifestName);
  for (const [key, entry] of Object.entries(plugins)) {
    if (candidates.has(key)) return entry;
    const bare = key.includes(':') ? key.split(':').pop()! : key;
    if (candidates.has(bare)) return entry;
    if (entry.manifestName && candidates.has(entry.manifestName)) return entry;
  }
  return null;
}

/**
 * List the plugins loadable from the given roots (default: project, user, then
 * bundled), annotated with manifest version + index git state. The on-disk
 * scan is the source of truth for "what's loaded"; deduped by resolved display
 * name (a plugin present in two roots is reported once, highest-priority root
 * winning). Sorted by name for stable rendering.
 */
export function listInstalledPlugins(deps: ListInstalledPluginsDeps = {}): InstalledPlugin[] {
  const roots = deps.roots ?? [getProjectPluginsDir(), getPluginsDir(), getBundledPluginsDir()];
  const index = readIndex(deps.indexPath ?? getPluginsIndexPath());

  const out: InstalledPlugin[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const p of scanLocalPlugins(root)) {
      if (p.type !== 'local') continue;
      const dir = p.path;
      const dirBase = basename(dir);
      const { name, version } = readPluginManifest(dir);
      const display = name ?? dirBase;
      if (seen.has(display)) continue;
      seen.add(display);
      const entry = findIndexEntry(dirBase, name, index.plugins);
      out.push({
        name: display,
        version,
        ref: entry?.ref ?? null,
        commit: entry?.commit ?? null,
        source: entry?.source ?? null,
        sourceType: entry?.sourceType ?? null,
        dir,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Compact version label for a plugin row. Prefers the manifest semver
 * (`v1.9.0`), falls back to the indexed git ref, then `(local)`. Appends a
 * short commit SHA when the index tracked one (git-sourced installs).
 */
export function formatPluginVersion(p: InstalledPlugin): string {
  let label: string;
  if (p.version) {
    label = /^v/i.test(p.version) ? p.version : `v${p.version}`;
  } else if (p.ref) {
    label = p.ref;
  } else {
    label = '(local)';
  }
  if (p.commit && p.commit !== p.ref) {
    label += ` @ ${p.commit.slice(0, 7)}`;
  }
  return label;
}

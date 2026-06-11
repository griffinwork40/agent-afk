/**
 * Local plugin discovery for AFK sessions.
 *
 * Marketplace-based install paths (`/marketplace install …`) still hardcode
 * to `~/.claude/plugins/` upstream (anthropics/claude-code#15071), so AFK
 * cannot rely on Claude Code to populate its own plugin home. Instead, AFK
 * scans `~/.afk/plugins/` at session construction and passes every discovered
 * plugin through as an explicit local entry.
 *
 * A directory is treated as a plugin when it contains
 * `.claude-plugin/plugin.json`. The scan descends up to {@link MAX_SCAN_DEPTH}
 * levels so both a flat layout (`~/.afk/plugins/<name>/`) and the
 * marketplace-cache layout (`~/.afk/plugins/cache/<marketplace>/<plugin>/<version>/`)
 * are supported.
 *
 * @module agent/plugins-scanner
 */

import type { SdkPluginConfig } from './types/sdk-types.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { getPluginsDir, getPluginsIndexPath } from '../paths.js';
import { readIndex } from './plugins/index-store.js';

const MAX_SCAN_DEPTH = 5;
const MARKETPLACE_CACHE_SEGMENT = 'cache';

/**
 * Process-lifetime cache of scan results, keyed by directory.
 *
 * Each `afk` turn invokes `scanLocalPlugins()` 3× (project + user + bundled
 * roots) from both `buildSkillManifest()` and `discoverPluginSkillBodies()`
 * — 6 scans per turn. The on-disk layout doesn't change between calls in
 * normal operation, so we memoize and serve subsequent calls in O(1).
 *
 * `/reload-plugins` and the plugin install/uninstall code paths must call
 * `_resetPluginScanCache()` when they mutate the plugins directory. Tests
 * that write per-case fixtures under a tmp `tmpHome` must call it in
 * `beforeEach`.
 */
let scanCache: Map<string, readonly SdkPluginConfig[]> | undefined;

/**
 * Clear the in-memory plugin scan cache. Call this after any operation that
 * mutates a scanned plugin directory (install, uninstall, /reload-plugins,
 * test fixture setup).
 */
export function _resetPluginScanCache(): void {
  scanCache = undefined;
}

/**
 * Discover local plugins under `dir`.
 *
 * Two layouts are supported:
 *   - **Flat**: `<root>/<name>/.claude-plugin/plugin.json` — index key is
 *     `<name>`. Plugins without an index entry are included for
 *     backwards-compat with hand-dropped plugins; entries with `enabled:
 *     false` are skipped.
 *   - **Marketplace cache**: `<root>/cache/<marketplace>/<plugin>/.claude-plugin/plugin.json`
 *     — index key is `<marketplace>:<plugin>`. Cache-layout plugins must
 *     have an enabled index entry; the plugin is skipped otherwise. This is
 *     deliberate — installing a marketplace clones every plugin it lists,
 *     and we only want the user-activated ones loaded by AFK.
 *
 * Memoized per-directory — see `scanCache` above for invalidation rules.
 */
export function scanLocalPlugins(dir: string = getPluginsDir()): SdkPluginConfig[] {
  if (!scanCache) scanCache = new Map();
  const cached = scanCache.get(dir);
  if (cached) {
    // Return a fresh array so callers that mutate (e.g. `.push`) don't
    // corrupt the cached result. The SdkPluginConfig entries themselves
    // are immutable value objects; shallow copy is sufficient.
    return [...cached];
  }
  if (!existsSync(dir)) {
    scanCache.set(dir, []);
    return [];
  }
  const indexPath = dir === getPluginsDir() ? getPluginsIndexPath() : join(dir, '.index.json');
  const index = readIndex(indexPath);
  const plugins: SdkPluginConfig[] = [];
  walk(dir, dir, 0, plugins, new Set<string>(), index.plugins);
  scanCache.set(dir, plugins);
  return [...plugins];
}

function walk(
  root: string,
  dir: string,
  depth: number,
  out: SdkPluginConfig[],
  seen: Set<string>,
  indexPlugins: Record<string, { enabled: boolean }>,
): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (seen.has(dir)) return;
  seen.add(dir);

  if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
    const key = indexKeyForPath(root, dir);
    if (key === null) {
      // Path that doesn't fit either layout — keep loading it (matches
      // pre-marketplace behavior for unexpected directory shapes).
      out.push({ type: 'local', path: dir });
      return;
    }
    if (key.layout === 'cache') {
      // Cache-layout plugins must be explicitly installed.
      const entry = indexPlugins[key.key];
      if (!entry || entry.enabled === false) return;
      out.push({ type: 'local', path: dir });
      return;
    }
    // Flat layout: include unless explicitly disabled.
    const entry = indexPlugins[key.key];
    if (entry && entry.enabled === false) return;
    out.push({ type: 'local', path: dir });
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(root, full, depth + 1, out, seen, indexPlugins);
  }
}

/**
 * Derive the index key + layout from a plugin path. Returns null when the
 * path doesn't fit either layout (e.g., a deeply-nested plugin we discovered
 * by walk but can't classify).
 *
 * For the cache layout, the canonical plugin name comes from the
 * marketplace's `marketplace.json`: each `plugins[].source` entry resolves
 * (relative to the marketplace dir) to a path on disk, and we match `leaf`
 * against those resolved paths. This handles both `cache/<mp>/<name>/` and
 * the more common `cache/<mp>/plugins/<name>/` (where `marketplace.json`
 * declares `source: "./plugins/<name>"`), and survives a marketplace that
 * renames the on-disk dir relative to the canonical plugin name. When the
 * manifest is missing or has no match (test fixtures, hand-curated
 * layouts), fall back to `segments[2]` — the pre-marketplace.json
 * behavior — which correctly classifies `cache/<mp>/<name>/` and the
 * deeper `cache/<mp>/<plugin>/<version>/` layout documented in the file
 * header.
 */
export function indexKeyForPath(
  root: string,
  leaf: string,
): { layout: 'flat' | 'cache'; key: string } | null {
  if (!leaf.startsWith(root)) return null;
  const rel = leaf.slice(root.length).replace(/^\/+/, '');
  if (!rel) return null;
  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  if (segments[0] === MARKETPLACE_CACHE_SEGMENT && segments.length >= 3) {
    const mp = segments[1];
    if (mp) {
      const marketplaceDir = join(root, MARKETPLACE_CACHE_SEGMENT, mp);
      const fromManifest = pluginNameFromMarketplace(marketplaceDir, leaf);
      const pluginName = fromManifest ?? segments[2];
      if (pluginName) {
        return { layout: 'cache', key: `${mp}:${pluginName}` };
      }
    }
  }

  // Flat layout: `<name>/...`
  const first = segments[0];
  if (!first) return null;
  return { layout: 'flat', key: first };
}

/**
 * Look up the canonical plugin name by matching `leaf` against each entry's
 * resolved `source` in the marketplace's `marketplace.json`. Only relative
 * sources (`./…`, `../…`) resolve into the marketplace cache; absolute and
 * git sources land elsewhere on disk and don't appear under `cache/<mp>/`.
 * Returns null when the manifest is missing, malformed, or has no match.
 */
function pluginNameFromMarketplace(marketplaceDir: string, leaf: string): string | null {
  const manifestPath = join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  if (!existsSync(manifestPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const plugins = (raw as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return null;

  const normalizedLeaf = resolvePath(leaf);
  for (const entry of plugins) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { name?: unknown; source?: unknown };
    if (typeof e.name !== 'string' || typeof e.source !== 'string') continue;
    if (!e.source.startsWith('./') && !e.source.startsWith('../')) continue;
    if (resolvePath(marketplaceDir, e.source) === normalizedLeaf) return e.name;
  }
  return null;
}

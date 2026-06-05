/**
 * Marketplace plugin resolver.
 *
 * Given an installed marketplace and a plugin name listed inside it, resolve
 * the plugin's `source` field and either:
 *   - upsert an enabled index entry pointing at the in-marketplace plugin
 *     dir (for relative-path sources — no copy/symlink needed since the
 *     scanner will find the plugin in-place under
 *     `~/.afk/plugins/cache/<mp>/<plugin>/`), or
 *   - fan out to `installPlugin()` for git/URL sources (the resulting plugin
 *     lands in `~/.afk/plugins/<name>/` like any other git install).
 *
 * Either path produces a `PluginIndexEntry` keyed `<marketplace>:<plugin>` for
 * relative sources, or by the canonical plugin name for git sources.
 *
 * @module agent/marketplaces/resolve
 */

import { env } from '../../config/env.js';
import { existsSync, statSync } from 'fs';
import { isAbsolute, join, resolve as resolvePath } from 'path';
import { getMarketplaceDir, getPluginsIndexPath } from '../../paths.js';
import {
  readIndex,
  upsertPlugin,
  type PluginIndexEntry,
} from '../plugins/index-store.js';
import { installPlugin, type InstallDeps, type InstallOptions } from '../plugins/install.js';
import {
  isMarketplaceDir,
  readManifest,
  type MarketplacePluginEntry,
} from './manifest.js';

export interface InstallFromMarketplaceOptions {
  /** Pin a specific ref for git-sourced plugins. Ignored for in-marketplace local plugins. */
  ref?: string;
  /** Replace an existing plugin with the same key. */
  force?: boolean;
}

export interface InstallFromMarketplaceDeps extends InstallDeps {
  /** Override the marketplace cache lookup root (`~/.afk/plugins/cache/`). */
  marketplaceDirFor?: (name: string) => string;
}

export interface InstallFromMarketplaceResult {
  /** Index key (`<mp>:<plugin>` for in-marketplace; the plugin's own name for git). */
  key: string;
  /** The plugin's manifest name. */
  name: string;
  /** Absolute path to the installed plugin dir. */
  dir: string;
  entry: PluginIndexEntry;
}

/**
 * Install a single plugin listed in an already-installed marketplace.
 *
 * Throws if the marketplace isn't installed, the manifest can't be read, or
 * the named plugin isn't listed.
 */
export async function installFromMarketplace(
  marketplace: string,
  plugin: string,
  options: InstallFromMarketplaceOptions = {},
  deps: InstallFromMarketplaceDeps = {},
): Promise<InstallFromMarketplaceResult> {
  const dirFor = deps.marketplaceDirFor ?? getMarketplaceDir;
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const now = deps.now ?? (() => new Date());

  const marketplaceDir = dirFor(marketplace);
  if (!existsSync(marketplaceDir) || !isMarketplaceDir(marketplaceDir)) {
    throw new Error(
      `marketplace "${marketplace}" is not installed (looked for manifest under ${marketplaceDir})`,
    );
  }

  const manifest = readManifest(marketplaceDir);
  const entry = manifest.plugins.find((p) => p.name === plugin);
  if (!entry) {
    const known = manifest.plugins.map((p) => p.name).join(', ') || '(none)';
    throw new Error(
      `marketplace "${marketplace}" does not list a plugin named "${plugin}". Available: ${known}`,
    );
  }

  if (isRelativeOrLocal(entry.source)) {
    return installInMarketplaceLocal(marketplace, entry, marketplaceDir, indexPath, now, options);
  }
  return installFromMarketplaceViaGit(marketplace, entry, options, deps);
}

/**
 * Returns one entry per plugin listed in the marketplace, with an `installed`
 * flag computed from the index. Used by `marketplace plugins <name>` to
 * render an `[installed]` / `[available]` list.
 */
export function listMarketplacePlugins(
  marketplace: string,
  deps: { marketplaceDirFor?: (name: string) => string; indexPath?: string } = {},
): { name: string; description?: string; installed: boolean; key: string }[] {
  const dirFor = deps.marketplaceDirFor ?? getMarketplaceDir;
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const marketplaceDir = dirFor(marketplace);
  if (!existsSync(marketplaceDir) || !isMarketplaceDir(marketplaceDir)) {
    throw new Error(`marketplace "${marketplace}" is not installed`);
  }

  const manifest = readManifest(marketplaceDir);
  const index = readIndex(indexPath);
  return manifest.plugins.map((p) => {
    const compositeKey = `${marketplace}:${p.name}`;
    const installed =
      compositeKey in index.plugins ||
      (p.name in index.plugins && index.plugins[p.name]?.marketplace === marketplace);
    const result: { name: string; description?: string; installed: boolean; key: string } = {
      name: p.name,
      installed,
      key: compositeKey,
    };
    if (p.description) result.description = p.description;
    return result;
  });
}

function isRelativeOrLocal(source: string): boolean {
  return (
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('/') ||
    source.startsWith('~')
  );
}

/** True when a marketplace plugin `source` is a local path (relative, absolute, or `~`) rather than a git-URL / `owner/repo` source. */
export function isLocalPluginSource(source: string): boolean {
  return source.startsWith('.') || isAbsolute(source) || source.startsWith('~');
}

/** Resolve a marketplace plugin `source` to its on-disk dir: absolute / `~` expand directly; relative resolves against the marketplace root. */
export function resolvePluginSourceDir(marketplaceDir: string, source: string): string {
  return isAbsolute(source) || source.startsWith('~')
    ? expandLocal(source)
    : resolvePath(marketplaceDir, source);
}

function installInMarketplaceLocal(
  marketplace: string,
  pluginEntry: MarketplacePluginEntry,
  marketplaceDir: string,
  indexPath: string,
  now: () => Date,
  options: InstallFromMarketplaceOptions,
): InstallFromMarketplaceResult {
  // Resolve the relative source against the marketplace root.
  const rawSource = pluginEntry.source;
  const absSource = resolvePluginSourceDir(marketplaceDir, rawSource);

  if (!existsSync(absSource)) {
    throw new Error(
      `marketplace "${marketplace}" lists plugin "${pluginEntry.name}" at ${absSource}, but that path does not exist on disk`,
    );
  }
  const stat = statSync(absSource);
  if (!stat.isDirectory()) {
    throw new Error(
      `marketplace "${marketplace}" lists plugin "${pluginEntry.name}" at ${absSource}, but that path is not a directory`,
    );
  }
  const pluginManifest = join(absSource, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginManifest)) {
    throw new Error(
      `marketplace "${marketplace}" lists plugin "${pluginEntry.name}" at ${absSource}, but no .claude-plugin/plugin.json was found`,
    );
  }

  const key = `${marketplace}:${pluginEntry.name}`;
  const index = readIndex(indexPath);
  if (!options.force && key in index.plugins && index.plugins[key]?.enabled) {
    throw new Error(
      `plugin "${key}" is already installed (re-run with --force to overwrite)`,
    );
  }

  const ts = now().toISOString();
  const entry: PluginIndexEntry = {
    source: `${marketplace}:${pluginEntry.name}`,
    sourceType: 'marketplace',
    ref: null,
    commit: null,
    enabled: true,
    installedAt: ts,
    updatedAt: ts,
    marketplace,
  };
  upsertPlugin(key, entry, indexPath);

  return { key, name: pluginEntry.name, dir: absSource, entry };
}

async function installFromMarketplaceViaGit(
  marketplace: string,
  pluginEntry: MarketplacePluginEntry,
  options: InstallFromMarketplaceOptions,
  deps: InstallDeps,
): Promise<InstallFromMarketplaceResult> {
  // For URL/shorthand sources we just delegate to the regular plugin
  // installer. The resulting plugin lives at `~/.afk/plugins/<name>/` and is
  // tracked in the index by its manifest name; we tag it with `marketplace:`
  // so a marketplace-remove cascade can find it later.
  const installOpts: InstallOptions = {
    name: pluginEntry.name,
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.force ? { force: true } : {}),
  };
  const result = await installPlugin(pluginEntry.source, installOpts, deps);

  // Annotate the freshly-written plugin entry with its marketplace origin.
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const annotated: PluginIndexEntry = { ...result.entry, marketplace };
  upsertPlugin(result.name, annotated, indexPath);

  return { key: result.name, name: result.name, dir: result.dir, entry: annotated };
}

function expandLocal(p: string): string {
  if (p.startsWith('~')) {
    const home = env.HOME ?? '';
    if (p === '~') return home;
    if (p.startsWith('~/')) return resolvePath(home, p.slice(2));
  }
  return p;
}

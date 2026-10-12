/**
 * Marketplace plugin resolver.
 *
 * Given an installed marketplace and a plugin name listed inside it, resolve
 * the plugin's `source` field and either:
 *   - upsert an enabled index entry pointing at the in-marketplace plugin
 *     dir (for relative-path sources — no copy/symlink needed since the
 *     scanner will find the plugin in-place under
 *     `~/.afk/plugins/cache/<mp>/<plugin>/`), or
 *   - fan out to `installPlugin()` for git/URL string sources (the resulting
 *     plugin lands in `~/.afk/plugins/<name>/` like any other git install), or
 *   - clone + subdir for `git-subdir` object sources (url cloned, plugin root
 *     resolved to `path` within the clone).
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
  isGitSubdirSource,
  readManifest,
  type GitSubdirSource,
  type MarketplacePluginEntry,
  type PluginSourceSpec,
} from './manifest.js';
import * as git from '../plugins/git.js';
import { assertHttpsUrl } from '../plugins/source.js';
import { prepareCachedCheckout, removeDest } from '../plugins/checkout-lifecycle.js';

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

  // Skipped entries are included in the manifest for list commands but are
  // not installable. Surface the skip reason so the user understands why.
  if (entry.skipped) {
    throw new Error(
      `plugin "${plugin}" in marketplace "${marketplace}" cannot be installed: ${entry.skipped}`,
    );
  }

  const source = entry.source;

  if (typeof source === 'string' && isRelativeOrLocalString(source)) {
    return installInMarketplaceLocal(marketplace, entry, source, marketplaceDir, indexPath, now, options);
  }
  if (typeof source === 'string') {
    return installFromMarketplaceViaGit(marketplace, entry, source, options, deps);
  }
  if (isGitSubdirSource(source)) {
    return installFromMarketplaceViaGitSubdir(marketplace, entry, source, options, deps);
  }

  // Should not be reachable if manifest parsing is correct, but guard anyway.
  throw new Error(
    `plugin "${plugin}" in marketplace "${marketplace}" has an unsupported source shape`,
  );
}

/**
 * Returns one entry per plugin listed in the marketplace, with an `installed`
 * flag computed from the index. Used by `marketplace plugins <name>` to
 * render an `[installed]` / `[available]` list.
 */
export function listMarketplacePlugins(
  marketplace: string,
  deps: { marketplaceDirFor?: (name: string) => string; indexPath?: string } = {},
): { name: string; description?: string; installed: boolean; key: string; skipped?: string }[] {
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
    const result: {
      name: string;
      description?: string;
      installed: boolean;
      key: string;
      skipped?: string;
    } = {
      name: p.name,
      installed,
      key: compositeKey,
    };
    if (p.description) result.description = p.description;
    if (p.skipped) result.skipped = p.skipped;
    return result;
  });
}

function isRelativeOrLocalString(source: string): boolean {
  return (
    source.startsWith('./') ||
    source.startsWith('../') ||
    isAbsolute(source) ||
    source.startsWith('~')
  );
}

/** True when a marketplace plugin `source` is a local path (relative, absolute, or `~`) rather than a git-URL / `owner/repo` source. */
export function isLocalPluginSource(source: PluginSourceSpec): boolean {
  if (typeof source !== 'string') return false;
  return source.startsWith('.') || isAbsolute(source) || source.startsWith('~');
}

/** Resolve a marketplace plugin string `source` to its on-disk dir: absolute / `~` expand directly; relative resolves against the marketplace root. */
export function resolvePluginSourceDir(marketplaceDir: string, source: string): string {
  return isAbsolute(source) || source.startsWith('~')
    ? expandLocal(source)
    : resolvePath(marketplaceDir, source);
}

function installInMarketplaceLocal(
  marketplace: string,
  pluginEntry: MarketplacePluginEntry,
  rawSource: string,
  marketplaceDir: string,
  indexPath: string,
  now: () => Date,
  options: InstallFromMarketplaceOptions,
): InstallFromMarketplaceResult {
  // Resolve the relative source against the marketplace root.
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
  source: string,
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
  const result = await installPlugin(source, installOpts, deps);

  // Annotate the freshly-written plugin entry with its marketplace origin.
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const annotated: PluginIndexEntry = { ...result.entry, marketplace };
  upsertPlugin(result.name, annotated, indexPath);

  return { key: result.name, name: result.name, dir: result.dir, entry: annotated };
}

/**
 * Handle a `git-subdir` object source: clone `url` at `ref`/`sha`, then
 * resolve the plugin root to `path` within the clone.
 *
 * The clone is placed in a temporary staging dir under the marketplace cache
 * and then the subdir is exposed as the plugin dir directly (no copy — the
 * clone acts as the plugin dir, with the subpath appended).
 */
async function installFromMarketplaceViaGitSubdir(
  marketplace: string,
  pluginEntry: MarketplacePluginEntry,
  spec: GitSubdirSource,
  options: InstallFromMarketplaceOptions,
  deps: InstallFromMarketplaceDeps,
): Promise<InstallFromMarketplaceResult> {
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const now = deps.now ?? (() => new Date());
  const gitOpts = deps.gitRunner ? { runner: deps.gitRunner } : {};

  // S7-HTTPS: reject non-HTTPS git sources before any FS side-effect.
  assertHttpsUrl(spec.url);

  // Use a staging clone dir named by marketplace + plugin so repeated installs
  // land in predictable, non-colliding locations.
  const dirFor = deps.marketplaceDirFor ?? getMarketplaceDir;
  const marketplaceDir = dirFor(marketplace);
  const cloneDir = join(marketplaceDir, '.git-subdir-clones', pluginEntry.name);

  const key = `${marketplace}:${pluginEntry.name}`;
  const index = readIndex(indexPath);
  if (!options.force && key in index.plugins && index.plugins[key]?.enabled) {
    throw new Error(
      `plugin "${key}" is already installed (re-run with --force to overwrite)`,
    );
  }

  // Never remove a pre-existing checkout when a repeated clone fails.
  const cloneDirExisted = existsSync(cloneDir);
  try {
    await git.clone(spec.url, cloneDir, gitOpts);
    const refOverride = options.ref ?? spec.ref ?? spec.sha;
    const { ref, commit } = await prepareCachedCheckout(cloneDir, refOverride, gitOpts);

    const pluginDir = join(cloneDir, spec.path);
    if (!existsSync(pluginDir)) {
      throw new Error(
        `git-subdir plugin "${pluginEntry.name}": path "${spec.path}" not found in clone of ${spec.url}`,
      );
    }

    const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!existsSync(pluginJsonPath)) {
      throw new Error(
        `git-subdir plugin "${pluginEntry.name}": no .claude-plugin/plugin.json found at "${spec.path}" in clone of ${spec.url}`,
      );
    }

    const ts = now().toISOString();
    const entry: PluginIndexEntry = {
      source: `${marketplace}:${pluginEntry.name}`,
      sourceType: 'marketplace',
      ref,
      commit,
      enabled: true,
      installedAt: ts,
      updatedAt: ts,
      marketplace,
    };
    upsertPlugin(key, entry, indexPath);

    return { key, name: pluginEntry.name, dir: pluginDir, entry };
  } catch (err) {
    try {
      if (!cloneDirExisted && existsSync(cloneDir)) removeDest(cloneDir);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

function expandLocal(p: string): string {
  if (p.startsWith('~')) {
    const home = env.HOME ?? '';
    if (p === '~') return home;
    if (p.startsWith('~/')) return resolvePath(home, p.slice(2));
  }
  return p;
}

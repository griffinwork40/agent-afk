/**
 * Marketplace installer.
 *
 * Clones (or symlinks) a marketplace into `~/.afk/plugins/cache/<name>/` and
 * records an entry in the unified plugin index. The install dir name is
 * derived from `marketplace.json`'s `name` field — not the source basename —
 * so the on-disk layout always matches the manifest's declared identity.
 *
 * Plugins listed inside the marketplace are NOT auto-activated. The user must
 * run `afk plugin install <marketplace>:<plugin>` (or the explicit
 * `marketplace install-plugin`) to activate one.
 *
 * @module agent/marketplaces/install
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
} from 'fs';
import { basename, join } from 'path';
import { getMarketplaceCacheDir, getPluginsIndexPath } from '../../paths.js';
import { assertSafePluginName, assertWithinPluginsDir } from '../plugins/install.js';
import { parseSource, assertHttpsUrl, type ParsedSource } from '../plugins/source.js';
import * as git from '../plugins/git.js';
import { upsertMarketplace, type MarketplaceIndexEntry } from '../plugins/index-store.js';
import { pickLatestSemverTag } from '../plugins/versions.js';
import { readManifest } from './manifest.js';

export interface MarketplaceInstallOptions {
  /** Override the install dir name. Defaults to `marketplace.json`'s `name`. */
  name?: string;
  /** Install a specific tag / branch / SHA instead of the latest semver tag. */
  ref?: string;
  /** Overwrite an existing marketplace dir with the same name. */
  force?: boolean;
}

export interface MarketplaceInstallResult {
  name: string;
  dir: string;
  entry: MarketplaceIndexEntry;
  /** Plugin entries surfaced from the manifest (for caller-side rendering). */
  plugins: { name: string; description?: string }[];
}

export interface MarketplaceInstallDeps {
  cacheDir?: string;
  indexPath?: string;
  gitRunner?: git.GitRunner;
  now?: () => Date;
}

export async function installMarketplace(
  source: string,
  options: MarketplaceInstallOptions = {},
  deps: MarketplaceInstallDeps = {},
): Promise<MarketplaceInstallResult> {
  const cacheDir = deps.cacheDir ?? getMarketplaceCacheDir();
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const now = deps.now ?? (() => new Date());
  const gitOpts = deps.gitRunner ? { runner: deps.gitRunner } : {};

  const parsed = parseSource(source);
  if (parsed.type === 'marketplace-ref') {
    throw new Error(
      `marketplace source cannot itself be a marketplace reference ("${source}")`,
    );
  }

  mkdirSync(cacheDir, { recursive: true });

  if (parsed.type === 'local') {
    return installLocal(parsed, options, cacheDir, indexPath, now);
  }
  return installGit(parsed, options, cacheDir, indexPath, now, gitOpts);
}

function installLocal(
  parsed: Extract<ParsedSource, { type: 'local' }>,
  options: MarketplaceInstallOptions,
  cacheDir: string,
  indexPath: string,
  now: () => Date,
): MarketplaceInstallResult {
  const manifest = readManifest(parsed.path);
  const name = options.name ?? manifest.name;
  assertSafePluginName(name);
  const dest = join(cacheDir, name);
  assertWithinPluginsDir(dest, cacheDir);

  assertDestAvailable(dest, options.force ?? false);
  if (existsSync(dest) || isLink(dest)) removeDest(dest);

  symlinkSync(parsed.path, dest, 'dir');

  const ts = now().toISOString();
  const entry: MarketplaceIndexEntry = {
    source: parsed.path,
    sourceType: 'local',
    ref: null,
    commit: null,
    installedAt: ts,
    updatedAt: ts,
  };
  upsertMarketplace(name, entry, indexPath);

  return { name, dir: dest, entry, plugins: manifest.plugins.map(toListEntry) };
}

async function installGit(
  parsed: Extract<ParsedSource, { type: 'git' | 'github' }>,
  options: MarketplaceInstallOptions,
  cacheDir: string,
  indexPath: string,
  now: () => Date,
  gitOpts: git.GitOptions,
): Promise<MarketplaceInstallResult> {
  // S7-HTTPS: reject non-HTTPS git sources before any FS side-effect. Mirrors
  // the gate in `installPlugin` — marketplaces are equally privileged code.
  // GitHub shorthand always expands to https://, but a raw `git` source could
  // still be ssh://, git://, http://, etc. — those are downgrade attacks.
  assertHttpsUrl(parsed.url);

  const provisionalName = options.name ?? defaultGitName(parsed);
  assertSafePluginName(provisionalName);
  const provisionalDir = join(cacheDir, provisionalName);
  assertWithinPluginsDir(provisionalDir, cacheDir);
  assertDestAvailable(provisionalDir, options.force ?? false);
  if (existsSync(provisionalDir)) removeDest(provisionalDir);

  const sourceString = parsed.type === 'github' ? `${parsed.owner}/${parsed.repo}` : parsed.url;

  await git.clone(parsed.url, provisionalDir, gitOpts);

  try {
    let ref: string;
    if (options.ref) {
      ref = options.ref;
    } else {
      const tags = await git.listTags(provisionalDir, gitOpts);
      const latest = pickLatestSemverTag(tags);
      ref = latest ?? (await git.getDefaultBranch(provisionalDir, gitOpts));
    }
    if (options.ref || (await hasNonDefaultRef(provisionalDir, ref, gitOpts))) {
      await git.checkout(provisionalDir, ref, gitOpts);
    }
    const commit = await git.getCommitSha(provisionalDir, gitOpts);

    const manifest = readManifest(provisionalDir);
    let finalName = provisionalName;
    let finalDir = provisionalDir;
    if (!options.name && manifest.name !== provisionalName) {
      assertSafePluginName(manifest.name);
      const renamedDir = join(cacheDir, manifest.name);
      assertWithinPluginsDir(renamedDir, cacheDir);
      assertDestAvailable(renamedDir, options.force ?? false);
      if (existsSync(renamedDir)) removeDest(renamedDir);
      renameSync(provisionalDir, renamedDir);
      finalName = manifest.name;
      finalDir = renamedDir;
    }

    const ts = now().toISOString();
    const entry: MarketplaceIndexEntry = {
      source: sourceString,
      sourceType: parsed.type,
      ref,
      commit,
      installedAt: ts,
      updatedAt: ts,
    };
    upsertMarketplace(finalName, entry, indexPath);

    return { name: finalName, dir: finalDir, entry, plugins: manifest.plugins.map(toListEntry) };
  } catch (err) {
    try {
      if (existsSync(provisionalDir)) removeDest(provisionalDir);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

async function hasNonDefaultRef(
  dest: string,
  ref: string,
  gitOpts: git.GitOptions,
): Promise<boolean> {
  const current = await git.getDefaultBranch(dest, gitOpts);
  return ref !== current;
}

function defaultGitName(parsed: Extract<ParsedSource, { type: 'git' | 'github' }>): string {
  if (parsed.type === 'github') return parsed.repo;
  const cleaned = parsed.url.replace(/\.git$/, '');
  const lastSlash = cleaned.lastIndexOf('/');
  const lastColon = cleaned.lastIndexOf(':');
  const idx = Math.max(lastSlash, lastColon);
  return idx >= 0 ? cleaned.slice(idx + 1) : basename(cleaned);
}

function assertDestAvailable(dest: string, force: boolean): void {
  if (!existsSync(dest) && !isLink(dest)) return;
  if (force) return;
  throw new Error(
    `marketplace directory already exists: ${dest} (re-run with --force to replace)`,
  );
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeDest(dest: string): void {
  if (isLink(dest)) {
    unlinkSync(dest);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
}

function toListEntry(p: { name: string; description?: string }): { name: string; description?: string } {
  return p.description ? { name: p.name, description: p.description } : { name: p.name };
}

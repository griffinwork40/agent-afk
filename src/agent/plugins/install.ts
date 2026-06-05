/**
 * Plugin installer.
 *
 * Orchestrates source parsing, git cloning / symlinking, version resolution,
 * manifest lookup, and index-store updates. Keeps the moving parts behind a
 * typed `Deps` bag so tests can substitute fakes without touching the FS or
 * shelling out to git.
 *
 * Flow:
 *   1. Parse the source string.
 *   2. Resolve the target dir name (manifest `name` takes precedence unless
 *      the caller supplied an explicit `name`).
 *   3. If dest dir already exists → refuse (unless `force`).
 *   4. Git sources  → `git clone`, then checkout resolved ref (latest semver
 *      tag or user-supplied `--ref`). Record resolved SHA.
 *   5. Local source → `symlink` into plugins dir.
 *   6. Upsert the index entry.
 *
 * @module agent/plugins/install
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
} from 'fs';
import { basename, dirname, join, resolve, relative } from 'path';
import { getPluginsDir, getPluginsIndexPath } from '../../paths.js';
import { parseSource, assertHttpsUrl, type ParsedSource } from './source.js';
import * as git from './git.js';
import { upsertPlugin, type PluginIndexEntry } from './index-store.js';
import { pickLatestSemverTag } from './versions.js';
// Invalidate the process-lifetime scan cache after any successful install so
// the running session sees the new plugin without a restart. (Audit F2)
import { _resetPluginScanCache } from '../plugins-scanner.js';

export interface InstallOptions {
  /** Override the destination directory name. Defaults to manifest `name`, then fall-back to the source slug. */
  name?: string;
  /** Install a specific tag / branch / SHA instead of the latest semver tag. */
  ref?: string;
  /** Overwrite an existing plugin dir with the same name. */
  force?: boolean;
}

export interface InstallResult {
  name: string;
  dir: string;
  entry: PluginIndexEntry;
}

export interface InstallDeps {
  pluginsDir?: string;
  indexPath?: string;
  gitRunner?: git.GitRunner;
  /** Injectable now() for deterministic timestamps in tests. */
  now?: () => Date;
  /**
   * When true (default), print a prominent stderr warning and wait
   * `confirmDelayMs` milliseconds before proceeding with the clone.
   * Set to false for non-interactive paths (CI, --yes flag, tests).
   */
  confirm?: boolean;
  /**
   * How long to pause (in milliseconds) after printing the install warning
   * before proceeding. Defaults to 3000 (3 seconds). Set to 0 in tests to
   * avoid slow-down. Ignored when confirm is false.
   */
  confirmDelayMs?: number;
}

export async function installPlugin(
  source: string,
  options: InstallOptions = {},
  deps: InstallDeps = {},
): Promise<InstallResult> {
  const pluginsDir = deps.pluginsDir ?? getPluginsDir();
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const now = deps.now ?? (() => new Date());
  const gitOpts = deps.gitRunner ? { runner: deps.gitRunner } : {};
  // confirm defaults to true (interactive); callers can pass false for CI/--yes.
  const confirm = deps.confirm ?? true;
  const confirmDelayMs = deps.confirmDelayMs ?? 3000;

  const parsed = parseSource(source);
  mkdirSync(pluginsDir, { recursive: true });

  // Resolve destination name. For git/github we clone first to a temp dir,
  // read the manifest, then rename to the final name. For local sources the
  // manifest is already on disk.
  if (parsed.type === 'local') {
    return installLocal(parsed, options, pluginsDir, indexPath, now);
  }

  if (parsed.type === 'marketplace-ref') {
    // Marketplace-ref sources are resolved by the marketplace orchestrator,
    // which fans out back into installPlugin for any git-sourced plugins
    // listed in the manifest. Reaching this branch means the caller didn't
    // route — surface a clear error rather than silently mis-installing.
    throw new Error(
      `marketplace-ref source "${parsed.marketplace}:${parsed.plugin}" must be installed via the marketplace resolver, not installPlugin directly`,
    );
  }

  // S7-HTTPS: reject non-HTTPS git sources.
  assertHttpsUrl(parsed.url);

  return installGit(parsed, options, pluginsDir, indexPath, now, gitOpts, {
    confirm,
    confirmDelayMs,
  });
}

function installLocal(
  parsed: Extract<ParsedSource, { type: 'local' }>,
  options: InstallOptions,
  pluginsDir: string,
  indexPath: string,
  now: () => Date,
): InstallResult {
  assertNotMarketplace(parsed.path);
  const manifestName = readManifestName(parsed.path);
  const name = options.name ?? manifestName ?? basename(parsed.path);
  assertSafePluginName(name);
  const dest = join(pluginsDir, name);
  assertWithinPluginsDir(dest, pluginsDir);

  assertDestAvailable(dest, options.force ?? false);

  // Remove stale symlink or directory when `force` is on.
  if (existsSync(dest) || isLink(dest)) {
    removeDest(dest);
  }

  symlinkSync(parsed.path, dest, 'dir');

  const ts = now().toISOString();
  const entry: PluginIndexEntry = {
    source: parsed.path,
    sourceType: 'local',
    ref: null,
    commit: null,
    enabled: true,
    installedAt: ts,
    updatedAt: ts,
    ...(manifestName && manifestName !== name ? { manifestName } : {}),
  };
  upsertPlugin(name, entry, indexPath);
  // Invalidate scan cache — the running session must see the new plugin. (F2)
  _resetPluginScanCache();
  return { name, dir: dest, entry };
}

interface ConfirmOpts {
  confirm: boolean;
  confirmDelayMs: number;
}

async function installGit(
  parsed: Extract<ParsedSource, { type: 'git' | 'github' }>,
  options: InstallOptions,
  pluginsDir: string,
  indexPath: string,
  now: () => Date,
  gitOpts: git.GitOptions,
  confirmOpts: ConfirmOpts,
): Promise<InstallResult> {
  const provisionalName = options.name ?? defaultGitName(parsed);
  assertSafePluginName(provisionalName);
  const dest = join(pluginsDir, provisionalName);
  assertWithinPluginsDir(dest, pluginsDir);
  assertDestAvailable(dest, options.force ?? false);
  if (existsSync(dest)) removeDest(dest);

  const sourceString = parsed.type === 'github' ? `${parsed.owner}/${parsed.repo}` : parsed.url;

  // S7-warning: Emit a prominent install warning BEFORE the clone so the user
  // has a chance to abort. Skip in non-interactive / --yes contexts.
  if (confirmOpts.confirm) {
    await printInstallWarning(parsed.url, confirmOpts.confirmDelayMs);
  }

  await git.clone(parsed.url, dest, gitOpts);

  try {
    // Decide which ref to checkout.
    let ref: string;
    if (options.ref) {
      ref = options.ref;
    } else {
      const tags = await git.listTags(dest, gitOpts);
      const latest = pickLatestSemverTag(tags);
      ref = latest ?? (await git.getDefaultBranch(dest, gitOpts));
    }

    if (options.ref || (await hasNonDefaultRef(dest, ref, gitOpts))) {
      await git.checkout(dest, ref, gitOpts);
    }
    const commit = await git.getCommitSha(dest, gitOpts);

    assertNotMarketplace(dest);
    const manifestName = readManifestName(dest);
    // If the manifest name differs from the provisional dir, rename to match.
    let finalName = provisionalName;
    let finalDir = dest;
    if (!options.name && manifestName && manifestName !== provisionalName) {
      assertSafePluginName(manifestName);
      const renamedDir = join(pluginsDir, manifestName);
      assertWithinPluginsDir(renamedDir, pluginsDir);
      assertDestAvailable(renamedDir, options.force ?? false);
      if (existsSync(renamedDir)) removeDest(renamedDir);
      renameSync(dest, renamedDir);
      finalName = manifestName;
      finalDir = renamedDir;
    }

    const ts = now().toISOString();
    const entry: PluginIndexEntry = {
      source: sourceString,
      sourceType: parsed.type,
      ref,
      commit,
      enabled: true,
      installedAt: ts,
      updatedAt: ts,
      ...(manifestName && manifestName !== finalName ? { manifestName } : {}),
    };
    upsertPlugin(finalName, entry, indexPath);
    // Invalidate scan cache — the running session must see the new plugin. (F2)
    _resetPluginScanCache();
    return { name: finalName, dir: finalDir, entry };
  } catch (err) {
    // Best-effort cleanup of the half-cloned dir so re-install doesn't trip
    // the "already exists" guard.
    try {
      if (existsSync(dest)) removeDest(dest);
    } catch {
      /* ignore */
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
  // Strip trailing `.git` and take the last path segment.
  const cleaned = parsed.url.replace(/\.git$/, '');
  const lastSlash = cleaned.lastIndexOf('/');
  const lastColon = cleaned.lastIndexOf(':');
  const idx = Math.max(lastSlash, lastColon);
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Print a prominent multi-line warning to stderr before allowing a plugin
 * to be cloned and installed.
 *
 * Why this matters: a cloned plugin's SKILL.md body becomes the system prompt
 * for a forked subagent that has full tool access (bash, write_file, etc.).
 * Installing a plugin is therefore equivalent to granting whoever controls
 * that git ref the ability to execute arbitrary code on behalf of the user.
 *
 * The warning includes a short countdown (configurable, default 3 s) so that
 * a user watching their terminal can press Ctrl-C before the clone begins.
 * The delay is skipped when `delayMs` is 0 or when called with `confirm: false`.
 *
 * External constraint: the warning MUST be written before the git.clone()
 * call, not after. The order is enforced by the call site — printInstallWarning
 * is awaited before git.clone() is invoked.
 */
async function printInstallWarning(url: string, delayMs: number): Promise<void> {
  const line = '═'.repeat(70);
  const warn = (s: string) => process.stderr.write(s + '\n');
  warn('');
  warn(line);
  warn('  ⚠️  PLUGIN INSTALL WARNING — READ BEFORE CONTINUING');
  warn(line);
  warn('');
  warn(`  Source : ${url}`);
  warn('');
  warn('  Installing a plugin grants ARBITRARY CODE EXECUTION to whoever controls');
  warn('  that git ref. The plugin\'s SKILL.md becomes a system prompt that runs');
  warn('  inside a subagent with full tool access (bash, write_file, web_scrape,');
  warn('  and any other tool enabled in your session).');
  warn('');
  warn('  ► Audit the repository source code before proceeding.');
  warn('  ► Only install plugins from authors you trust.');
  warn('  ► Run `afk plugin install --yes <source>` to suppress this warning.');
  warn('');

  if (delayMs > 0) {
    const seconds = Math.ceil(delayMs / 1000);
    warn(`  Proceeding in ${seconds} second(s)… Press Ctrl-C to abort.`);
    warn('');
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  warn(line);
  warn('');
}

/**
 * Reject sources that point at a marketplace catalog instead of a plugin.
 * Without this guard, the existing installer happily symlinks the marketplace
 * dir (since dir basename always resolves) but the SDK then loads nothing —
 * the silent-failure mode that motivated the dedicated marketplace command.
 */
function assertNotMarketplace(dir: string): void {
  const pluginManifest = join(dir, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginManifest)) return;
  const marketplaceManifest = join(dir, '.claude-plugin', 'marketplace.json');
  if (!existsSync(marketplaceManifest)) return;
  throw new Error(
    `${dir} contains .claude-plugin/marketplace.json instead of plugin.json. ` +
      `Use \`afk marketplace install <source>\` to install a marketplace, ` +
      `then \`afk plugin install <marketplace>:<plugin>\` to install a plugin from it.`,
  );
}

function readManifestName(dir: string): string | null {
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
    if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    return null;
  } catch {
    return null;
  }
}

// ── Security helpers ────────────────────────────────────────────────────────

/** Safe plugin/marketplace name: alphanumeric, hyphens, underscores; no dots or slashes. */
const SAFE_PLUGIN_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Validate that `name` cannot be used for path traversal.
 * Accepts the same character set as SAFE_PROCEDURE_NAME in memory-store.
 */
export function assertSafePluginName(name: string): void {
  if (!name || name.length > 100 || !SAFE_PLUGIN_NAME.test(name)) {
    throw new Error(
      `Invalid plugin name "${name}": must be 1–100 chars, starting with alphanumeric, ` +
        `containing only letters, digits, hyphens, or underscores.`,
    );
  }
}

/**
 * Assert that `dest` stays inside `parentDir` — guards against manifest
 * names that contain ".." or absolute path segments AND against symlinks
 * whose targets escape the sandbox.
 *
 * Both paths are dereferenced via `realpathSync` when they exist on disk
 * so a symlink inside `parentDir` whose target points outside is blocked.
 * If `dest` does not exist yet (the common install-time case where we're
 * validating before writing), fall back to lexical `resolve()` for `dest`.
 * `parentDir` itself must exist — it is the plugins directory, created by
 * the caller before validation.
 */
export function assertWithinPluginsDir(dest: string, parentDir: string): void {
  // This helper is a leaf-name traversal guard: every call site supplies
  // `dest = join(parentDir, <safe-name>)`, so we are validating that the
  // joined location stays inside the sandbox after path normalisation.
  //
  // Symlink handling rule: we realpath `parentDir` and the *dirname* of
  // `dest` (then rejoin the basename) so that if `parentDir` is itself a
  // symlink, both sides resolve through the same physical inode and
  // `relative()` is sound. We intentionally do NOT realpath `dest` itself
  // — the install flow creates `dest` as a symlink-by-design for local
  // sources (it points to the source dir outside parentDir), and a
  // subsequent re-install must not be misclassified as a traversal escape.
  let parentReal: string;
  try {
    parentReal = realpathSync(resolve(parentDir));
  } catch {
    parentReal = resolve(parentDir);
  }

  const resolvedDest = resolve(dest);
  let destReal: string;
  try {
    destReal = join(realpathSync(dirname(resolvedDest)), basename(resolvedDest));
  } catch {
    destReal = resolvedDest;
  }

  const rel = relative(parentReal, destReal);
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`Path traversal detected: resolved path "${dest}" escapes plugin dir "${parentDir}"`);
  }
  // Belt-and-suspenders: on POSIX, path.relative never returns an absolute path,
  // so this arm is unreachable today. It is kept as a defensive guard for
  // hypothetical Windows support or future platform changes where relative()
  // semantics may differ (e.g. cross-drive paths that cannot be made relative).
  if (rel.startsWith('/')) {
    throw new Error(`Path traversal detected: resolved path "${dest}" escapes plugin dir "${parentDir}"`);
  }
}

function assertDestAvailable(dest: string, force: boolean): void {
  if (!existsSync(dest) && !isLink(dest)) return;
  if (force) return;
  throw new Error(
    `plugin directory already exists: ${dest} (re-run with --force to replace)`,
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


import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getAfkHome, getProjectAfkDir } from './paths.js';

/**
 * Plugin-scope paths (docs/ plugin layout). Extracted whole-concern from
 * `src/paths.ts` at the 350-code-line ceiling, following the
 * `paths.journal.ts` precedent: `paths.ts` re-exports everything here, so no
 * importer is rewritten and the public surface is unchanged.
 */

export function getPluginsDir(): string {
  return join(getAfkHome(), 'plugins');
}

export function getProjectPluginsDir(cwd: string = process.cwd()): string {
  return join(getProjectAfkDir(cwd), 'plugins');
}

export function getPluginsIndexPath(): string {
  return join(getPluginsDir(), '.index.json');
}

/**
 * Per-plugin writable data directory: `~/.afk/plugins/data/<sanitisedKey>/`.
 *
 * This is AFK's equivalent of Claude Code's `CLAUDE_PLUGIN_DATA` env var — a
 * stable, plugin-private directory for logs, caches, and any persistent state
 * the plugin's hook scripts need to write.
 *
 * The `pluginKey` argument is the index key (e.g. `"my-plugin"` or
 * `"marketplace:my-plugin"`). Colons and other filesystem-unsafe characters
 * are replaced with `__` so the resulting directory name is unambiguous and
 * portable across POSIX and Windows. Keys that sanitise to `.`, `..`, or
 * empty are normalised to `__` to prevent directory traversal.
 *
 * The directory is NOT created here — it is created lazily (mode 0o700) by
 * `ensurePluginDataDir` in `src/agent/hooks/command-executor.ts` at hook-
 * dispatch time so callers that only need the path pay no I/O cost.
 */
export function getPluginDataDir(pluginKey: string): string {
  const safe = pluginKey.replace(/[^A-Za-z0-9._-]+/g, '__') || '__';
  return join(getPluginsDir(), 'data', /^\.{1,2}$/.test(safe) ? '__' : safe);
}

/**
 * Marketplace cache root. Marketplaces clone into
 * `~/.afk/plugins/cache/<marketplace>/`, matching Claude Code's layout.
 */
export function getMarketplaceCacheDir(): string {
  return join(getPluginsDir(), 'cache');
}

/** Path to a specific marketplace's clone dir. */
export function getMarketplaceDir(name: string): string {
  return join(getMarketplaceCacheDir(), name);
}

/**
 * Bundled plugins shipped inside the compiled dist/ output.
 * Resolved relative to this module's location so it works from both
 * `src/` (dev via tsx) and `dist/` (built output).
 */
export function getBundledPluginsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  // In dist/: thisDir = <root>/dist  → bundled-plugins is a sibling
  // In src/:  thisDir = <root>/src   → bundled-plugins is a sibling
  return join(thisDir, 'bundled-plugins');
}

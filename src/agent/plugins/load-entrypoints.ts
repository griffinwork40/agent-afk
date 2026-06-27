/**
 * Boot-time loading of plugin JS entrypoints.
 *
 * A plugin manifest may declare a `main` module (see {@link SdkPluginConfig.main}).
 * Importing that module at session boot runs its top-level side-effects —
 * typically `registerSkill()` / agent registration — so a plugin can contribute
 * code-backed capabilities without a core edit. This is the seam that lets an
 * internal-tier skill bundle live entirely in a plugin rather than in `src/`.
 *
 * Invariant: a failing entrypoint MUST NOT abort session boot. A broken plugin
 * degrades to "its skills don't load," never "the session won't start."
 *
 * @module agent/plugins/load-entrypoints
 */

import { isAbsolute, resolve as resolvePath } from 'path';
import { pathToFileURL } from 'url';
import type { SdkPluginConfig } from '../types/sdk-types.js';

/**
 * Resolved-entrypoint paths already imported in this process. Dynamic `import()`
 * caches modules itself, but tracking here lets us skip redundant awaits when
 * the scanner is consulted multiple times per turn and keeps load deterministic.
 */
const loadedEntrypoints = new Set<string>();

/** Clear the loaded-entrypoint set. For tests and `/reload-plugins`. */
export function _resetLoadedEntrypoints(): void {
  loadedEntrypoints.clear();
}

export type LoadEntrypointsOptions = {
  /** Injectable importer for tests; defaults to native dynamic `import()`. */
  importer?: (specifier: string) => Promise<unknown>;
  /** Invoked (non-fatally) when a plugin entrypoint fails to import. */
  onError?: (plugin: SdkPluginConfig, error: unknown) => void;
};

/**
 * Import the `main` entrypoint of every plugin that declares one. Idempotent
 * per resolved path within a process; per-plugin failures are isolated and
 * non-fatal (reported via {@link LoadEntrypointsOptions.onError}).
 */
export async function loadPluginEntrypoints(
  plugins: readonly SdkPluginConfig[],
  opts: LoadEntrypointsOptions = {},
): Promise<void> {
  const importer = opts.importer ?? ((specifier: string) => import(specifier));
  for (const plugin of plugins) {
    if (plugin.main === undefined) continue;
    const absPath = isAbsolute(plugin.main)
      ? plugin.main
      : resolvePath(plugin.path, plugin.main);
    if (loadedEntrypoints.has(absPath)) continue;
    // Mark before awaiting: a re-entrant call during the same boot must not
    // double-import, and a failed entrypoint must not be retried this process.
    loadedEntrypoints.add(absPath);
    try {
      await importer(pathToFileURL(absPath).href);
    } catch (error) {
      opts.onError?.(plugin, error);
    }
  }
}

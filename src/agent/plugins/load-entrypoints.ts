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
 * Host runtime API injected into a plugin entrypoint's default-export function.
 *
 * Invariant: a code-backed plugin MUST register through this object, not by
 * importing `agent-afk` itself. The skill registry is a module-level singleton
 * (`src/skills/index.ts`), so a plugin that imports its OWN copy of `agent-afk`
 * (its `node_modules`, a bundle, or a version-skewed install — the default for a
 * marketplace-cloned plugin with no shared `node_modules`) would call a
 * `registerSkill` backed by a DIFFERENT registry than the host reads → the skill
 * silently never appears. Receiving these functions from the host guarantees the
 * same module instance regardless of how the plugin was installed.
 *
 * Stateless helpers (`env`, the `paths` getters, `describeFailure`) are safe for
 * a plugin to import directly — they hold no singleton state — and are
 * intentionally omitted to keep this surface minimal. The type is derived via
 * `typeof import(...)` so the injected signatures cannot drift from the source.
 */
export type PluginApi = Pick<
  typeof import('../../skills/index.js'),
  'registerSkill' | 'listSkills' | 'getSkill'
> &
  Pick<typeof import('../../skills/_lib/prompt-loader.js'), 'loadSkillPrompts'>;

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
  /**
   * Host API injected into a plugin entrypoint's default-export function. When a
   * plugin's `main` module exports a callable `default`, it is invoked as
   * `await mod.default(pluginApi)` AFTER import — the sanctioned way for a
   * code-backed plugin to register skills against the host's singleton registry
   * (see {@link PluginApi}). Modules with no default-export function still run
   * their top-level side-effects at import time (backward-compatible).
   */
  pluginApi?: PluginApi;
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
      // Importing runs the module's top-level side-effects (back-compat). If it
      // ALSO exports a callable default, invoke it with the host API so the
      // plugin registers against the host's singleton registry rather than a
      // bare-specifier-imported copy of its own (see {@link PluginApi}).
      const mod = await importer(pathToFileURL(absPath).href);
      const entry = (mod as { default?: unknown } | undefined)?.default;
      if (typeof entry === 'function') {
        await (entry as (api: PluginApi | undefined) => unknown)(opts.pluginApi);
      }
    } catch (error) {
      opts.onError?.(plugin, error);
    }
  }
}

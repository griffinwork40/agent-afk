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
import type { HarnessHookEvent, HookHandler, HookRegistry, RegisterOptions } from '../hooks.js';

/**
 * Host runtime API injected into a plugin entrypoint's default-export function.
 *
 * Invariant: a code-backed plugin MUST consume the host runtime through this
 * object, never via a bare `import … from 'agent-afk'`. Two independent failures
 * make the bare import wrong inside a plugin:
 *   1. Singleton identity — the skill registry is a module-level singleton
 *      (`src/skills/index.ts`). A plugin that imports its OWN copy of the package
 *      calls a `registerSkill` backed by a DIFFERENT registry than the host
 *      reads, so the skill silently never appears.
 *   2. Resolution — a marketplace-cloned plugin has NO `node_modules`, so a bare
 *      `import 'agent-afk'` does not resolve at all and throws
 *      `ERR_MODULE_NOT_FOUND` at boot (verified empirically). This bites even the
 *      STATELESS helpers (`env`, the `paths` getters, `describeFailure`), which
 *      is precisely why they are injected here rather than imported directly.
 *
 * So every runtime VALUE a plugin needs is passed in: the registry trio +
 * `loadSkillPrompts` (identity-critical) plus `env`, `SubagentManager`,
 * `describeFailure`, `discoverPluginSkillBodies`, the session-facet substrate
 * (`getOrDeriveFacet`, `listSessionIds`, `deriveSessionFacet`,
 * `loadStoredSession`), and the `paths` getters (resolution-critical). Type-only
 * imports are erased at build, so a plugin may
 * still `import type { … } from 'agent-afk'` via a build-time devDependency. The
 * shape is derived via `typeof import(...)` so the injected signatures cannot
 * drift from their source modules.
 *
 * `registerHook` declares a handler once at process boot; the host installs it
 * on each subsequently created session registry (and the already constructed
 * REPL registry after activation). Only registration is exposed to plugins.
 */
export type PluginApi = Pick<
  typeof import('../../skills/skill-registry.js'),
  'registerSkill' | 'listSkills' | 'getSkill'
> &
  Pick<typeof import('../../skills/_lib/prompt-loader.js'), 'loadSkillPrompts'> &
  Pick<typeof import('../../config/env.js'), 'env'> &
  Pick<typeof import('../subagent.js'), 'SubagentManager'> &
  Pick<typeof import('../subagent/result.js'), 'describeFailure'> &
  Pick<typeof import('../tools/skill-bridge.js'), 'discoverPluginSkillBodies'> &
  Pick<
    typeof import('../facets/index.js'),
    'getOrDeriveFacet' | 'listSessionIds' | 'deriveSessionFacet' | 'loadStoredSession'
  > &
  Pick<
    typeof import('../../paths.js'),
    'getAgentFrameworkDir' | 'getSkillsDir' | 'getSessionsDir'
  > & {
    /**
     * Declare a handler to be installed on each future session registry.
     * Activation runs once per entrypoint path per process, not once per session;
     * handlers should use their context for session-specific state. Returns a
     * function removing the declaration from future registries. Optional for
     * hosts without hook support.
     */
    registerHook?: (
      event: HarnessHookEvent,
      handler: HookHandler,
      options?: RegisterOptions,
    ) => () => void;
  };

/**
 * Resolved-entrypoint paths already imported in this process. Dynamic `import()`
 * caches modules itself, but tracking here lets us skip redundant awaits when
 * the scanner is consulted multiple times per turn and keeps load deterministic.
 */
const loadedEntrypoints = new Set<string>();

const pluginHooks = new Set<{
  event: HarnessHookEvent;
  handler: HookHandler;
  options?: RegisterOptions;
}>();

/**
 * Keys from {@link RegisterOptions} that a plugin is allowed to set.
 * `longRunning: true` disables the per-handler timeout and is reserved for
 * first-party handlers that await human input (e.g. path-approval). Plugins
 * that set it would prevent session boot on a throw, violating the module
 * invariant at :10-11. All other unknown future options are also stripped.
 */
const PLUGIN_REGISTER_OPTION_ALLOWLIST = ['longRunning'] as const satisfies ReadonlyArray<keyof RegisterOptions>;
type PluginRegisterOptions = Omit<RegisterOptions, (typeof PLUGIN_REGISTER_OPTION_ALLOWLIST)[number]>;

/**
 * Filter plugin-supplied {@link RegisterOptions} to the allowed subset.
 * `longRunning` is stripped: it disables the per-handler timeout and must
 * never be set by untrusted plugin code.
 */
function sanitizePluginOptions(options: RegisterOptions | undefined): PluginRegisterOptions | undefined {
  if (options === undefined) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { longRunning: _stripped, ...safe } = options;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** Scoped capability injected into PluginApi at process boot. */
export const registerPluginHook: NonNullable<PluginApi['registerHook']> = (event, handler, options) => {
  const safeOptions = sanitizePluginOptions(options);
  const declaration = { event, handler, ...(safeOptions !== undefined ? { options: safeOptions } : {}) };
  pluginHooks.add(declaration);
  return () => { pluginHooks.delete(declaration); };
};

/**
 * Install declarations on a newly built session registry before session
 * construction. Each plugin handler is wrapped in error isolation: a throw
 * from a plugin hook is caught, logged, and treated as a no-op `{}` result.
 * This upholds the module invariant (:10-11): a misbehaving plugin must never
 * abort session boot.
 */
export function installPluginHooks(registry: HookRegistry): void {
  for (const { event, handler, options } of pluginHooks) {
    const isolated: typeof handler = async (ctx) => {
      try {
        return await (handler as (c: typeof ctx) => Promise<ReturnType<typeof handler>>)(ctx);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[plugin-hook] handler threw — degrading to no-op', err);
        return {};
      }
    };
    registry.register(event, isolated, options);
  }
}

/** Clear the loaded-entrypoint set and plugin-hook declarations. For tests only. */
export function _resetLoadedEntrypoints(): void {
  loadedEntrypoints.clear();
  pluginHooks.clear();
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

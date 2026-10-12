/**
 * Executor-tree scope spreads (#3442) for {@link wireExecutors}. Extracted
 * from wire-executors.ts (function-size ceiling). Every spread is conditional
 * so an absent option stays an absent key: with all three options undefined
 * the wired executors are byte-identical to the pre-#3442 wiring.
 */
import type { HookRegistry } from '../hooks.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';

interface ScopeOptions {
  pluginConfigs?: SdkPluginConfig[];
  skillAllowlist?: readonly string[];
  hookRegistry?: HookRegistry;
}

/** `{ hookRegistry }` when set, else `{}`. */
export function hookRegistryOpt(opts: Pick<ScopeOptions, 'hookRegistry'>): Pick<ScopeOptions, 'hookRegistry'> {
  return opts.hookRegistry !== undefined ? { hookRegistry: opts.hookRegistry } : {};
}

/** The root `skill` executor's scope fields: plugin source, allowlist, hooks. */
export function skillScopeOpts(opts: ScopeOptions): ScopeOptions {
  return {
    ...(opts.pluginConfigs !== undefined ? { pluginConfigs: opts.pluginConfigs } : {}),
    ...(opts.skillAllowlist !== undefined ? { skillAllowlist: opts.skillAllowlist } : {}),
    ...hookRegistryOpt(opts),
  };
}

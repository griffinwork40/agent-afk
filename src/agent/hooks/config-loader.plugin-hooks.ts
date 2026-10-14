import type { HarnessHookEvent } from '../hooks.js';
import { getJsonConfigPath } from '../../paths.js';
import type { ResolvedHooksConfig } from './config-loader.js';
import { loadHooksConfigFile } from './config-loader.js';

interface LoadPluginHookConfigsOptions {
  pluginConfigs: Array<{ path: string; pluginRoot: string; pluginName: string | null; pluginKey: string | null }>;
  pluginHooksEnabled: boolean;
  validEvents: HarnessHookEvent[];
  merged: ResolvedHooksConfig;
  allSources: string[];
  allWarnings: string[];
}

export function loadPluginHookConfigs(opts: LoadPluginHookConfigsOptions): void {
  const { pluginConfigs, pluginHooksEnabled, validEvents, merged, allSources, allWarnings } = opts;
  if (pluginConfigs.length > 0 && !pluginHooksEnabled) {
    allWarnings.push(
      `found ${pluginConfigs.length} plugin hooks.json file(s) but plugin hooks are disabled; ` +
        `set "enablePluginHooks": true in ${getJsonConfigPath()} to run them`,
    );
  }
  if (!pluginHooksEnabled) return;
  for (const { path, pluginRoot, pluginName, pluginKey } of pluginConfigs) {
    const result = loadHooksConfigFile(path, 'plugin', pluginRoot, pluginName, pluginKey);
    for (const src of result.sources) {
      if (!allSources.includes(src)) allSources.push(src);
    }
    for (const w of result.warnings) allWarnings.push(w);
    for (const event of validEvents) {
      const incoming = result.hooks[event];
      if (incoming === undefined || incoming.length === 0) continue;
      const existing = merged[event];
      merged[event] = existing === undefined ? [...incoming] : [...existing, ...incoming];
    }
  }
}

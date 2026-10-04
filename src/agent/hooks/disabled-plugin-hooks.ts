/**
 * Helpers for the `disabledPluginHooks` user-global config key.
 *
 * `disabledPluginHooks` lets users suppress individual plugin hooks without
 * editing the plugin's `hooks.json`. Each key is a plugin name (the `name`
 * field from `plugin.json`), and each value is an array of specifiers of the
 * form `"<Event>"` or `"<Event>:<matcher>"` matching what the plugin registers.
 *
 * Like `pluginHookEnv`, this key is only read from user-global config files —
 * a project-local `afk.config.json` cannot silence a plugin hook on a user's
 * behalf.
 *
 * @module agent/hooks/disabled-plugin-hooks
 */

/**
 * Parse the raw `disabledPluginHooks` value from a config file object.
 *
 * Returns an empty object when the key is absent, null, or malformed. Any
 * per-plugin entry that is not an array of strings is skipped with a warning
 * pushed to `warnings`.
 */
export function parseDisabledPluginHooks(
  file: Record<string, unknown>,
  path: string,
  warnings: string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const raw = file['disabledPluginHooks'];
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`hooks config at ${path}: "disabledPluginHooks" must be an object — ignored`);
    return result;
  }
  for (const [pluginKey, rawSpecs] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rawSpecs)) {
      warnings.push(
        `hooks config at ${path}: disabledPluginHooks["${pluginKey}"] must be an array — ignored`,
      );
      continue;
    }
    const specs: string[] = [];
    for (const v of rawSpecs) {
      if (typeof v === 'string' && v.trim().length > 0) {
        specs.push(v.trim());
      }
    }
    result[pluginKey] = specs;
  }
  return result;
}

/**
 * Merge two `disabledPluginHooks` maps into a single map.
 *
 * For each plugin key present in `incoming`, its specifiers are unioned into
 * `target` (no duplicates). Called during the first-pass (user-global layers
 * only) in `loadHooksConfig`.
 */
export function mergeDisabledPluginHooks(
  target: Record<string, string[]>,
  incoming: Record<string, string[]>,
): void {
  for (const [pn, specs] of Object.entries(incoming)) {
    const existing = target[pn];
    if (existing === undefined) {
      target[pn] = [...specs];
    } else {
      for (const s of specs) {
        if (!existing.includes(s)) existing.push(s);
      }
    }
  }
}

/**
 * Return true when a plugin hook group (identified by its event + matcher)
 * has been suppressed via `disabledPluginHooks` in the user-global config.
 *
 * Specifier format (as stored in `disabledPluginHooks[pluginName]`):
 *   - `"<Event>"` — suppresses ALL groups for that event on the plugin.
 *   - `"<Event>:<matcher>"` — suppresses only the group whose `matcher`
 *     field equals `<matcher>` (exact string comparison; `undefined` matcher
 *     matches the literal string `"undefined"`).
 *
 * Called at hook-registration time (once per group) inside
 * `loadAndRegisterConfigHooks` — not at dispatch time.
 */
export function isPluginHookDisabled(
  disabledPluginHooks: Record<string, string[]>,
  pluginName: string,
  event: string,
  matcher: string | undefined,
): boolean {
  const specs = disabledPluginHooks[pluginName];
  if (specs === undefined || specs.length === 0) return false;
  for (const spec of specs) {
    const colon = spec.indexOf(':');
    if (colon === -1) {
      // "<Event>" form — match on event only.
      if (spec === event) return true;
    } else {
      // "<Event>:<matcher>" form — match both.
      const specEvent = spec.slice(0, colon);
      const specMatcher = spec.slice(colon + 1);
      if (specEvent === event && specMatcher === String(matcher)) return true;
    }
  }
  return false;
}

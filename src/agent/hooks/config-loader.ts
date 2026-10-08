/**
 * Config-driven shell-hook loader.
 *
 * Reads hook definitions from up to four layered config files (user-global
 * `afk.config.json`, user-global `settings.json`, project-local
 * `afk.config.json`, project-local `settings.json`) and merges them into a
 * single {@link LoadedHooksConfig} ready for {@link loadAndRegisterConfigHooks}.
 *
 * Layer order (lowest → highest priority, hooks concatenated in this order):
 *   0. `~/.afk/config/afk.config.json`     user-global primary config
 *   1. `~/.afk/config/settings.json`        user-global supplemental settings
 *   2. `<cwd>/afk.config.json`              project-local primary config
 *   3. `<cwd>/.afk/settings.json`           project-local supplemental settings
 *
 * Trust gate: `enableShellHooks: true` only activates shell hooks when it
 * appears in a user-global file (layers 0 or 1). Setting it in a project-local
 * file is silently ignored — this prevents cloned repos from auto-executing
 * arbitrary scripts without the user opting in globally.
 *
 * Project-local hook security: hooks from project-local layers (2 and 3) are
 * tagged with `tier: 'project-local'` and excluded from the merged output
 * unless the user-global config explicitly sets `allowProjectHooks: true`.
 * This prevents a malicious `afk.config.json` in a cloned repo from running
 * arbitrary commands once the user has globally opted into shell hooks.
 *
 * Plugin-contributed hooks (Claude Code compatibility): installed plugins may
 * ship a `<plugin>/hooks/hooks.json` (the Claude Code layout). These are
 * discovered under `~/.afk/plugins/`, tagged `tier: 'plugin'`, and merged
 * LAST. Because they execute third-party code, they sit behind their OWN
 * user-global trust gate, `enablePluginHooks: true` — independent of
 * `enableShellHooks` (which governs the user's own `afk.config.json` hooks).
 * Only `command`-type entries are honored; other Claude Code hook types
 * (`http`, `mcp_tool`, `prompt`, `agent`) are skipped with a warning.
 *
 * @module agent/hooks/config-loader
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAfkHome, getJsonConfigPath, getSettingsPath, getProjectSettingsPath, getPluginsDir } from '../../paths.js';
import { indexKeyForPath, scanLocalPlugins } from '../plugins-scanner.js';
import { readPluginManifest } from '../plugins/plugin-manifest.js';
import type { HarnessHookEvent } from '../hooks.js';
import { HOOK_HANDLER_TIMEOUT_MS } from '../hook-registry.js';
import { errorMessage } from '../../utils/errors.js';
import { parseDisabledPluginHooks, mergeDisabledPluginHooks } from './disabled-plugin-hooks.js';
import { loadPluginHookConfigs } from './config-loader.plugin-hooks.js';
export { compileMatcher, CLAUDE_CODE_ALIASES } from './matcher.js';
export { isPluginHookDisabled } from './disabled-plugin-hooks.js';

// ---------------------------------------------------------------------------
// Raw shapes (as they appear on disk)
// ---------------------------------------------------------------------------

export interface RawCommandHook {
  type: 'command';
  command: string;
  timeout_ms?: number;
  /** Claude Code field: seconds. Honored when `timeout_ms` is absent. */
  timeout?: number;
}

/** Union type for hook entries; extensible for future hook types. */
export type RawHook = RawCommandHook;

export interface RawMatcherGroup {
  /** Tool-name matcher: undefined / "*" = any, exact string, or "/regex/[flags]". */
  matcher?: string;
  hooks: RawHook[];
}

/** Shape of the `hooks` key in any config file. */
export type RawHooksConfig = Partial<Record<HarnessHookEvent, RawMatcherGroup[]>>;

// ---------------------------------------------------------------------------
// Resolved shapes (post-validation, camelCased)
// ---------------------------------------------------------------------------

export interface ResolvedCommandHook {
  type: 'command';
  command: string;
  timeoutMs: number;
  /**
   * Absolute plugin root, set only for hooks sourced from a plugin's
   * `hooks/hooks.json`. Threaded into the executor as `CLAUDE_PLUGIN_ROOT`
   * (and `CLAUDE_PROJECT_DIR`) so plugin hook commands that reference
   * `${CLAUDE_PLUGIN_ROOT}` resolve their bundled script paths. Undefined for
   * user-global / project-local config hooks.
   */
  pluginRoot?: string;
  /**
   * Canonical plugin name (from `.claude-plugin/plugin.json` `name` field),
   * set only for hooks sourced from an installed plugin. Used to look up the
   * per-plugin env allowlist (`pluginHookEnv` in `afk.config.json`) so only
   * the correct plugin's hook subprocess receives user-listed secrets.
   * Undefined for user-global / project-local config hooks.
   */
  pluginName?: string;
  /** Install/index key used in `.index.json` for options and plugin data. */
  pluginKey?: string;
}

export interface ResolvedMatcherGroup {
  matcher?: string;
  hooks: ResolvedCommandHook[];
  /**
   * Provenance: which config layer this group came from.
   * Always populated by {@link loadHooksConfigFile}; optional so external
   * callers (e.g. tests constructing synthetic configs) don't need to set it.
   */
  tier?: 'user-global' | 'project-local' | 'plugin';
}

export type ResolvedHooksConfig = Partial<Record<HarnessHookEvent, ResolvedMatcherGroup[]>>;

export interface LoadedHooksConfig {
  hooks: ResolvedHooksConfig;
  /**
   * True iff `enableShellHooks: true` was found in a user-global file
   * (Layer 0 or Layer 1). Project-local files cannot satisfy this gate.
   */
  userGlobalEnabled: boolean;
  /**
   * True iff `allowProjectHooks: true` was found in a user-global file.
   * When false (the default), hooks sourced from project-local layers
   * (layers 2 and 3) are silently dropped before registration, preventing
   * a cloned repo's `afk.config.json` from executing arbitrary commands.
   */
  allowProjectHooks: boolean;
  /**
   * True iff `enablePluginHooks: true` was found in a user-global file.
   * When false (the default), hooks discovered in plugin `hooks/hooks.json`
   * files are excluded from the merged output. This is an independent gate
   * from `userGlobalEnabled` (`enableShellHooks`): plugin hooks are
   * third-party code and get their own explicit opt-in.
   */
  pluginHooksEnabled: boolean;
  /**
   * Per-plugin env allowlist from `afk.config.json → pluginHookEnv`.
   * Maps plugin name → array of env-var names the user has explicitly listed
   * for forwarding to that plugin's hook subprocesses. Only user-global files
   * (layers 0 and 1) are consulted; last-writer-wins per plugin name.
   * Empty object when not configured.
   */
  pluginHookEnv: Record<string, string[]>;
  /**
   * Per-plugin hook disable list from `afk.config.json → disabledPluginHooks`.
   * Maps plugin name (the `name` field from `plugin.json`) → array of hook
   * specifiers to suppress. Each specifier is either `"<Event>"` (suppresses
   * all hooks for that event) or `"<Event>:<matcher>"` (suppresses only groups
   * whose `matcher` field equals the given string). Only user-global files
   * (layers 0 and 1) are consulted; entries are merged across layers.
   * Empty object when not configured.
   */
  disabledPluginHooks: Record<string, string[]>;
  /** Absolute paths of every file that contributed to this config. */
  sources: string[];
  /** Non-fatal validation warnings the caller should surface. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Single-file loader
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
// Invariant: timeout_ms is clamped to HOOK_HANDLER_TIMEOUT_MS, the registry's
// per-handler dispatch ceiling. Each config hook runs inside a HookHandler that
// hook-registry.ts races against that ceiling, so a larger timeout_ms could
// never take full effect: the handler would be abandoned at the registry
// timeout while the spawned child kept running until the executor's own
// (longer) timer fired — an orphaned subprocess and a 30s→timeout_ms window
// where the hook had "timed out" but its process was still alive. Clamping
// keeps the executor's SIGKILL deadline aligned with the registry ceiling, so
// there is no orphan window and the documented cap matches reality.

interface SingleFileResult {
  hooks: ResolvedHooksConfig;
  enableShellHooks: boolean;
  allowProjectHooks: boolean;
  enablePluginHooks: boolean;
  pluginHookEnv: Record<string, string[]>;
  disabledPluginHooks: Record<string, string[]>;
  sources: string[];
  warnings: string[];
}

function validateHook(raw: unknown): ResolvedCommandHook | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj['type'] !== 'command') return null;
  if (typeof obj['command'] !== 'string' || obj['command'].length === 0) {
    return null;
  }
  // timeout_ms wins; fall back to timeout (seconds, Claude Code field) × 1000;
  // both default to DEFAULT_TIMEOUT_MS when absent or non-positive.
  let rawTimeout: number;
  if (typeof obj['timeout_ms'] === 'number' && obj['timeout_ms'] > 0) {
    rawTimeout = obj['timeout_ms'];
  } else if (typeof obj['timeout'] === 'number' && obj['timeout'] > 0) {
    rawTimeout = obj['timeout'] * 1_000;
  } else {
    rawTimeout = DEFAULT_TIMEOUT_MS;
  }
  // Clamp to the registry's per-handler ceiling — see DEFAULT_TIMEOUT_MS note.
  const timeoutMs = Math.min(rawTimeout, HOOK_HANDLER_TIMEOUT_MS);
  return { type: 'command', command: obj['command'], timeoutMs };
}

/**
 * Read and validate a single config file. Missing file returns empty result
 * (not an error). Parse or schema errors are returned as warnings; they
 * never throw.
 */
export function loadHooksConfigFile(
  path: string,
  tier: 'user-global' | 'project-local' | 'plugin',
  pluginRoot?: string,
  pluginName?: string | null,
  pluginKey?: string | null,
): SingleFileResult {
  const warnings: string[] = [];
  const sources: string[] = [];
  const hooks: ResolvedHooksConfig = {};

  const emptyPluginHookEnv: Record<string, string[]> = {};
  const emptyDisabledPluginHooks: Record<string, string[]> = {};

  if (!existsSync(path)) {
    return { hooks, enableShellHooks: false, allowProjectHooks: false, enablePluginHooks: false, pluginHookEnv: emptyPluginHookEnv, disabledPluginHooks: emptyDisabledPluginHooks, sources, warnings };
  }
  sources.push(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    const msg = errorMessage(err);
    warnings.push(`hooks config at ${path}: parse error — ${msg}`);
    return { hooks, enableShellHooks: false, allowProjectHooks: false, enablePluginHooks: false, pluginHookEnv: emptyPluginHookEnv, disabledPluginHooks: emptyDisabledPluginHooks, sources, warnings };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`hooks config at ${path}: top-level must be an object`);
    return { hooks, enableShellHooks: false, allowProjectHooks: false, enablePluginHooks: false, pluginHookEnv: emptyPluginHookEnv, disabledPluginHooks: emptyDisabledPluginHooks, sources, warnings };
  }
  const file = parsed as Record<string, unknown>;

  // Extract enableShellHooks and allowProjectHooks.
  // allowProjectHooks is only meaningful in user-global files (tier check is
  // enforced by the caller, loadHooksConfig) but we parse it unconditionally
  // so the value flows cleanly.
  const enableShellHooks = file['enableShellHooks'] === true;
  const allowProjectHooks = file['allowProjectHooks'] === true;
  const enablePluginHooks = file['enablePluginHooks'] === true;

  // Parse pluginHookEnv: Record<pluginName, string[]>. Only meaningful in
  // user-global files (enforced by loadHooksConfig). Tolerates malformed values
  // by warning and falling through to an empty map for that plugin entry.
  const pluginHookEnv: Record<string, string[]> = {};
  const rawPhe = file['pluginHookEnv'];
  if (rawPhe !== undefined && rawPhe !== null) {
    if (typeof rawPhe !== 'object' || Array.isArray(rawPhe)) {
      warnings.push(`hooks config at ${path}: "pluginHookEnv" must be an object — ignored`);
    } else {
      for (const [pluginKey, rawVars] of Object.entries(rawPhe as Record<string, unknown>)) {
        if (!Array.isArray(rawVars)) {
          warnings.push(
            `hooks config at ${path}: pluginHookEnv["${pluginKey}"] must be an array — ignored`,
          );
          continue;
        }
        const vars: string[] = [];
        for (const v of rawVars) {
          if (typeof v === 'string' && v.trim().length > 0) {
            vars.push(v.trim());
          }
        }
        pluginHookEnv[pluginKey] = vars;
      }
    }
  }

  // Parse disabledPluginHooks: Record<pluginName, string[]>. Only meaningful
  // in user-global files (enforced by loadHooksConfig). Delegated to the
  // sibling helper so the parse logic and the disable-check logic live together.
  const disabledPluginHooks = parseDisabledPluginHooks(file, path, warnings);

  // Extract hooks block
  const rawHooks = file['hooks'];
  if (rawHooks === undefined || rawHooks === null) {
    return { hooks, enableShellHooks, allowProjectHooks, enablePluginHooks, pluginHookEnv, disabledPluginHooks, sources, warnings };
  }
  if (typeof rawHooks !== 'object' || Array.isArray(rawHooks)) {
    warnings.push(`hooks config at ${path}: "hooks" must be an object`);
    return { hooks, enableShellHooks, allowProjectHooks, enablePluginHooks, pluginHookEnv, disabledPluginHooks, sources, warnings };
  }

  const rawHooksObj = rawHooks as Record<string, unknown>;
  const validEvents: HarnessHookEvent[] = [
    'SessionStart',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostToolUseFailure',
    'Stop',
    'UserPromptSubmit',
  ];

  for (const event of validEvents) {
    const rawGroups = rawHooksObj[event];
    if (rawGroups === undefined) continue;
    if (!Array.isArray(rawGroups)) {
      warnings.push(`hooks config at ${path}: hooks.${event} must be an array`);
      continue;
    }
    const resolvedGroups: ResolvedMatcherGroup[] = [];
    for (let gi = 0; gi < rawGroups.length; gi++) {
      const rawGroup = rawGroups[gi];
      if (rawGroup === null || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) {
        warnings.push(`hooks config at ${path}: hooks.${event}[${gi}] must be an object — skipping`);
        continue;
      }
      const groupObj = rawGroup as Record<string, unknown>;
      const matcher =
        typeof groupObj['matcher'] === 'string' ? groupObj['matcher'] : undefined;
      if (!Array.isArray(groupObj['hooks'])) {
        warnings.push(
          `hooks config at ${path}: hooks.${event}[${gi}].hooks must be an array — skipping`,
        );
        continue;
      }
      const rawHookEntries = groupObj['hooks'] as unknown[];
      const resolvedHooks: ResolvedCommandHook[] = [];
      for (let hi = 0; hi < rawHookEntries.length; hi++) {
        const rawHookEntry = rawHookEntries[hi];
        const validated = validateHook(rawHookEntry);
        if (validated === null) {
          // Distinguish a well-formed but UNSUPPORTED hook type (Claude Code
          // also ships http/mcp_tool/prompt/agent hooks; AFK honors only
          // `command`) from a genuinely malformed entry — so a plugin author
          // gets an accurate reason rather than a misleading "malformed".
          const rawType =
            rawHookEntry !== null && typeof rawHookEntry === 'object' && !Array.isArray(rawHookEntry)
              ? (rawHookEntry as Record<string, unknown>)['type']
              : undefined;
          const reason =
            typeof rawType === 'string' && rawType !== 'command'
              ? `has unsupported hook type "${rawType}" (only "command" is honored)`
              : 'is malformed (must have type="command" and non-empty command)';
          warnings.push(
            `hooks config at ${path}: hooks.${event}[${gi}].hooks[${hi}] ${reason} — skipping`,
          );
          continue;
        }
        if (pluginRoot !== undefined) validated.pluginRoot = pluginRoot;
        if (pluginName != null) validated.pluginName = pluginName;
        if (pluginKey != null) validated.pluginKey = pluginKey;
        resolvedHooks.push(validated);
      }
      if (resolvedHooks.length > 0) {
        resolvedGroups.push({
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: resolvedHooks,
          tier,
        });
      }
    }
    if (resolvedGroups.length > 0) {
      hooks[event] = resolvedGroups;
    }
  }

  return { hooks, enableShellHooks, allowProjectHooks, enablePluginHooks, pluginHookEnv, disabledPluginHooks, sources, warnings };
}

// ---------------------------------------------------------------------------
// Plugin-contributed hook discovery (Claude Code compatibility)
// ---------------------------------------------------------------------------

/**
 * Discover every plugin-contributed `hooks/hooks.json` under `~/.afk/plugins/`.
 *
 * Enumeration is delegated to {@link scanLocalPlugins} — the single source of
 * truth for "which plugins are installed and enabled" — so hook discovery
 * inherits its enabled-index (`.index.json`) filtering (disabled and
 * uninstalled marketplace-cache plugins contribute no hooks) and its symlink
 * following (local installs are symlinked into the plugins root). A plugin
 * contributes hooks when it ships `<plugin>/hooks/hooks.json` (the Claude Code
 * layout). Returns `{ path, pluginRoot, pluginName, pluginKey }` triples;
 * `pluginRoot` is the plugin's install directory, `pluginName` is the
 * manifest name used for `pluginHookEnv`, and `pluginKey` is the install/index
 * key used for userConfig options and plugin data. Missing root → `[]`.
 */
export function discoverPluginHooksConfigs(
  pluginsRoot: string = getPluginsDir(),
): Array<{ path: string; pluginRoot: string; pluginName: string | null; pluginKey: string | null }> {
  if (!existsSync(pluginsRoot)) return [];
  const out: Array<{ path: string; pluginRoot: string; pluginName: string | null; pluginKey: string | null }> = [];
  // Reuse scanLocalPlugins (index-honoring, symlink-following, realpath-keyed)
  // rather than a bespoke walk — see PR 607 review: a private walk diverged on
  // all three, running disabled/uninstalled plugins' hooks while dropping
  // symlinked local plugins' hooks.
  for (const plugin of scanLocalPlugins(pluginsRoot)) {
    const hooksJson = join(plugin.path, 'hooks', 'hooks.json');
    if (existsSync(hooksJson)) {
      const manifest = readPluginManifest(plugin.path);
      const keyInfo = indexKeyForPath(pluginsRoot, plugin.path);
      const pluginKey = keyInfo?.key ?? indexKeyForPath(pluginsRoot, hooksJson)?.key ?? null;
      out.push({
        path: hooksJson,
        pluginRoot: plugin.path,
        pluginName: manifest.name,
        pluginKey,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layered loader
// ---------------------------------------------------------------------------

export interface LoadHooksConfigOptions {
  /** Working directory for project-local layers. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Plugins root to scan for `<plugin>/hooks/hooks.json`. Defaults to
   * `getPluginsDir()` (`~/.afk/plugins/`). Injectable for tests.
   */
  pluginsDir?: string;
}

/**
 * Load and merge hook configs from all four layers.
 *
 * Arrays for the same event are concatenated in discovery order
 * (user-global first, project-local last). Project-local hooks are only
 * included when the user-global config explicitly sets
 * `allowProjectHooks: true` — this prevents a cloned repo from silently
 * auto-executing shell commands once the user has globally enabled hooks.
 *
 * Duplicate layer paths (which occur when `cwd` equals the AFK config dir)
 * are deduplicated before loading so hooks from an overlapping path are
 * never concatenated twice.
 */
export function loadHooksConfig(opts: LoadHooksConfigOptions = {}): LoadedHooksConfig {
  const cwd = opts.cwd ?? process.cwd();
  const allSources: string[] = [];
  const allWarnings: string[] = [];
  const merged: ResolvedHooksConfig = {};
  let userGlobalEnabled = false;
  let allowProjectHooks = false;
  let pluginHooksEnabled = false;
  // Collected from user-global layers only. Later-layer entries overwrite
  // earlier ones for the same plugin name (last-writer-wins per key).
  const mergedPluginHookEnv: Record<string, string[]> = {};
  // Collected from user-global layers only. Entries are merged: same plugin
  // key across multiple layers unions the specifier lists (no duplicates).
  const mergedDisabledPluginHooks: Record<string, string[]> = {};

  const allLayers: Array<{ path: string; tier: 'user-global' | 'project-local' }> = [
    { path: getJsonConfigPath(), tier: 'user-global' },
    { path: getSettingsPath(), tier: 'user-global' },
    { path: join(cwd, 'afk.config.json'), tier: 'project-local' },
    { path: getProjectSettingsPath(cwd), tier: 'project-local' },
  ];

  // F9: deduplicate layers by path so hooks from an overlapping path
  // (e.g. when cwd === ~/.afk/config) are never concatenated twice.
  const seenPaths = new Set<string>();
  const layers = allLayers.filter((layer) => {
    if (seenPaths.has(layer.path)) return false;
    seenPaths.add(layer.path);
    return true;
  });

  // Misplacement guard: a settings file at the AFK-home ROOT
  // (`~/.afk/settings.json`) is NOT a config source — the user-global
  // supplemental layer lives at `~/.afk/config/settings.json` (layer 1).
  // A root-level file is otherwise a silent no-op (found in the wild holding
  // a dead SubagentStop hook shim the owner believed was active), so surface
  // the misplacement through the warnings channel instead of ignoring it.
  try {
    const orphanSettings = join(getAfkHome(), 'settings.json');
    if (!seenPaths.has(orphanSettings) && existsSync(orphanSettings)) {
      allWarnings.push(
        `found ${orphanSettings} but AFK does not read settings from the AFK-home root; ` +
          `user-global hooks/settings belong in ${getSettingsPath()} — the root file is ignored`,
      );
    }
  } catch {
    // Probe failure must never affect config loading.
  }

  // First pass (user-global layers only): determine trust flags before
  // deciding which project-local hooks to admit. Also collect pluginHookEnv
  // from user-global layers — it is only honoured from those layers so a
  // project-local afk.config.json cannot grant itself access to the user's
  // secrets (same security model as enableShellHooks/enablePluginHooks).
  for (const layer of layers) {
    if (layer.tier !== 'user-global') continue;
    const result = loadHooksConfigFile(layer.path, layer.tier);
    if (result.enableShellHooks) userGlobalEnabled = true;
    if (result.allowProjectHooks) allowProjectHooks = true;
    if (result.enablePluginHooks) pluginHooksEnabled = true;
    // Merge per-plugin env allowlists (last-writer-wins per plugin name).
    for (const [pn, vars] of Object.entries(result.pluginHookEnv)) {
      mergedPluginHookEnv[pn] = vars;
    }
    // Merge disabled plugin hook specifiers (union across layers, no duplicates).
    mergeDisabledPluginHooks(mergedDisabledPluginHooks, result.disabledPluginHooks);
  }

  // Second pass: load all layers and concatenate hooks, filtering out
  // project-local groups when allowProjectHooks is not set.
  const validEvents: HarnessHookEvent[] = [
    'SessionStart',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop',
    'PreToolUse',
    'PostToolUse',
    'PreCompact',
    'PostToolUseFailure',
    'Stop',
    'UserPromptSubmit',
  ];

  for (const layer of layers) {
    const result = loadHooksConfigFile(layer.path, layer.tier);
    for (const src of result.sources) {
      if (!allSources.includes(src)) allSources.push(src);
    }
    for (const w of result.warnings) allWarnings.push(w);

    // Security gate: drop project-local hooks unless the user-global
    // config has explicitly opted in via allowProjectHooks: true.
    if (layer.tier === 'project-local' && !allowProjectHooks) {
      continue;
    }

    for (const event of validEvents) {
      const incoming = result.hooks[event];
      if (incoming === undefined || incoming.length === 0) continue;
      const existing = merged[event];
      if (existing === undefined) {
        merged[event] = [...incoming];
      } else {
        merged[event] = [...existing, ...incoming];
      }
    }
  }

  // Third pass: plugin-contributed hooks (Claude Code compat). Discovered from
  // installed plugins under the plugins root, tagged `tier: 'plugin'`, merged
  // last. Gated by the independent `enablePluginHooks` trust flag — plugin
  // hooks execute third-party code, so they never ride on `enableShellHooks`.
  loadPluginHookConfigs({
    pluginConfigs: discoverPluginHooksConfigs(opts.pluginsDir),
    pluginHooksEnabled,
    validEvents,
    merged,
    allSources,
    allWarnings,
  });

  return {
    hooks: merged,
    userGlobalEnabled,
    allowProjectHooks,
    pluginHooksEnabled,
    pluginHookEnv: mergedPluginHookEnv,
    disabledPluginHooks: mergedDisabledPluginHooks,
    sources: allSources,
    warnings: allWarnings,
  };
}

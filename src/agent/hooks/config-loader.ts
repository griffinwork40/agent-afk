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
 * @module agent/hooks/config-loader
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getJsonConfigPath, getSettingsPath, getProjectSettingsPath } from '../../paths.js';
import type { HarnessHookEvent } from '../hooks.js';
import { HOOK_HANDLER_TIMEOUT_MS } from '../hook-registry.js';

// ---------------------------------------------------------------------------
// Raw shapes (as they appear on disk)
// ---------------------------------------------------------------------------

export interface RawCommandHook {
  type: 'command';
  command: string;
  timeout_ms?: number;
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
}

export interface ResolvedMatcherGroup {
  matcher?: string;
  hooks: ResolvedCommandHook[];
  /**
   * Provenance: which config layer this group came from.
   * Always populated by {@link loadHooksConfigFile}; optional so external
   * callers (e.g. tests constructing synthetic configs) don't need to set it.
   */
  tier?: 'user-global' | 'project-local';
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

/**
 * Compile a matcher string into a predicate that tests a tool name.
 *
 * - `undefined` or `"*"` → always true
 * - `"/regex/[flags]"` → compiled as `RegExp`
 * - any other string → strict equality
 */
export function compileMatcher(matcher: string | undefined): (toolName: string) => boolean {
  if (matcher === undefined || matcher === '*') return () => true;

  // Regex syntax: /pattern/ or /pattern/flags
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(matcher);
  if (regexMatch !== null) {
    const pattern = regexMatch[1]!;
    const flags = regexMatch[2]!;
    try {
      // Strip g/y flags before constructing the RegExp. Both are stateful:
      // they advance `lastIndex` on each re.test() call, so a reused instance
      // (cached once per group in config-bridge) would alternate true/false on
      // successive invocations of the same tool. i/m/s/u are stateless and safe.
      const safeFlags = flags.replace(/[gy]/g, '');
      const re = new RegExp(pattern, safeFlags);
      return (toolName: string) => re.test(toolName);
    } catch {
      // Malformed regex — fall through to exact-match
    }
  }

  return (toolName: string) => toolName === matcher;
}

interface SingleFileResult {
  hooks: ResolvedHooksConfig;
  enableShellHooks: boolean;
  allowProjectHooks: boolean;
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
  const rawTimeout =
    typeof obj['timeout_ms'] === 'number' && obj['timeout_ms'] > 0
      ? obj['timeout_ms']
      : DEFAULT_TIMEOUT_MS;
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
  tier: 'user-global' | 'project-local',
): SingleFileResult {
  const warnings: string[] = [];
  const sources: string[] = [];
  const hooks: ResolvedHooksConfig = {};

  if (!existsSync(path)) {
    return { hooks, enableShellHooks: false, allowProjectHooks: false, sources, warnings };
  }
  sources.push(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`hooks config at ${path}: parse error — ${msg}`);
    return { hooks, enableShellHooks: false, allowProjectHooks: false, sources, warnings };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`hooks config at ${path}: top-level must be an object`);
    return { hooks, enableShellHooks: false, allowProjectHooks: false, sources, warnings };
  }
  const file = parsed as Record<string, unknown>;

  // Extract enableShellHooks and allowProjectHooks.
  // allowProjectHooks is only meaningful in user-global files (tier check is
  // enforced by the caller, loadHooksConfig) but we parse it unconditionally
  // so the value flows cleanly.
  const enableShellHooks = file['enableShellHooks'] === true;
  const allowProjectHooks = file['allowProjectHooks'] === true;

  // Extract hooks block
  const rawHooks = file['hooks'];
  if (rawHooks === undefined || rawHooks === null) {
    return { hooks, enableShellHooks, allowProjectHooks, sources, warnings };
  }
  if (typeof rawHooks !== 'object' || Array.isArray(rawHooks)) {
    warnings.push(`hooks config at ${path}: "hooks" must be an object`);
    return { hooks, enableShellHooks, allowProjectHooks, sources, warnings };
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
        const validated = validateHook(rawHookEntries[hi]);
        if (validated === null) {
          warnings.push(
            `hooks config at ${path}: hooks.${event}[${gi}].hooks[${hi}] is malformed (must have type="command" and non-empty command) — skipping`,
          );
          continue;
        }
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

  return { hooks, enableShellHooks, allowProjectHooks, sources, warnings };
}

// ---------------------------------------------------------------------------
// Layered loader
// ---------------------------------------------------------------------------

export interface LoadHooksConfigOptions {
  /** Working directory for project-local layers. Defaults to `process.cwd()`. */
  cwd?: string;
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

  // First pass (user-global layers only): determine trust flags before
  // deciding which project-local hooks to admit.
  for (const layer of layers) {
    if (layer.tier !== 'user-global') continue;
    const result = loadHooksConfigFile(layer.path, layer.tier);
    if (result.enableShellHooks) userGlobalEnabled = true;
    if (result.allowProjectHooks) allowProjectHooks = true;
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

  return {
    hooks: merged,
    userGlobalEnabled,
    allowProjectHooks,
    sources: allSources,
    warnings: allWarnings,
  };
}

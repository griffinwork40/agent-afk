/**
 * Loader for `~/.afk/config/mcp.json` — the MCP server registry.
 *
 * Layered override (later wins, merged per-server-name):
 *   0. plugin-contributed `<plugin>/.claude-plugin/mcp.json`  lowest priority
 *   1. `~/.afk/config/mcp.json`                               user-global
 *   2. `<cwd>/.mcp.json`                                      project-local
 *   3. CLI `--mcp-config <path>`                              highest priority
 *
 * The CLI override **merges** like the other layers (highest-priority wins
 * on per-server-name conflict). To run with a clean override, pass an empty
 * `mcpServers: {}` in the user-global file and put everything in the
 * `--mcp-config` file.
 *
 * Validation policy:
 *   - Unknown top-level keys: ignored with a warning (forward-compat).
 *   - Malformed `mcpServers` entry (e.g. stdio with no `command`):
 *     skip the entry with a warning. Do NOT throw — a single broken
 *     server config must not block the rest.
 *   - Missing file or empty `{}`: returns `{ mcpServers: {} }`. Not an error.
 *
 * Conflict resolution: if two layers define the same server name, the
 * higher-priority layer wins outright (no field-level merge — server
 * configs are atomic). A warning is emitted naming the loser's path so
 * the user can locate the override.
 *
 * @module agent/mcp/config-loader
 */

import { env } from '../../config/env.js';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { getAfkConfigDir, getPluginsDir } from '../../paths.js';
import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';
import type { McpServerConfig } from './types.js';

/** Shape of `~/.afk/config/mcp.json`. */
export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export interface LoadedMcpConfig {
  /** Validated server map, ready to hand to `McpManager.fromConfig()`. */
  mcpServers: Record<string, McpServerConfig>;
  /** Source paths that contributed to this config (in load order). */
  sources: string[];
  /** Non-fatal validation warnings the caller should surface to the user. */
  warnings: string[];
}

/**
 * Default location for the user-global MCP config file.
 *
 * Exported so tests and the `/mcp` command can report the canonical path
 * even when the file does not exist yet.
 */
export function getMcpConfigPath(): string {
  return join(getAfkConfigDir(), 'mcp.json');
}

/**
 * Default location for the project-local MCP config file.
 *
 * Resolves against the caller's `cwd` so per-worktree configs are honored.
 * Exported for tests and the `/mcp` slash command (so it can show "from
 * <path>" alongside each server's source).
 *
 * Security (issue #571): returns `null` when `<cwd>/.mcp.json` exists but its
 * realpath escapes `cwd` — i.e. it is a symlink pointing out of the tree, or
 * resolves elsewhere via `..`. A project-local config must be a real file
 * inside the working directory; anything else is a path-confusion attempt and
 * is refused (fail-closed) rather than silently followed to an out-of-tree
 * target. A missing file returns the nominal path — the caller's `existsSync`
 * check then treats it as "no project-local layer".
 */
export function getProjectMcpConfigPath(cwd: string = process.cwd()): string | null {
  const nominal = join(cwd, '.mcp.json');
  if (!existsSync(nominal)) return nominal;
  try {
    // Invariant: realpath BOTH sides. On macOS a tmp/worktree cwd is itself
    // frequently a symlink (/var → /private/var), so the file's resolved path
    // must be compared against the resolved cwd — not the nominal one — or
    // legitimate in-tree configs would be falsely rejected. `relative()`
    // starting with `..` (or being absolute) means the target is out-of-tree.
    const realCwd = realpathSync(cwd);
    const realFile = realpathSync(nominal);
    const rel = relative(realCwd, realFile);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return nominal;
  } catch {
    // realpath failed (broken symlink, race, permissions) — fail closed.
    return null;
  }
}

/**
 * Discover every plugin-contributed `mcp.json` under `~/.afk/plugins/`.
 *
 * A plugin contributes an MCP config when it ships a
 * `<plugin>/.claude-plugin/mcp.json` file alongside the standard
 * `plugin.json` manifest. Plugin-contributed configs are merged at the
 * LOWEST priority so user configs always win.
 *
 * Walks the same two layouts as `scanLocalPlugins()`:
 *   - flat:  `<root>/<plugin>/.claude-plugin/mcp.json`
 *   - cache: `<root>/cache/<marketplace>/<plugin>/.claude-plugin/mcp.json`
 *
 * Up to {@link MAX_PLUGIN_SCAN_DEPTH} levels deep. Missing root is silently
 * ignored — the user simply has no plugins installed.
 */
const MAX_PLUGIN_SCAN_DEPTH = 5;

export function discoverPluginMcpConfigs(
  pluginsRoot: string = getPluginsDir(),
): string[] {
  if (!existsSync(pluginsRoot)) return [];
  const out: string[] = [];
  walkForPluginMcp(pluginsRoot, pluginsRoot, 0, out, new Set<string>());
  return out;
}

function walkForPluginMcp(
  root: string,
  dir: string,
  depth: number,
  out: string[],
  seen: Set<string>,
): void {
  if (depth > MAX_PLUGIN_SCAN_DEPTH) return;
  if (seen.has(dir)) return;
  seen.add(dir);

  // If this dir is a plugin (has plugin.json), check for sibling mcp.json
  // and stop descending — nested plugins are not a thing.
  const pluginJson = join(dir, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJson)) {
    const mcpJson = join(dir, '.claude-plugin', 'mcp.json');
    if (existsSync(mcpJson)) out.push(mcpJson);
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let s;
    try {
      s = lstatSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walkForPluginMcp(root, full, depth + 1, out, seen);
  }
}

/**
 * Validate a single server entry. Returns the entry (possibly with `type`
 * inferred) when valid, or a string error message when malformed.
 */
function validateServer(
  name: string,
  raw: unknown,
): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `server "${name}" must be an object` };
  }
  const obj = raw as Record<string, unknown>;

  // Infer type when omitted.
  let type = obj['type'] as McpServerConfig['type'] | undefined;
  if (type === undefined) {
    if (typeof obj['command'] === 'string') type = 'stdio';
    else if (typeof obj['url'] === 'string') type = 'streamable-http';
    else {
      return {
        ok: false,
        error: `server "${name}" has no \`command\` or \`url\`; cannot infer transport`,
      };
    }
  }

  if (type === 'stdio') {
    if (typeof obj['command'] !== 'string' || obj['command'].length === 0) {
      return { ok: false, error: `stdio server "${name}" requires non-empty \`command\`` };
    }
  } else if (type === 'streamable-http' || type === 'sse') {
    if (typeof obj['url'] !== 'string' || obj['url'].length === 0) {
      return { ok: false, error: `${type} server "${name}" requires non-empty \`url\`` };
    }
  } else {
    return { ok: false, error: `server "${name}" has unsupported \`type\`: ${String(type)}` };
  }

  const config: McpServerConfig = { type };
  if (typeof obj['command'] === 'string') config.command = obj['command'];
  if (Array.isArray(obj['args'])) {
    config.args = (obj['args'] as unknown[]).filter((a): a is string => typeof a === 'string');
  }
  if (obj['env'] !== undefined && typeof obj['env'] === 'object' && obj['env'] !== null) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj['env'] as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    config.env = env;
  }
  if (typeof obj['url'] === 'string') config.url = obj['url'];
  if (obj['headers'] !== undefined && typeof obj['headers'] === 'object' && obj['headers'] !== null) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj['headers'] as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
    config.headers = headers;
  }
  if (typeof obj['oauth'] === 'boolean') config.oauth = obj['oauth'];
  if (typeof obj['disabled'] === 'boolean') config.disabled = obj['disabled'];
  if (typeof obj['alwaysLoad'] === 'boolean') config.alwaysLoad = obj['alwaysLoad'];
  if (typeof obj['timeout'] === 'number' && obj['timeout'] > 0) {
    config.timeout = obj['timeout'];
  }
  return { ok: true, config };
}

/**
 * Read and validate the MCP config file at `path`. Missing file returns
 * `{ mcpServers: {}, warnings: [] }`. Parse or schema errors are returned
 * as warnings — never thrown — so a single broken server cannot block
 * session bootstrap.
 */
export function loadMcpConfigFile(path: string): LoadedMcpConfig {
  if (!existsSync(path)) {
    return { mcpServers: {}, sources: [], warnings: [] };
  }
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`mcp.json at ${path}: parse error — ${msg}`);
    return { mcpServers: {}, sources: [path], warnings };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`mcp.json at ${path}: top-level must be an object`);
    return { mcpServers: {}, sources: [path], warnings };
  }
  const file = parsed as McpConfigFile;
  const rawServers = file.mcpServers;
  if (rawServers === undefined || rawServers === null || typeof rawServers !== 'object') {
    return { mcpServers: {}, sources: [path], warnings };
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(rawServers)) {
    const result = validateServer(name, raw);
    if (result.ok) {
      mcpServers[name] = result.config;
    } else {
      warnings.push(`mcp.json at ${path}: skipping ${result.error}`);
    }
  }
  return { mcpServers, sources: [path], warnings };
}

/**
 * Options to control which layers contribute to the loaded config.
 *
 * All fields are optional — the zero-config call site (`loadMcpConfig()`)
 * picks up plugins + user-global + project-local from their default
 * locations and ignores the CLI override.
 */
export interface LoadMcpConfigOptions {
  /**
   * Working directory used to resolve `<cwd>/.mcp.json`. Defaults to
   * `process.cwd()`. Tests inject a tmp dir here.
   */
  cwd?: string;
  /**
   * Root to scan for plugin-contributed configs. Defaults to
   * `~/.afk/plugins/`. Tests inject a tmp dir; pass `null` to skip
   * plugin discovery entirely.
   */
  pluginsRoot?: string | null;
  /**
   * Path passed via `--mcp-config <path>`. When provided, this file is
   * loaded as the highest-priority layer (merged, not replacing).
   */
  cliOverride?: string;
  /**
   * When true, suppress the user-global layer. Used by `--mcp-config` paths
   * that want to run with a fully-isolated config. Defaults to false.
   */
  skipUserGlobal?: boolean;
  /**
   * When true, suppress the project-local layer. Defaults to false.
   */
  skipProjectLocal?: boolean;
  /**
   * JSON MCP config file paths imported from trusted source binaries (Claude
   * Code, etc.) via `importFrom`. Loaded as the LOWEST-priority layers (below
   * plugins), so AFK's own config always wins on per-server-name conflict.
   * Resolved by the caller (bootstrap) from `resolveImportedRoots()`; only
   * JSON-format configs are passed here — TOML sources are handled separately.
   */
  importedMcpConfigs?: string[];
}

/**
 * Source-tagged server entry — internal helper for conflict reporting.
 */
interface TaggedServer {
  config: McpServerConfig;
  source: string;
}

/**
 * Parse the `AFK_ALLOW_PROJECT_MCP` opt-in. Project-local `.mcp.json` servers
 * spawn arbitrary stdio commands on session start, so loading them is OPT-IN
 * (fail-closed): only an explicit truthy value grants consent. Mirrors the
 * `1|true|yes|on` idiom used elsewhere (browser/config.ts, providers/
 * openai-compatible/auth.ts). Unset, `0`, or any other value ⇒ do NOT load.
 */
function projectMcpOptIn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Sanitise + length-clamp an attacker-controlled label for a single-line
 * warning. Server names and commands in a project-local `.mcp.json` come from
 * an untrusted cwd; `sanitizeForDisplay` strips ANSI/OSC escapes and collapses
 * control bytes (incl. newlines) to spaces so a crafted value cannot forge or
 * line-break the warning, and the clamp bounds a pathologically long command.
 */
function safeLabel(s: string, maxLen: number): string {
  const clean = sanitizeForDisplay(s);
  return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
}

/**
 * Layered loader. Reads every layer in priority order (lowest first), then
 * folds them so the highest-priority layer wins on per-server-name
 * conflicts. Conflicts are reported as warnings naming the displaced source.
 *
 * Constraint (semantic invariant): the merge order MUST be lowest → highest
 * priority so the final `mcpServers[name]` is the highest-priority entry.
 * Do not reorder without updating the conflict-reporting logic below.
 */
export function loadMcpConfig(opts: LoadMcpConfigOptions = {}): LoadedMcpConfig {
  const layers: { path: string; loaded: LoadedMcpConfig }[] = [];
  // Pre-warnings emitted during layer assembly (before allWarnings is declared).
  const preWarnings: string[] = [];

  // Layer -1 — imported from trusted source binaries (lowest priority of all).
  // Pushed before the plugin layer so AFK's own plugins/user/project/CLI
  // configs all win on per-server-name conflict.
  if (opts.importedMcpConfigs && opts.importedMcpConfigs.length > 0) {
    for (const p of opts.importedMcpConfigs) {
      layers.push({ path: p, loaded: loadMcpConfigFile(p) });
    }
  }

  // Layer 0 — plugin-contributed (lowest priority).
  if (opts.pluginsRoot !== null) {
    const pluginsRoot = opts.pluginsRoot;
    const pluginMcpPaths = pluginsRoot
      ? discoverPluginMcpConfigs(pluginsRoot)
      : discoverPluginMcpConfigs();
    for (const p of pluginMcpPaths) {
      layers.push({ path: p, loaded: loadMcpConfigFile(p) });
    }
  }

  // Layer 1 — user-global.
  if (!opts.skipUserGlobal) {
    const userPath = getMcpConfigPath();
    layers.push({ path: userPath, loaded: loadMcpConfigFile(userPath) });
  }

  // Layer 2 — project-local (issue #571: fail-closed, opt-IN).
  //
  // Invariant: a project-local <cwd>/.mcp.json spawns arbitrary stdio commands
  // on session start (StdioClientTransport → command+args), so cd-ing into an
  // untrusted repo must NOT auto-spawn anything. This layer loads ONLY when the
  // operator granted explicit consent via a truthy AFK_ALLOW_PROJECT_MCP. When
  // a .mcp.json exists but consent is absent, the servers are skipped and a
  // warning enumerates what WOULD have spawned (names + commands, sanitized —
  // they are attacker-controlled) plus the exact opt-in, so the operator can
  // decide with full information. A .mcp.json whose realpath escapes cwd
  // (symlink / `..`) is refused outright, regardless of consent.
  if (!opts.skipProjectLocal) {
    const projectPath = getProjectMcpConfigPath(opts.cwd);
    if (projectPath === null) {
      preWarnings.push(
        'mcp: refusing to load project-local .mcp.json — it resolves outside ' +
          'the working directory (symlink or path traversal).',
      );
    } else if (existsSync(projectPath)) {
      if (projectMcpOptIn(env.AFK_ALLOW_PROJECT_MCP)) {
        layers.push({ path: projectPath, loaded: loadMcpConfigFile(projectPath) });
        preWarnings.push(
          `mcp: loaded project-local config from ${projectPath} ` +
            '(AFK_ALLOW_PROJECT_MCP is set).',
        );
      } else {
        // Skip + inform: enumerate the servers that WOULD have spawned so the
        // operator can make an informed opt-in decision.
        const skipped = loadMcpConfigFile(projectPath);
        const entries = Object.entries(skipped.mcpServers);
        if (entries.length > 0) {
          const summary = entries
            .map(([name, cfg]) => {
              const cmd = cfg.command
                ? [cfg.command, ...(cfg.args ?? [])].join(' ')
                : (cfg.url ?? '(no transport)');
              return `${safeLabel(name, 64)} → ${safeLabel(cmd, 160)}`;
            })
            .join('; ');
          preWarnings.push(
            `mcp: skipped ${entries.length} project-local server(s) from ` +
              `${projectPath} — not spawned: [${summary}]. Set ` +
              `AFK_ALLOW_PROJECT_MCP=1 to load ` +
              `${entries.length === 1 ? 'it' : `these ${entries.length}`} if ` +
              'you trust this directory.',
          );
        }
      }
    }
  }

  // Layer 3 — CLI override (highest priority).
  if (opts.cliOverride !== undefined) {
    layers.push({
      path: opts.cliOverride,
      loaded: loadMcpConfigFile(opts.cliOverride),
    });
  }

  // Fold: higher-priority layers overwrite lower-priority entries.
  const winners = new Map<string, TaggedServer>();
  const allWarnings: string[] = [...preWarnings];
  const allSources: string[] = [];

  for (const layer of layers) {
    for (const w of layer.loaded.warnings) allWarnings.push(w);
    if (layer.loaded.sources.length > 0) {
      for (const src of layer.loaded.sources) {
        if (!allSources.includes(src)) allSources.push(src);
      }
    }
    for (const [name, config] of Object.entries(layer.loaded.mcpServers)) {
      const prior = winners.get(name);
      if (prior) {
        allWarnings.push(
          `mcp: server "${name}" defined in ${prior.source} is overridden by ${layer.path}`,
        );
      }
      winners.set(name, { config, source: layer.path });
    }
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, tagged] of winners) {
    mcpServers[name] = tagged.config;
  }

  return { mcpServers, sources: allSources, warnings: allWarnings };
}

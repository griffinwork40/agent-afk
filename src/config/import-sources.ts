/**
 * Cross-tool asset import — source maps, config parsing, and resolution.
 *
 * The trust unit for import is the *source binary* (claude-code, codex), not
 * the individual asset: a user opts into "trust everything Claude Code
 * installs" once via `importFrom` in afk.config.json, rather than reviewing
 * each plugin. This module owns the on-disk path knowledge for each known
 * binary so nothing else in AFK hardcodes a foreign path like
 * `~/.claude/plugins`.
 *
 * Layering: this is a NEUTRAL module (depends only on `paths.ts` + node
 * builtins). It is importable from both `src/agent/` (the scanners that
 * live-read imported roots) and `src/cli/` (the `afk migrate` command +
 * doctor check) without crossing the agent↛cli boundary. It deliberately
 * does NOT import `loadConfig()` (cli layer) or `readPluginManifest()` (agent
 * layer) — the small manifest-name read needed for detection is inlined.
 *
 * @module config/import-sources
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getJsonConfigPath, getLegacyJsonConfigPath } from '../paths.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Known source binaries AFK can import assets from. */
export type ImportSourceBinary = 'claude-code' | 'codex';

export const KNOWN_IMPORT_BINARIES: readonly ImportSourceBinary[] = ['claude-code', 'codex'];

/** Per-asset-type import toggles for a single trusted source binary. */
export interface ImportAssetToggles {
  /** Live-read the binary's plugin roots (`.claude-plugin/plugin.json` dirs). */
  plugins: boolean;
  /** Live-read the binary's `SKILL.md` skills. */
  skills: boolean;
  /**
   * Live-read the binary's MCP servers. Off by default even for a trusted
   * binary: MCP servers auto-run a `command`+`env` on session start, so this
   * is the sharpest edge and gets its own explicit opt-in.
   */
  mcp: boolean;
}

/**
 * Resolved `importFrom` config: which source binaries are trusted and which of
 * their asset types AFK should live-read. Absent binary key = not trusted (the
 * strict-opt-in default).
 */
export type ImportFromConfig = Partial<Record<ImportSourceBinary, ImportAssetToggles>>;

/** Origin tag for skills imported from a source binary (e.g. `imported:claude-code`). */
export type ImportedSkillOrigin = `imported:${ImportSourceBinary}`;

/** Format of a source binary's MCP config file. */
export type McpConfigFormat = 'json' | 'toml';

// ── Source path maps ───────────────────────────────────────────────────────

interface SourcePathMap {
  label: string;
  pluginRoots: (home: string) => string[];
  skillRoots: (home: string) => string[];
  /** Candidate MCP config paths in priority order — first existing wins. */
  mcpConfigCandidates: (home: string) => string[];
  mcpFormat: McpConfigFormat;
}

const SOURCE_MAPS: Record<ImportSourceBinary, SourcePathMap> = {
  'claude-code': {
    label: 'Claude Code',
    pluginRoots: (home) => [join(home, '.claude', 'plugins')],
    skillRoots: (home) => [join(home, '.claude', 'skills')],
    // Claude Code's MCP config path has varied across versions; probe the
    // known candidates and use the first that exists.
    mcpConfigCandidates: (home) => [
      join(home, '.claude', 'mcp.json'),
      join(home, '.claude', '.mcp.json'),
      join(home, '.claude', 'claude-code', 'mcp.json'),
    ],
    mcpFormat: 'json',
  },
  codex: {
    label: 'Codex',
    pluginRoots: (home) => [join(home, '.codex', 'plugins')],
    skillRoots: (home) => [join(home, '.codex', 'skills')],
    mcpConfigCandidates: (home) => [join(home, '.codex', 'config.toml')],
    mcpFormat: 'toml',
  },
};

/** Display labels keyed by binary, for CLI / doctor output. */
export const KNOWN_SOURCE_LABELS: Record<ImportSourceBinary, string> = {
  'claude-code': SOURCE_MAPS['claude-code'].label,
  codex: SOURCE_MAPS.codex.label,
};

const MAX_PLUGIN_SCAN_DEPTH = 5;

// ── Config parsing ─────────────────────────────────────────────────────────

/**
 * Defensively parse a raw `importFrom` block into the normalized
 * {@link ImportFromConfig}. Unknown binary keys are dropped; a bare `true`
 * expands to all-asset-types-on; an object's missing toggles default to
 * `false`. Returns `undefined` when nothing valid is found.
 */
export function parseImportFromConfig(raw: unknown): ImportFromConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: ImportFromConfig = {};
  for (const binary of KNOWN_IMPORT_BINARIES) {
    const val = (raw as Record<string, unknown>)[binary];
    if (val === undefined) continue;
    if (val === true) {
      out[binary] = { plugins: true, skills: true, mcp: true };
      continue;
    }
    if (val === false) continue; // explicit opt-out — same as absent
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      out[binary] = {
        plugins: obj['plugins'] === true,
        skills: obj['skills'] === true,
        mcp: obj['mcp'] === true,
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The config files `importFrom` is honored from: the user-global afk.config.json
 * (`$AFK_HOME/config/afk.config.json`) then the legacy `~/.afk.config.json`.
 * Deliberately EXCLUDES `<cwd>/afk.config.json` — see {@link loadImportFromConfig}.
 */
export function importFromConfigPaths(): string[] {
  return [getJsonConfigPath(), getLegacyJsonConfigPath()];
}

/**
 * Read + normalize the `importFrom` block from the user-global config, without
 * the full `loadConfig()` machinery — lets agent-layer scanners self-serve the
 * import config without importing the cli layer.
 *
 * Security invariant: `importFrom` authorizes AFK to live-read/execute another
 * tool's plugins+skills and auto-run its MCP servers, so it is honored ONLY
 * from the user-global config (written by the user via `afk migrate`), NEVER
 * from a project-local `<cwd>/afk.config.json` — a cloned repo must not be able
 * to silently enable foreign-asset import. Imported assets live in the user's
 * home dir and are cwd-independent, so per-repo scoping adds risk, not value.
 *
 * `configPaths` is injectable for tests. Returns `undefined` when none has a
 * valid `importFrom`.
 */
export function loadImportFromConfig(
  configPaths: readonly string[] = importFromConfigPaths(),
): ImportFromConfig | undefined {
  for (const p of configPaths) {
    if (!existsSync(p)) continue;
    try {
      const json = JSON.parse(readFileSync(p, 'utf-8')) as { importFrom?: unknown };
      const parsed = parseImportFromConfig(json.importFrom);
      if (parsed !== undefined) return parsed;
    } catch {
      // Unreadable / malformed config — silently skipped here (best-effort,
      // defensive). The CLI bootstrap's separate loadConfig() call surfaces a
      // warning on CLI surfaces, but agent-layer callers (skill-bridge,
      // builtin-skills) never invoke loadConfig(), so on those paths a malformed
      // user-global config is silently skipped with no signal.
    }
  }
  return undefined;
}

// ── Resolution (consumed by the scanners) ──────────────────────────────────

/** Resolved scan roots derived from a trusted `importFrom` config. */
export interface ResolvedImportRoots {
  /** Plugin dirs to scan with trust-all semantics (no AFK index required). */
  pluginRoots: string[];
  /** Skill dirs to scan, tagged with their per-binary import origin. */
  skillRoots: Array<{ dir: string; origin: ImportedSkillOrigin }>;
  /** MCP config files to load as lowest-priority layers. */
  mcpConfigs: Array<{ source: string; format: McpConfigFormat }>;
}

/**
 * Map a trusted `importFrom` config to concrete scan roots for the plugin,
 * skill, and MCP loaders. Only enabled asset types of trusted binaries
 * contribute, and only roots that exist on disk. `home` is injectable for
 * tests. Binaries are processed in {@link KNOWN_IMPORT_BINARIES} order so
 * cross-binary collisions resolve deterministically.
 */
export function resolveImportedRoots(
  config: ImportFromConfig | undefined,
  home: string = homedir(),
): ResolvedImportRoots {
  const out: ResolvedImportRoots = { pluginRoots: [], skillRoots: [], mcpConfigs: [] };
  if (!config) return out;
  for (const binary of KNOWN_IMPORT_BINARIES) {
    const toggles = config[binary];
    if (!toggles) continue;
    const map = SOURCE_MAPS[binary];
    if (toggles.plugins) {
      for (const root of map.pluginRoots(home)) {
        if (existsSync(root)) out.pluginRoots.push(root);
      }
    }
    if (toggles.skills) {
      const origin: ImportedSkillOrigin = `imported:${binary}`;
      for (const dir of map.skillRoots(home)) {
        if (existsSync(dir)) out.skillRoots.push({ dir, origin });
      }
    }
    if (toggles.mcp) {
      const mcpPath = firstExisting(map.mcpConfigCandidates(home));
      if (mcpPath) out.mcpConfigs.push({ source: mcpPath, format: map.mcpFormat });
    }
  }
  return out;
}

// ── Detection (consumed by `afk migrate` + doctor) ──────────────────────────

/** A discovered asset (plugin or skill) with its display name and source dir. */
export interface DetectedAsset {
  name: string;
  path: string;
}

/** An MCP server entry surfaced for review (command shown so the user sees what auto-runs). */
export interface DetectedMcpServer {
  name: string;
  /** Human-readable command summary, e.g. `npx -y @foo/server` or `https://…`. */
  command: string;
}

/** What a single source binary holds on disk, for `afk migrate` / doctor. */
export interface DetectedSource {
  binary: ImportSourceBinary;
  label: string;
  /** True when any of the binary's asset dirs/files exist. */
  present: boolean;
  plugins: DetectedAsset[];
  skills: DetectedAsset[];
  mcpServers: DetectedMcpServer[];
  mcpConfigPath: string | null;
  mcpFormat: McpConfigFormat;
}

/**
 * Detect which known source binaries are present and enumerate their assets.
 * `home` is injectable for tests; defaults to the real home directory. Missing
 * dirs/files degrade gracefully.
 */
export function detectSources(home: string = homedir()): DetectedSource[] {
  return KNOWN_IMPORT_BINARIES.map((binary) => detectOne(binary, home));
}

function detectOne(binary: ImportSourceBinary, home: string): DetectedSource {
  const map = SOURCE_MAPS[binary];
  const plugins: DetectedAsset[] = [];
  for (const root of map.pluginRoots(home)) plugins.push(...findPluginDirs(root));
  const skills: DetectedAsset[] = [];
  for (const root of map.skillRoots(home)) skills.push(...findSkillDirs(root));
  const mcpConfigPath = firstExisting(map.mcpConfigCandidates(home));
  const mcpServers = mcpConfigPath ? readMcpServers(mcpConfigPath, map.mcpFormat) : [];
  const present =
    plugins.length > 0 ||
    skills.length > 0 ||
    mcpConfigPath !== null ||
    map.pluginRoots(home).some(existsSync) ||
    map.skillRoots(home).some(existsSync);
  return { binary, label: map.label, present, plugins, skills, mcpServers, mcpConfigPath, mcpFormat: map.mcpFormat };
}

// ── helpers ──────────────────────────────────────────────────────────────

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Read a plugin manifest's `name` field. Inlined to avoid an agent-layer import. */
function manifestName(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')) as {
      name?: unknown;
    };
    return typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null;
  } catch {
    return null;
  }
}

function findPluginDirs(root: string): DetectedAsset[] {
  if (!existsSync(root)) return [];
  const out: DetectedAsset[] = [];
  walkPlugins(root, 0, out, new Set<string>());
  return out;
}

function walkPlugins(dir: string, depth: number, out: DetectedAsset[], seen: Set<string>): void {
  let canonical: string;
  try {
    canonical = realpathSync(dir);
  } catch {
    canonical = dir;
  }
  if (depth > MAX_PLUGIN_SCAN_DEPTH || seen.has(canonical)) return;
  seen.add(canonical);
  if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
    const name = manifestName(dir) ?? dir.split('/').filter(Boolean).pop() ?? dir;
    out.push({ name, path: dir });
    return; // plugins do not nest
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
    try {
      if (statSync(full).isDirectory()) walkPlugins(full, depth + 1, out, seen);
    } catch {
      // unreadable entry — skip
    }
  }
}

function findSkillDirs(root: string): DetectedAsset[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DetectedAsset[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (existsSync(join(root, entry.name, 'SKILL.md'))) {
      out.push({ name: entry.name, path: join(root, entry.name) });
    }
  }
  return out;
}

/**
 * Read MCP server names + command summaries from a config file. Supports the
 * JSON `mcpServers` object (Claude Code) and the TOML `[mcp_servers.<id>]`
 * table format (Codex), where the server name is the table key. Best-effort:
 * a parse failure returns [].
 */
export function readMcpServers(path: string, format: McpConfigFormat): DetectedMcpServer[] {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return format === 'json' ? readMcpServersJson(content) : readMcpServersToml(content);
}

function readMcpServersJson(content: string): DetectedMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const out: DetectedMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    out.push({ name, command: summarizeServerCommand(raw) });
  }
  return out;
}

/**
 * Parse the `[mcp_servers.<id>]` table format from a Codex `config.toml`.
 * The server name is the table key (e.g. `[mcp_servers.github]` → name "github").
 * Fields read per block: `command` (string), `args` (inline array of strings),
 * `url` (string). Command summary precedence: url → command+args joined → '(no command)'.
 * Deliberately narrow and dependency-free — ignores everything outside mcp_servers tables.
 */
function readMcpServersToml(content: string): DetectedMcpServer[] {
  const out: DetectedMcpServer[] = [];
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  let name: string | null = null;
  let command: string | null = null;
  let url: string | null = null;
  let args: string[] = [];

  const flush = (): void => {
    if (inBlock && name) {
      let summary: string;
      if (url !== null) {
        summary = url;
      } else if (command !== null) {
        summary = args.length > 0 ? [command, ...args].join(' ') : command;
      } else {
        summary = '(no command)';
      }
      out.push({ name, command: summary });
    }
    name = null;
    command = null;
    url = null;
    args = [];
  };

  const MCP_SERVER_HEADER = /^\[mcp_servers\.([^\]]+)\]\s*$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const headerMatch = MCP_SERVER_HEADER.exec(line);
    if (headerMatch) {
      flush();
      inBlock = true;
      name = headerMatch[1] ?? null;
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();

    if (key === 'command') {
      command = stripTomlString(stripInlineComment(rawValue));
    } else if (key === 'url') {
      url = stripTomlString(stripInlineComment(rawValue));
    } else if (key === 'args') {
      args = parseTomlInlineStringArray(rawValue);
    }
  }
  flush();
  return out;
}

/** Strip a trailing inline TOML comment (`# ...`) from a scalar value line.
 *  Only strips when the value does not start with a quote (quoted strings may
 *  contain # legitimately). Best-effort heuristic for narrow use. */
function stripInlineComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  const idx = value.indexOf(' #');
  return idx === -1 ? value : value.slice(0, idx).trimEnd();
}

/** Parse a TOML inline string array: `["-y", "pkg"]` → `['-y', 'pkg']`.
 *  Best-effort: strips surrounding `[ ]`, splits on commas, stripTomlString each.
 *  Returns [] on any parse failure. */
function parseTomlInlineStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return [];
  const inner = trimmed.slice(1, trimmed.lastIndexOf(']'));
  if (!inner.trim()) return [];
  try {
    return inner
      .split(',')
      .map((s) => stripTomlString(s.trim()))
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function stripTomlString(value: string): string {
  // Matched pair: strip surrounding quotes.
  const m = value.match(/^"([^"]*)"$/) ?? value.match(/^'([^']*)'$/);
  if (m && m[1] !== undefined) return m[1];
  // Unmatched leading/trailing quote (e.g. truncated value) — strip it.
  if (value.startsWith('"') || value.startsWith("'")) return value.slice(1);
  if (value.endsWith('"') || value.endsWith("'")) return value.slice(0, -1);
  return value;
}

function summarizeServerCommand(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '(invalid)';
  const obj = raw as Record<string, unknown>;
  if (typeof obj['url'] === 'string') return obj['url'];
  if (typeof obj['command'] === 'string') {
    const args = Array.isArray(obj['args'])
      ? (obj['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : [];
    return [obj['command'], ...args].join(' ');
  }
  return '(no command)';
}

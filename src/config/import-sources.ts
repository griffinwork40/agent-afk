import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { readMcpServers } from './import-mcp-discovery.js';
export { readMcpServers } from './import-mcp-discovery.js';
import { env } from './env.js';
import { readCodexEnabledPlugins } from './codex-discovery.js';
import { findPluginDirs } from './plugin-discovery.js';
import { getJsonConfigPath, getLegacyJsonConfigPath } from '../paths.js';
import { debugLog } from '../utils/debug.js';

/**
 * Cross-tool import configuration: resolves which external asset sources (claude-code,
 * codex) AFK trusts, defines per-binary source path maps (plugin roots, skill roots,
 * MCP config candidates), and exposes detection helpers consumed by `afk migrate` and
 * the doctor command. Security invariant: `importFrom` is only honored from the
 * user-global config — never from a project-local `<cwd>/afk.config.json`.
 */

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

/**
 * A source tool's OWN plugin enabled/disabled state, keyed in that tool's
 * native key format. For Claude Code the key is `<pluginName>@<marketplace>`
 * (from `~/.claude/settings.json` `enabledPlugins`). A key ABSENT from the map
 * means "no signal" — the scanner defaults such a plugin to enabled. An EMPTY
 * map (missing/malformed source config, or a binary with no plugin-enable
 * concept) disables nothing — fail-open by design.
 */
export type SourceEnabledMap = ReadonlyMap<string, boolean>;

/** Shared fail-open sentinel: no source signal ⇒ disables no plugins. */
const EMPTY_SOURCE_ENABLED: SourceEnabledMap = new Map();

// ── Source path maps ───────────────────────────────────────────────────────

interface SourcePathMap {
  label: string;
  pluginRoots: (home: string) => string[];
  skillRoots: (home: string) => string[];
  /** Candidate MCP config paths in priority order — first existing wins. */
  mcpConfigCandidates: (home: string) => string[];
  mcpFormat: McpConfigFormat;
  /**
   * Read the binary's OWN plugin enabled/disabled state (in its native key
   * format) so an imported-root scan can mirror it. Returns an empty map when
   * the binary exposes no such state or its config is missing/malformed.
   */
  pluginEnabledState: (home: string) => SourceEnabledMap;
}

/** Returns the Codex home directory: `CODEX_HOME` env override, or `~/.codex`. */
function codexHome(home: string): string {
  const override = env.CODEX_HOME?.trim();
  // Require an absolute path — a relative value would resolve against the process
  // cwd at runtime, which is unpredictable and almost certainly not the intent.
  if (override && isAbsolute(override)) return override;
  if (override) {
    debugLog(`[import-sources] CODEX_HOME="${override}" is not absolute — ignoring and falling back to ~/.codex`);
  }
  return join(home, '.codex');
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
    pluginEnabledState: (home) => readClaudeEnabledPlugins(home),
  },
  codex: {
    label: 'Codex',
    pluginRoots: (home) => [join(codexHome(home), 'plugins')],
    skillRoots: (home) => [join(codexHome(home), 'skills'), join(home, '.agents', 'skills')],
    mcpConfigCandidates: (home) => [join(codexHome(home), 'config.toml')],
    mcpFormat: 'toml',
    pluginEnabledState: (home) => readCodexEnabledPlugins(codexHome(home)),
  },
};

/** Display labels keyed by binary, for CLI / doctor output. */
export const KNOWN_SOURCE_LABELS: Record<ImportSourceBinary, string> = {
  'claude-code': SOURCE_MAPS['claude-code'].label,
  codex: SOURCE_MAPS.codex.label,
};



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
 * Load the first valid `importFrom` block found across the allowed config paths.
 *
 * Security invariant: `importFrom` is honored ONLY from the user-global config
 * (`$AFK_HOME/config/afk.config.json`) and the legacy `~/.afk.config.json`.
 * It is NEVER read from the project-local `<cwd>/afk.config.json` — a cloned
 * repo must never be able to silently enable foreign-asset or MCP-server import.
 * {@link importFromConfigPaths} enforces this by intentionally excluding the cwd config.
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
  /**
   * Plugin dirs to scan with trust-all semantics (no AFK index required),
   * each tagged with its source binary so the scanner can mirror that tool's
   * own enabled/disabled state via {@link readSourceEnabledState}.
   */
  pluginRoots: Array<{ dir: string; binary: ImportSourceBinary }>;
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
        if (existsSync(root)) out.pluginRoots.push({ dir: root, binary });
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

/**
 * Read a trusted source binary's OWN plugin enabled/disabled state so an
 * imported-root scan can mirror it — a plugin the user disabled in Claude Code
 * should not load in AFK. `home` is injectable for tests. Fail-open: any
 * missing/unreadable/malformed source config yields an empty map (disables
 * nothing). v1 implements `claude-code`; `codex` returns empty (its plugin
 * import is detection-only).
 */
export function readSourceEnabledState(
  binary: ImportSourceBinary,
  home: string = homedir(),
): SourceEnabledMap {
  return SOURCE_MAPS[binary].pluginEnabledState(home);
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

/**
 * Parse Claude Code's own plugin enable/disable state from
 * `~/.claude/settings.json` `enabledPlugins` — an object map of
 * `"<pluginName>@<marketplace>": boolean`. Only the user-global settings file
 * is consulted; project/local/managed scopes are deliberately out of scope
 * (AFK's import model is home-dir and cwd-independent). Fail-open: a missing
 * or malformed file, or a non-boolean value, contributes no signal.
 */
function readClaudeEnabledPlugins(home: string): SourceEnabledMap {
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return EMPTY_SOURCE_ENABLED;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return EMPTY_SOURCE_ENABLED;
  }
  if (!raw || typeof raw !== 'object') return EMPTY_SOURCE_ENABLED;
  const enabledPlugins = (raw as { enabledPlugins?: unknown }).enabledPlugins;
  if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)) {
    return EMPTY_SOURCE_ENABLED;
  }
  const map = new Map<string, boolean>();
  for (const [key, val] of Object.entries(enabledPlugins as Record<string, unknown>)) {
    if (typeof val === 'boolean') map.set(key, val);
  }
  return map;
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
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (existsSync(join(root, entry.name, 'SKILL.md'))) {
      out.push({ name: entry.name, path: join(root, entry.name) });
    }
  }
  return out;
}

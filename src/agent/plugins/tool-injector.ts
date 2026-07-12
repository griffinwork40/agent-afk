/**
 * Plugin tool extraction and injection for the anthropic-direct provider.
 *
 * The SDK subprocess handles plugin discovery and tool injection internally.
 * For the direct provider (which bypasses the SDK), we need to replicate this
 * functionality: discover plugins, extract tool definitions from SKILL.md files,
 * and inject them into the query.
 *
 * @module agent/plugins/tool-injector
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';
import { BUILTIN_TOOL_NAMES } from '../tools/schemas.js';
import { AWARENESS_TOOL_NAMES } from '../awareness/index.js';

/**
 * Metadata extracted from a skill's SKILL.md frontmatter, plus the body.
 */
export interface PluginSkillMetadata {
  name?: string;
  description?: string;
  argumentHint?: string;
  /**
   * Resolved tool allowlist parsed from the `tools:` frontmatter field.
   *
   * When present, only the listed tools are permitted for subagents dispatched
   * by this skill. Names are normalized to AFK canonical form (e.g. `Read` →
   * `read_file`, `Edit` → `edit_file`). Unknown tokens are dropped with a
   * stderr warning. When absent, the default `CHILD_ALLOWED_TOOLS` surface
   * applies unchanged (backward-compatible).
   */
  allowedTools?: string[];
  /**
   * Execution mode from the `context:` frontmatter field. The skill forks a
   * subagent ONLY when this is `'fork'`; absent/`'load'`/other values load the
   * body into the current session (the default since 2026-06; see
   * docs/skill-load-mode.md).
   */
  context?: string;
  /**
   * Read-only enforcement flag from the `read-only:` (or `readOnly:`)
   * frontmatter field. When `true`, a forked subagent for this skill is
   * built with the RECON tool allowlist (no `write_file`/`edit_file`) and a
   * bash-command guard that blocks mutating shell invocations. See
   * `nesting.ts` (`RECON_ALLOWED_TOOLS`, `DEFAULT_READ_ONLY_SKILLS`) and the
   * dispatcher's `readOnlyBash` gate.
   */
  readOnly?: boolean;
  /**
   * Per-skill model override from the `model:` frontmatter field. When present,
   * a forked subagent for this skill runs on this model instead of the session
   * default. Mirrors the registry-skill `model` field (see `SkillMetadata` in
   * `src/skills/index.ts`); the forked plugin path resolves
   * `model ?? defaultSubagentModel ?? defaultModel ?? 'sonnet'`. Absent → the
   * session-default resolution applies unchanged.
   */
  model?: string;
  /** Markdown content after the frontmatter closing `---`. */
  body?: string;
  /**
   * Tier gate for plugin-contributed skills. Mirrors `SkillMetadata.audience`
   * in `src/skills/index.ts`. Absent = 'public' (default visible).
   * 'internal' = hidden from end-user surfaces unless `AFK_INTERNAL=1`.
   * The skill-bridge consumes this in `collectSkillEntries()` so the
   * system-prompt manifest stays in lockstep with the slash-command surface.
   */
  audience?: 'public' | 'internal';
}

/**
 * Canonical mapping from legacy Claude Code tool aliases (case-insensitive)
 * to AFK tool names.
 *
 * Invariant: all values must be members of `BUILTIN_TOOL_NAMES` or the
 * orchestration tools (`agent`, `skill`). Entries map both the raw form and
 * a lowercase form so the lookup can be done on `.toLowerCase()` input.
 */
const LEGACY_TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  edit: 'edit_file',
  write: 'write_file',
  bash: 'bash',
  grep: 'grep',
  glob: 'glob',
  ls: 'list_directory',
  list: 'list_directory',
  webfetch: 'web_scrape',
  websearch: 'web_scrape',
  webbrowse: 'web_scrape',
};

/**
 * Normalize a raw frontmatter tool token to its canonical AFK name.
 *
 * 1. Strips surrounding whitespace.
 * 2. Tries the token as-is (already lowercase AFK names like `read_file` pass through).
 * 3. Falls back to the legacy alias map (case-insensitive).
 * 4. Returns `undefined` when the token is unrecognised — callers drop it and
 *    emit a warning rather than rejecting the whole skill.
 *
 * @param token  Raw tool token from frontmatter (e.g. `"Read"`, `"edit_file"`)
 * @param knownToolNames  Set of all valid tool names at normalisation time
 */
export function normalizeToolToken(
  token: string,
  knownToolNames: ReadonlySet<string>,
): string | undefined {
  const trimmed = token.trim();
  if (trimmed.length === 0) return undefined;

  // Direct match (AFK canonical names are already lowercase with underscores)
  if (knownToolNames.has(trimmed)) return trimmed;

  // Legacy alias lookup (case-insensitive)
  const alias = LEGACY_TOOL_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined && knownToolNames.has(alias)) return alias;

  return undefined;
}

/**
 * Parse a `tools:` frontmatter value into a list of raw tokens.
 *
 * Accepts two formats:
 * - Inline comma-separated string: `tools: Read, Grep, Glob`
 * - YAML sequence (one item per line, each prefixed with `- `):
 *   ```yaml
 *   tools:
 *     - Read
 *     - Grep
 *   ```
 *
 * Returns an empty array when the value is blank.
 *
 * @param inlineValue  The text after `tools:` on the same line (may be empty)
 * @param remainingLines  Lines following the `tools:` key in the frontmatter
 * @returns  Raw token strings (not yet normalised or validated)
 */
/**
 * Strip surrounding single or double quotes from a token.
 * Handles `"Read"` → `Read` and `'Read'` → `Read`.
 */
function stripQuotes(token: string): string {
  const t = token.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

export function parseToolsField(
  inlineValue: string,
  remainingLines: string[],
): string[] {
  const trimmedInline = inlineValue.trim();

  if (trimmedInline.length > 0) {
    // YAML flow-sequence form: `tools: [Read, Grep, Glob]`
    if (trimmedInline.startsWith('[') && trimmedInline.endsWith(']')) {
      const inner = trimmedInline.slice(1, -1);
      return inner
        .split(',')
        .map((t) => stripQuotes(t))
        .filter((t) => t.length > 0);
    }
    // Comma-separated inline form: `tools: Read, Grep, Glob`
    // Also handles quoted-string form: `tools: "Read, Grep"`
    const unquoted = stripQuotes(trimmedInline);
    return unquoted.split(',').map((t) => stripQuotes(t)).filter((t) => t.length > 0);
  }

  // YAML sequence form — consume leading lines that start with `- `
  const tokens: string[] = [];
  for (const line of remainingLines) {
    const stripped = line.trim();
    if (stripped.startsWith('- ')) {
      tokens.push(stripQuotes(stripped.slice(2)));
    } else {
      // First non-list-item line ends the sequence
      break;
    }
  }
  return tokens;
}

/**
 * Discover all SKILL.md files in a plugin directory and extract their metadata.
 * Recursively searches the plugin tree for SKILL.md files that have YAML frontmatter.
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @param knownToolNames - Optional set of valid tool names for `tools:` normalisation.
 *   When omitted the full built-in + orchestration set is used by default (lazy-loaded
 *   to avoid a hard circular-import cycle at module-load time).
 * @returns Array of discovered skill metadata
 */
export function extractPluginSkills(
  pluginPath: string,
  knownToolNames?: ReadonlySet<string>,
): PluginSkillMetadata[] {
  const skills: PluginSkillMetadata[] = [];

  function walkDirectory(dir: string, depth: number = 0): void {
    if (depth > 10) return; // Prevent infinite recursion
    if (!existsSync(dir)) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const fullPath = join(dir, name);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isFile() && name === 'SKILL.md') {
        const metadata = parseSkillMetadata(fullPath, knownToolNames);
        if (metadata.name) {
          skills.push(metadata);
        }
      } else if (stat.isDirectory()) {
        walkDirectory(fullPath, depth + 1);
      }
    }
  }

  walkDirectory(pluginPath);
  return skills;
}

/**
 * Parse YAML frontmatter from a SKILL.md file to extract skill metadata.
 *
 * Expects frontmatter in the format:
 * ```yaml
 * ---
 * name: skill-name
 * description: Brief description of the skill
 * argumentHint: "[optional arguments]"
 * tools: Read, Grep, Glob
 * ---
 * ```
 *
 * The `tools:` field may alternatively use YAML list syntax:
 * ```yaml
 * tools:
 *   - Read
 *   - Grep
 * ```
 *
 * @param skillPath - Absolute path to the SKILL.md file
 * @param knownToolNames - Set of valid AFK tool names used for normalisation.
 *   When omitted, `resolveKnownToolNames()` is called lazily.
 * @returns Extracted metadata (returns `{ name: undefined }` if parsing fails)
 */
function parseSkillMetadata(
  skillPath: string,
  knownToolNames?: ReadonlySet<string>,
): PluginSkillMetadata {
  try {
    const content = readFileSync(skillPath, 'utf-8');

    if (!content.startsWith('---\n')) {
      return {};
    }

    const afterFirstDashes = content.slice(4); // Skip "---\n"
    const endIdx = afterFirstDashes.indexOf('\n---');
    if (endIdx === -1) {
      return {};
    }

    const frontmatterText = afterFirstDashes.slice(0, endIdx);
    const bodyText = afterFirstDashes.slice(endIdx + 4).trim(); // Skip "\n---"
    const metadata: PluginSkillMetadata = {};

    const lines = frontmatterText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      if (key === 'name') {
        metadata.name = value.replace(/^["']|["']$/g, '');
      } else if (key === 'description') {
        metadata.description = value.replace(/^["']|["']$/g, '');
      } else if (key === 'argumentHint') {
        metadata.argumentHint = value.replace(/^["']|["']$/g, '');
      } else if (key === 'tools') {
        // Collect the lines after this one to handle YAML list form
        const remainingLines = lines.slice(i + 1);
        const rawTokens = parseToolsField(value, remainingLines);
        // Invariant: when `tools:` is PRESENT, we ALWAYS assign allowedTools — even
        // if the result is an empty array. This is the fail-closed contract: a
        // present-but-unparseable `tools:` MUST NOT silently fall through to the
        // full CHILD_ALLOWED_TOOLS surface. allowedTools = [] blocks all tools.
        // Absent `tools:` (branch never entered) → allowedTools stays undefined →
        // full CHILD_ALLOWED_TOOLS applies (backward compat unchanged).
        const resolved = resolveKnownToolNames(knownToolNames);
        const normalized: string[] = [];
        for (const token of rawTokens) {
          const canonical = normalizeToolToken(token, resolved);
          if (canonical !== undefined) {
            if (!normalized.includes(canonical)) {
              normalized.push(canonical);
            }
          } else {
            process.stderr.write(
              `[afk] plugin skill at ${skillPath}: unknown tool "${token}" in \`tools:\` frontmatter — ignored\n`,
            );
          }
        }
        if (normalized.length === 0 && rawTokens.length > 0) {
          process.stderr.write(
            `[afk] plugin skill at ${skillPath}: \`tools:\` declared but no valid tools resolved — subagent will be blocked from all tools\n`,
          );
        }
        metadata.allowedTools = normalized;
      } else if (key === 'audience') {
        // Only accept the two well-known values — anything else is dropped
        // (and the skill defaults to public) so a typo can't accidentally
        // hide a skill from end users.
        const raw = value.replace(/^["']|["']$/g, '');
        if (raw === 'public' || raw === 'internal') {
          metadata.audience = raw;
        }
      } else if (key === 'context') {
        metadata.context = value.replace(/^["']|["']$/g, '');
      } else if (key === 'read-only' || key === 'readOnly') {
        // Accept both the kebab (`read-only`) and camel (`readOnly`) spellings.
        // Only the literal string `true` opts in; any other value (or a typo)
        // leaves the skill read-write so a mistake can't silently strip the
        // child's write tools.
        const raw = value.replace(/^["']|["']$/g, '').trim();
        if (raw === 'true') metadata.readOnly = true;
      } else if (key === 'model') {
        // Per-skill model override. Strip surrounding quotes and only assign a
        // non-empty value so a bare `model:` line falls through to the session
        // default. No allow-list validation — an arbitrary id flows to
        // providerForModel()/the credential resolver exactly like the
        // registry-skill `model` field, which is also unvalidated.
        const raw = value.replace(/^["']|["']$/g, '').trim();
        if (raw.length > 0) metadata.model = raw;
      }
    }

    if (bodyText.length > 0) {
      metadata.body = bodyText;
    }

    return metadata;
  } catch {
    return {};
  }
}

/**
 * Return the effective set of known tool names for `tools:` token normalisation.
 *
 * When the caller provides an explicit set (tests, custom surfaces) it is used
 * as-is. Otherwise `BUILTIN_TOOL_NAMES` (statically imported from schemas.ts)
 * plus the orchestration tool names are used as the default.
 */
function resolveKnownToolNames(
  provided?: ReadonlySet<string>,
): ReadonlySet<string> {
  if (provided !== undefined) return provided;
  // 'memory_search' and 'get_runtime_state' (via AWARENESS_TOOL_NAMES) are in
  // CHILD_ALLOWED_TOOLS but NOT in BUILTIN_TOOL_NAMES — skills that list them
  // must be able to resolve them. 'memory_update' and 'procedure_write' are
  // intentionally excluded (blast-radius too large for unsupervised writes).
  // 'compose' is excluded from CHILD_ALLOWED_TOOLS (unbounded fan-out) and is
  // not grantable to child sessions — accepting it produces a phantom allowlist entry.
  return new Set([...BUILTIN_TOOL_NAMES, ...AWARENESS_TOOL_NAMES, 'memory_search', 'agent', 'skill']);
}

/**
 * Convert a skill into an Anthropic tool definition.
 *
 * Skills are CLI-side constructs that dispatch to subagents. In the context
 * of the direct provider, we expose them as tools that allow the model to
 * invoke skills via the subagent execution system.
 *
 * The tool schema is generic: skill name, description, and optional arguments.
 *
 * @param skill - Skill metadata
 * @param pluginName - Name of the plugin containing the skill
 * @returns Anthropic tool definition
 */
function skillToToolDef(skill: PluginSkillMetadata, pluginName: string): AnthropicToolDef {
  const skillName = skill.name || 'unknown-skill';
  return {
    name: `plugin_${pluginName}_${skillName}`.replace(/[^a-z0-9_]/g, '_').toLowerCase(),
    description:
      skill.description ||
      `Invoke the ${skillName} skill from the ${pluginName} plugin.`,
    input_schema: {
      type: 'object',
      properties: {
        arguments: {
          type: 'string',
          description: skill.argumentHint || 'Arguments to pass to the skill',
        },
      },
      required: [],
    },
  };
}

/**
 * Extract all tool definitions from a plugin.
 *
 * Discovers all SKILL.md files within the plugin and converts them to
 * Anthropic tool definitions.
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @param pluginName - Name of the plugin (for tool naming)
 * @returns Array of Anthropic tool definitions
 */
export function extractPluginTools(pluginPath: string, pluginName: string): AnthropicToolDef[] {
  const skills = extractPluginSkills(pluginPath);
  return skills.map((skill) => skillToToolDef(skill, pluginName));
}

/**
 * Extract all tool definitions from a set of plugins.
 *
 * @param plugins - Array of plugin configurations
 * @returns Array of Anthropic tool definitions from all plugins
 */
export function extractAllPluginTools(plugins: SdkPluginConfig[]): AnthropicToolDef[] {
  const allTools: AnthropicToolDef[] = [];

  for (const plugin of plugins) {
    if (plugin.type !== 'local') continue;
    const pluginName = extractPluginName(plugin.path);
    const tools = extractPluginTools(plugin.path, pluginName);
    allTools.push(...tools);
  }

  return allTools;
}

/**
 * Extract the plugin name from its directory path.
 *
 * Handles both flat layouts (`~/.afk/plugins/<name>/`) and marketplace
 * cache layouts (`~/.afk/plugins/cache/<marketplace>/<plugin>/<version>/`).
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @returns Plugin name derived from the path
 */
export function extractPluginName(pluginPath: string): string {
  const parts = pluginPath.split('/').filter(Boolean);
  if (parts.length === 0) return 'unknown';

  // Marketplace cache layout: ~/.afk/plugins/cache/<marketplace>/<plugin>/<version>
  // Find 'cache' in the path and extract <plugin> at cacheIndex + 2.
  const cacheIdx = parts.indexOf('cache');
  if (cacheIdx !== -1 && cacheIdx + 2 < parts.length) {
    const pluginName = parts[cacheIdx + 2];
    if (pluginName) return pluginName;
  }

  // Flat layout: use the last component
  const lastName = parts[parts.length - 1];
  return lastName ?? 'unknown';
}

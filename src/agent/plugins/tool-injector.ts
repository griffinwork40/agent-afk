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
import { debugLog } from '../../utils/debug.js';

/**
 * Metadata extracted from a skill's SKILL.md frontmatter, plus the body.
 */
export interface PluginSkillMetadata {
  name?: string;
  description?: string;
  argumentHint?: string;
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
   * Enumerated tool allowlist from the `tools:` frontmatter field. When set,
   * the forked subagent receives exactly this tool surface. Validated against
   * BUILTIN_TOOL_NAMES at parse time; unknown names are silently dropped.
   * Takes no effect when `readOnly: true` (RECON_ALLOWED_TOOLS takes precedence).
   * Only applies to `context: fork` skills — loaded skills run in the caller's context.
   */
  allowedTools?: string[];
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
 * Discover all SKILL.md files in a plugin directory and extract their metadata.
 * Recursively searches the plugin tree for SKILL.md files that have YAML frontmatter.
 *
 * @param pluginPath - Absolute path to the plugin directory
 * @returns Array of discovered skill metadata
 */
export function extractPluginSkills(pluginPath: string): PluginSkillMetadata[] {
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
        const metadata = parseSkillMetadata(fullPath);
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
 * ---
 * ```
 *
 * @param skillPath - Absolute path to the SKILL.md file
 * @returns Extracted metadata (returns `{ name: undefined }` if parsing fails)
 */
function parseSkillMetadata(skillPath: string): PluginSkillMetadata {
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
    for (const line of lines) {
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
      } else if (key === 'tools') {
        // Parse both inline-string (`tools: read_file, grep`) and
        // inline YAML sequence (`tools: [read_file, grep]`) forms.
        // Block-form (`- read_file\n- grep`) is out of scope — the scanner
        // does not support multi-line values.
        const raw = value.replace(/^["']|["']$/g, '');
        const stripped = raw.replace(/^\[|\]$/g, ''); // strip bracket-array wrapper
        const tokens = stripped.split(',').map((t) => t.trim()).filter(Boolean);
        const validSet = new Set(BUILTIN_TOOL_NAMES);
        const filtered: string[] = [];
        for (const token of tokens) {
          if (validSet.has(token)) {
            filtered.push(token);
          } else {
            debugLog(`[tool-injector] parseSkillMetadata: unknown tool name in tools: "${token}" — dropped`);
          }
        }
        const deduped = [...new Set(filtered)];
        if (deduped.length > 0) {
          metadata.allowedTools = deduped;
        }
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

/**
 * Named-agent registry: discovery, precedence, and load.
 *
 * Scopes and precedence (ascending — later shadows earlier on the same name):
 *
 *   builtin                          (programmatic; see builtins.ts)
 *   plugin   <plugin>/agents/        (installed plugins; namespaced <plugin>:<agent>)
 *   user     ~/.afk/agents/          (all projects on this machine)
 *   project  <cwd>/.claude/agents/   (Claude Code compat, read-only)
 *   project  <cwd>/.afk/agents/      (AFK-native project scope)
 *   config   AgentSessionConfig.agents (programmatic per-session injection)
 *
 * Plugin agents are discovered by `discoverPluginAgents` (skill-bridge.ts) and
 * passed in via {@link LoadAgentRegistryOptions.pluginAgents}; they merge just
 * above the builtins. Because they are namespaced `<plugin>:<agent>` they never
 * collide with a bare builtin name (e.g. the plugin agent
 * `example-plugin:research-agent` coexists with the builtin `research-agent`),
 * so bundled skills that dispatch bare `subagent_type: "research-agent"` keep
 * resolving to the builtin.
 *
 * Directories are scanned recursively for `*.md` files. Identity comes from
 * the frontmatter `name` field, not the filename (Claude Code parity). A
 * duplicate name within one directory keeps the first file found and warns; a
 * name defined in both project directories (.claude/agents and .afk/agents)
 * warns on override (.afk wins); a duplicate across different scopes
 * (user/project/config) shadows silently by design (higher scope wins).
 *
 * Loading is synchronous and session-static — called once at bootstrap
 * (mirrors the plugins scan), then threaded by reference through executor
 * nesting. Scan failures are contained per-file: one malformed agent never
 * blocks the rest.
 *
 * @module agent/agents/registry
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getAfkHome } from '../../paths.js';
import type { AgentDefinition } from '../types/sdk-types.js';
import { parseAgentMarkdown } from './parser.js';
import { builtinAgents } from './builtins.js';
import type { AgentRegistry, AgentSource, RegisteredAgent } from './types.js';

/** Maximum recursion depth for agent-directory scans (defense against cycles). */
const MAX_SCAN_DEPTH = 5;

export interface LoadAgentRegistryOptions {
  /**
   * Project root for the project scope (`.afk/agents/`, `.claude/agents/`).
   * Defaults to `process.cwd()`. Pass the worktree root for `-w` sessions.
   */
  cwd?: string;
  /**
   * Programmatic definitions (from `AgentSessionConfig.agents`). Highest
   * precedence — mirrors Claude Code's `--agents` CLI tier sitting above
   * file scopes.
   */
  configAgents?: Record<string, AgentDefinition>;
  /**
   * Agents contributed by installed plugins, pre-scanned + namespaced
   * `<plugin>:<agent>` by `discoverPluginAgents` (skill-bridge.ts). Merged just
   * above the builtins (lowest file scope, Claude Code parity). Kept as a
   * caller-supplied array — not scanned here — so this module stays free of the
   * plugin-scanner import and the registry load stays a pure merge.
   */
  pluginAgents?: RegisteredAgent[];
  /**
   * Diagnostic sink for scan warnings (malformed files, duplicate names,
   * unknown frontmatter). Defaults to stderr, matching the plugin skill
   * scanner's convention. Pass a no-op to silence.
   */
  warn?: (message: string) => void;
}

/**
 * Recursively collect `*.md` file paths under `dir`. Missing dir → []. Skips
 * dotfiles/dirs, caps recursion at {@link MAX_SCAN_DEPTH}, returns sorted for
 * deterministic same-scope ordering. Exported so the plugin-agent scanner
 * (`discoverPluginAgents`) reuses the exact same traversal semantics.
 */
export function collectMarkdownFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // scope directory absent — the common case
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files.sort(); // deterministic same-scope ordering across platforms
}

/**
 * Scan one directory scope and merge its agents into `registry`.
 * Same-directory duplicates keep the first file (sorted order) and warn;
 * cross-scope duplicates shadow the lower scope silently (by design).
 *
 * `crossDirSeen`, when supplied, is shared across the directories of a single
 * scope tier (the project tier spans .claude/agents + .afk/agents). It only
 * drives a warning when a name appears in more than one of those dirs — the
 * later directory still wins (registry.set overwrites), so precedence is
 * unchanged; the warning just makes the otherwise-silent override visible.
 */
function scanScope(
  registry: Map<string, RegisteredAgent>,
  dir: string,
  source: AgentSource,
  warn: (message: string) => void,
  crossDirSeen?: Map<string, string>,
): void {
  const seenInScope = new Map<string, string>(); // name → filePath (this directory)
  for (const filePath of collectMarkdownFiles(dir)) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      warn(`[afk] agents: cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseAgentMarkdown(content, (msg) => warn(`[afk] agents: ${filePath}: ${msg}`));
    if (parsed === undefined) continue;

    const priorInScope = seenInScope.get(parsed.name);
    if (priorInScope !== undefined) {
      warn(
        `[afk] agents: duplicate agent name ${JSON.stringify(parsed.name)} in ${source} scope — ` +
          `keeping ${priorInScope}, ignoring ${filePath}`,
      );
      continue;
    }
    seenInScope.set(parsed.name, filePath);

    // Cross-directory override within the same tier (e.g. the same name in
    // both .claude/agents and .afk/agents — both 'project' scope). The later
    // directory wins by design; warn so the shadow is not silent.
    if (crossDirSeen !== undefined) {
      const priorInTier = crossDirSeen.get(parsed.name);
      if (priorInTier !== undefined) {
        warn(
          `[afk] agents: duplicate agent name ${JSON.stringify(parsed.name)} in ${source} scope — ` +
            `${filePath} overrides ${priorInTier}`,
        );
      }
      crossDirSeen.set(parsed.name, filePath);
    }

    registry.set(parsed.name, {
      name: parsed.name,
      definition: parsed.definition,
      source,
      filePath,
      ...(parsed.bashReadOnly === true ? { bashReadOnly: true } : {}),
      ...(parsed.ignoredKeys !== undefined ? { ignoredKeys: parsed.ignoredKeys } : {}),
    });

    if (parsed.ignoredKeys !== undefined && parsed.ignoredKeys.length > 0) {
      warn(
        `[afk] agents: ${filePath}: frontmatter field(s) not honored by AFK yet: ` +
          parsed.ignoredKeys.join(', '),
      );
    }
  }
}

/**
 * Load the full named-agent registry for a session.
 *
 * Synchronous by design — called from session bootstrap paths that are
 * already doing sync scans (plugins). Never throws: scan problems degrade to
 * warnings and a smaller registry.
 */
export function loadAgentRegistry(options: LoadAgentRegistryOptions = {}): AgentRegistry {
  const cwd = options.cwd ?? process.cwd();
  const warn = options.warn ?? ((message: string) => process.stderr.write(message + '\n'));

  const registry = new Map<string, RegisteredAgent>(builtinAgents());

  // plugin scope (namespaced <plugin>:<agent>; between builtin and user).
  // Pre-scanned + first-wins-deduped by discoverPluginAgents, so this is a
  // straight merge: later user/project/config scopes still shadow by name.
  if (options.pluginAgents !== undefined) {
    for (const agent of options.pluginAgents) {
      registry.set(agent.name, agent);
    }
  }

  // user scope
  scanScope(registry, join(getAfkHome(), 'agents'), 'user', warn);
  // project scope: Claude Code compat first so AFK-native wins within the tier.
  // Share one tracker across the two project dirs so a name defined in BOTH
  // .claude/agents and .afk/agents warns on override (each dir still keeps its
  // own same-directory keep-first policy; .afk continues to win the tier).
  const projectSeen = new Map<string, string>();
  scanScope(registry, join(cwd, '.claude', 'agents'), 'project', warn, projectSeen);
  scanScope(registry, join(cwd, '.afk', 'agents'), 'project', warn, projectSeen);

  // config scope (programmatic, highest)
  if (options.configAgents !== undefined) {
    for (const [name, definition] of Object.entries(options.configAgents)) {
      if (name.trim().length === 0) continue;
      registry.set(name, { name, definition, source: 'config' });
    }
  }

  return registry;
}

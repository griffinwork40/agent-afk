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
 * (user/project/config) shadows the lower scope by design (higher scope wins)
 * — precedence is silent between file scopes, but displacing a BUILT-IN warns
 * (see {@link warnIfShadowsBuiltin}), because the tool-restricted builtins are
 * a safety surface that nine bundled skills dispatch by bare name.
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
import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';
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
 * Invariant: builtins are seeded at the BOTTOM of the precedence order (see
 * {@link loadAgentRegistry}), so any plugin-, file-, or config-scope agent of
 * the same name replaces one. Overriding a builtin is intended operator power
 * and precedence is deliberately UNCHANGED here — this only makes the swap
 * visible, and never blocks it.
 *
 * Invariant: `builtins` MUST be the immutable snapshot of the builtin tier, NOT
 * the registry under construction. Every tier that displaces a name rewrites
 * the live registry's entry, so a lookup there reports the *current winner* and
 * only the FIRST displacer would warn: with `research-agent` defined in both
 * `~/.afk/agents` and `<cwd>/.afk/agents`, the user file warns while the
 * project file — whose broader `tools:` are the ones that actually take effect
 * — passes silently, pointing the operator at a file whose edit changes
 * nothing. Reading the snapshot instead warns once per shadowing file, each
 * naming its own path.
 *
 * It is worth warning at all because the tool-restricted builtins
 * (`research-agent`, `Explore`, and `git-investigator` via nested dispatch) are
 * a safety surface, not just a default: nine bundled orchestration skills
 * dispatch them by bare name, so a single file at
 * `~/.afk/agents/research-agent.md` declaring broader `tools:` converts every
 * "mechanically locked read-only verifier" in those skills into a
 * write-capable agent, for every project on the machine, with no other signal.
 */
function warnIfShadowsBuiltin(
  builtins: ReadonlyMap<string, RegisteredAgent>,
  name: string,
  origin: string,
  warn: (message: string) => void,
): void {
  const prior = builtins.get(name);
  // Defense in depth: by contract `builtins` is the immutable snapshot, so every
  // entry is source 'builtin' and the second check is redundant. It stays because
  // `Map` is assignable to `ReadonlyMap`: a future call site wired to the live
  // registry would otherwise start warning about ordinary higher-scope-wins
  // shadowing between two operator files, which is silent by design.
  if (prior === undefined || prior.source !== 'builtin') return;
  const restriction =
    prior.bashReadOnly === true
      ? ' — the built-in restricts its tools and gates bash to read-only commands; the override replaces both'
      : prior.definition.tools !== undefined
        ? ' — the built-in restricts which tools it may use; the override replaces that restriction'
        : '';
  warn(`[afk] agents: ${sanitizeForDisplay(origin)} overrides built-in agent ${JSON.stringify(name)}${restriction}`);
}

/**
 * Scan one directory scope and merge its agents into `registry`.
 * Same-directory duplicates keep the first file (sorted order) and warn;
 * cross-scope duplicates shadow the lower scope silently (by design), except
 * that displacing a builtin warns via {@link warnIfShadowsBuiltin}.
 *
 * `crossDirSeen`, when supplied, is shared across the directories of a single
 * scope tier (the project tier spans .claude/agents + .afk/agents). It only
 * drives a warning when a name appears in more than one of those dirs — the
 * later directory still wins (registry.set overwrites), so precedence is
 * unchanged; the warning just makes the otherwise-silent override visible.
 */
function scanScope(
  registry: Map<string, RegisteredAgent>,
  builtins: ReadonlyMap<string, RegisteredAgent>,
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
      warn(`[afk] agents: cannot read ${sanitizeForDisplay(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseAgentMarkdown(content, (msg) => warn(`[afk] agents: ${sanitizeForDisplay(filePath)}: ${msg}`));
    if (parsed === undefined) continue;

    const priorInScope = seenInScope.get(parsed.name);
    if (priorInScope !== undefined) {
      warn(
        `[afk] agents: duplicate agent name ${JSON.stringify(parsed.name)} in ${source} scope — ` +
          `keeping ${sanitizeForDisplay(priorInScope)}, ignoring ${sanitizeForDisplay(filePath)}`,
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
            `${sanitizeForDisplay(filePath)} overrides ${sanitizeForDisplay(priorInTier)}`,
        );
      }
      crossDirSeen.set(parsed.name, filePath);
    }

    warnIfShadowsBuiltin(builtins, parsed.name, filePath, warn);

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
        `[afk] agents: ${sanitizeForDisplay(filePath)}: frontmatter field(s) not honored by AFK yet: ` +
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

  // Snapshot the builtin tier before any merge mutates the registry: the
  // shadow warning must resolve names against the ORIGINAL builtins, or only
  // the first displacing tier warns (see {@link warnIfShadowsBuiltin}).
  const builtins = builtinAgents();
  const registry = new Map<string, RegisteredAgent>(builtins);

  // plugin scope (namespaced <plugin>:<agent>; between builtin and user).
  // Pre-scanned + first-wins-deduped by discoverPluginAgents, so this is a
  // straight merge: later user/project/config scopes still shadow by name.
  // The shadow check below is a defensive guard on the public `pluginAgents`
  // option rather than a live path: discoverPluginAgents namespaces every name
  // `<plugin>:<agent>` and builtin names carry no colon, so a discovered
  // plugin agent cannot collide with a bare builtin.
  if (options.pluginAgents !== undefined) {
    for (const agent of options.pluginAgents) {
      warnIfShadowsBuiltin(builtins, agent.name, `plugin agent (${agent.source})`, warn);
      registry.set(agent.name, agent);
    }
  }

  // user scope
  scanScope(registry, builtins, join(getAfkHome(), 'agents'), 'user', warn);
  // project scope: Claude Code compat first so AFK-native wins within the tier.
  // Share one tracker across the two project dirs so a name defined in BOTH
  // .claude/agents and .afk/agents warns on override (each dir still keeps its
  // own same-directory keep-first policy; .afk continues to win the tier).
  const projectSeen = new Map<string, string>();
  scanScope(registry, builtins, join(cwd, '.claude', 'agents'), 'project', warn, projectSeen);
  scanScope(registry, builtins, join(cwd, '.afk', 'agents'), 'project', warn, projectSeen);

  // config scope (programmatic, highest)
  if (options.configAgents !== undefined) {
    for (const [name, definition] of Object.entries(options.configAgents)) {
      if (name.trim().length === 0) continue;
      warnIfShadowsBuiltin(builtins, name, 'AgentSessionConfig.agents', warn);
      registry.set(name, { name, definition, source: 'config' });
    }
  }

  return registry;
}

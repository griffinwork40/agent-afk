/**
 * Named-agent registry: discovery, precedence, and load.
 *
 * Scopes and precedence (ascending — later shadows earlier on the same name):
 *
 *   builtin                          (programmatic; see builtins.ts)
 *   user     ~/.afk/agents/          (all projects on this machine)
 *   project  <cwd>/.claude/agents/   (Claude Code compat, read-only)
 *   project  <cwd>/.afk/agents/      (AFK-native project scope)
 *   config   AgentSessionConfig.agents (programmatic per-session injection)
 *
 * Plugin `agents/` directories are a planned scope (between builtin and
 * user); the plugin scanner does not surface them yet.
 *
 * Directories are scanned recursively for `*.md` files. Identity comes from
 * the frontmatter `name` field, not the filename (Claude Code parity). A
 * duplicate name within one scope keeps the first file found and warns; a
 * duplicate across scopes shadows silently by design (higher scope wins).
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
   * Diagnostic sink for scan warnings (malformed files, duplicate names,
   * unknown frontmatter). Defaults to stderr, matching the plugin skill
   * scanner's convention. Pass a no-op to silence.
   */
  warn?: (message: string) => void;
}

/** Recursively collect `*.md` file paths under `dir`. Missing dir → []. */
function collectMarkdownFiles(dir: string, depth = 0): string[] {
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
 * Same-scope duplicates keep the first file (sorted order) and warn;
 * cross-scope duplicates shadow the lower scope silently (by design).
 */
function scanScope(
  registry: Map<string, RegisteredAgent>,
  dir: string,
  source: AgentSource,
  warn: (message: string) => void,
): void {
  const seenInScope = new Map<string, string>(); // name → filePath
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

  // user scope
  scanScope(registry, join(getAfkHome(), 'agents'), 'user', warn);
  // project scope: Claude Code compat first so AFK-native wins within the tier
  scanScope(registry, join(cwd, '.claude', 'agents'), 'project', warn);
  scanScope(registry, join(cwd, '.afk', 'agents'), 'project', warn);

  // config scope (programmatic, highest)
  if (options.configAgents !== undefined) {
    for (const [name, definition] of Object.entries(options.configAgents)) {
      if (name.trim().length === 0) continue;
      registry.set(name, { name, definition, source: 'config' });
    }
  }

  return registry;
}

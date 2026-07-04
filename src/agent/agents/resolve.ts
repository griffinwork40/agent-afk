/**
 * Resolve a named agent's declared tool surface into AFK runtime terms.
 *
 * Bridges two namespaces: agent files declare tools in Claude Code's
 * PascalCase vocabulary (`Read`, `Grep`, `Bash`, `Task`, `WebFetch`, …) while
 * AFK's dispatcher enforces snake_case runtime names (`read_file`, `grep`,
 * `bash`, `agent`, `web_scrape`). Reuses `normalizeToolToken` — the same
 * alias map the plugin SKILL.md `tools:` parser uses — so the mapping has a
 * single source of truth.
 *
 * Semantics (Claude Code parity):
 * - `tools` omitted → inherit-all (`allowedTools: undefined`; the executor
 *   applies its default child surface).
 * - `disallowedTools` is applied FIRST (subtracted from the inherited or
 *   declared pool), then `tools` resolves against the remainder. A tool in
 *   both lists is removed.
 * - `Task`/`Agent` map to AFK's `agent` tool (opt-in nesting; Claude Code
 *   v2.1.172+ allows nested spawns the same way). `Agent(worker, …)` paren
 *   groups are accepted and the paren content ignored — CC ignores it inside
 *   subagent definitions too.
 * - `mcp__*` tokens pass through verbatim (forward-compat: child providers
 *   currently receive no MCP manager, so these grant nothing today).
 * - Unknown tokens are dropped fail-closed and reported in `droppedTokens`.
 *
 * @module agent/agents/resolve
 */

import { normalizeToolToken } from '../plugins/tool-injector.js';
import { BUILTIN_TOOL_NAMES } from '../tools/schemas.js';
import { AWARENESS_TOOL_NAMES } from '../awareness/index.js';
import type { RegisteredAgent, ResolvedAgentToolAccess } from './types.js';

// Invariant: mirrors KNOWN_AFK_TOOL_NAMES in skills/_agents/to-definition.ts —
// the known-tool universe a child permission gate can actually receive.
// Duplicated (5 lines) rather than imported to keep the layering direction
// src/agent → src/skills one-way-free for this module.
const KNOWN_AFK_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_TOOL_NAMES,
  ...AWARENESS_TOOL_NAMES,
  'memory_search',
  'agent',
  'skill',
]);

/**
 * Orchestration-dispatch aliases the generic normalizer deliberately does not
 * know (it fail-closes `Task`/`Agent` for plugin skills). For NAMED agent
 * definitions nesting is explicit opt-in, so these map to AFK's dispatch
 * tools. Lowercase keys; lookup after paren stripping.
 */
const DISPATCH_TOOL_ALIASES: Record<string, string> = {
  task: 'agent',
  agent: 'agent',
  skill: 'skill',
};

/**
 * Normalize one raw token from an agent file's `tools`/`disallowedTools`
 * list. Returns the canonical AFK name, the verbatim token for `mcp__*`, or
 * `undefined` when the token is unknown (caller drops it fail-closed).
 * Returns `null` for paren-group remnants (e.g. `researcher)` from a
 * comma-split `Agent(worker, researcher)`) which are silently ignored.
 */
function normalizeAgentToolToken(raw: string): string | undefined | null {
  let token = raw.trim();
  if (token.length === 0) return null;
  // Paren-group handling: `Agent(worker, researcher)` may arrive whole or as
  // comma-split fragments. A token containing `(` is truncated at the paren;
  // a bare remnant ending in `)` (or `worker)` etc. with no `(`) is a
  // fragment of the ignored group — drop silently, not fail-closed.
  const parenIdx = token.indexOf('(');
  if (parenIdx !== -1) {
    token = token.slice(0, parenIdx).trim();
    if (token.length === 0) return null;
  } else if (token.endsWith(')')) {
    return null;
  }
  if (token.startsWith('mcp__')) return token;
  const dispatch = DISPATCH_TOOL_ALIASES[token.toLowerCase()];
  if (dispatch !== undefined) return dispatch;
  return normalizeToolToken(token, KNOWN_AFK_TOOL_NAMES);
}

/**
 * Normalize a raw token list. Returns canonical names (order-preserving,
 * deduplicated) and the tokens that were dropped fail-closed.
 */
function normalizeList(raw: readonly string[]): { names: string[]; dropped: string[] } {
  const names: string[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const token of raw) {
    const normalized = normalizeAgentToolToken(token);
    if (normalized === null) continue; // paren remnant / empty — silent
    if (normalized === undefined) {
      dropped.push(token.trim());
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      names.push(normalized);
    }
  }
  return { names, dropped };
}

/**
 * Resolve the effective tool access for a registered agent.
 *
 * @param agent The registered agent whose `tools`/`disallowedTools` to resolve.
 * @param inheritPool The default child tool surface used as the subtraction
 *   pool when the definition declares ONLY `disallowedTools` (Claude Code's
 *   "inherit every tool except…" form). Callers pass `CHILD_ALLOWED_TOOLS`
 *   (or a narrower cage when one is already in force). Taken as a parameter —
 *   not imported from `tools/nesting.ts` — to keep this module free of the
 *   executor-module cycle and independently testable.
 *
 * @see module doc for semantics. `allowedTools: undefined` means the
 * definition inherits the executor's default child surface.
 */
export function resolveAgentToolAccess(
  agent: RegisteredAgent,
  inheritPool: readonly string[],
): ResolvedAgentToolAccess {
  const { tools, disallowedTools } = agent.definition;
  const bashReadOnly = agent.bashReadOnly === true;

  const denied = disallowedTools !== undefined ? normalizeList(disallowedTools) : undefined;
  const allowed = tools !== undefined ? normalizeList(tools) : undefined;
  const dropped = [...(allowed?.dropped ?? []), ...(denied?.dropped ?? [])];

  // Neither list → inherit-all.
  if (allowed === undefined && denied === undefined) {
    return { allowedTools: undefined, bashReadOnly, droppedTokens: dropped };
  }

  // Deny-first: subtract from the declared pool, or from the inherited
  // default surface when only `disallowedTools` is given. `mcp__*` deny
  // patterns subtract nothing from the builtin pool today (children carry no
  // MCP tools) — harmless.
  const deniedSet = new Set(denied?.names ?? []);
  const pool = allowed?.names ?? [...inheritPool];
  const effective = pool.filter((name) => !deniedSet.has(name));

  return { allowedTools: effective, bashReadOnly, droppedTokens: dropped };
}

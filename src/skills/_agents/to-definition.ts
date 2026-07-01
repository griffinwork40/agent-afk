import type { AgentDefinition } from '../../agent/types/sdk-types.js';
import { normalizeToolToken } from '../../agent/plugins/tool-injector.js';
import { BUILTIN_TOOL_NAMES } from '../../agent/tools/schemas.js';
import { AWARENESS_TOOL_NAMES } from '../../agent/awareness/tool.js';

// Invariant: the vendored agent modules (research-agent, git-investigator) pin
// their `allowedTools` to upstream Claude Code's PascalCase namespace (Read,
// Grep, Glob, Bash, WebFetch, …) — byte-equality is enforced by vendored.test.ts.
// AFK's dispatcher, however, hands a `canUseTool` gate the snake_case *runtime*
// tool name (read_file, grep, glob, bash, web_scrape). A gate that compares the
// raw vendored list against the runtime name therefore denies EVERY core call
// ('read_file' ∉ {Read, Grep, …}). This set is the bridge — the same known-tool
// universe the plugin `tools:` parser normalizes against (resolveKnownToolNames).
const KNOWN_AFK_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_TOOL_NAMES,
  ...AWARENESS_TOOL_NAMES,
  'memory_search',
  'agent',
  'skill',
]);

/**
 * Translate a vendored agent's Claude Code tool allowlist (PascalCase aliases
 * like `Read`, `Grep`, `Bash`, `WebFetch`) into the set of AFK runtime tool
 * names (`read_file`, `grep`, `bash`, `web_scrape`) that a `canUseTool`
 * permission gate actually receives at call time.
 *
 * Reuses `normalizeToolToken` (the same alias map the plugin `tools:` frontmatter
 * parser uses), so the mapping stays a single source of truth. Tokens with no AFK
 * equivalent (e.g. `Agent`, `Task` — SDK-nested-dispatch names AFK does not wire)
 * are dropped rather than passed through, keeping the gate fail-closed.
 *
 * @param allowedTools Vendored PascalCase tool tokens
 * @returns Set of canonical AFK runtime tool names
 */
export function vendoredToolAllowlist(allowedTools: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const token of allowedTools) {
    const canonical = normalizeToolToken(token, KNOWN_AFK_TOOL_NAMES);
    if (canonical !== undefined) out.add(canonical);
  }
  return out;
}

/**
 * Convert a vendored agent module into an SDK AgentDefinition for use with
 * Options.agents (nested subagent dispatch via the built-in Agent tool).
 *
 * ⚠️ NOT CURRENTLY WIRED. AFK's harness does not consume `AgentSessionConfig.agents`
 * (it is a "passed through when SDK V2 supports it" placeholder — see
 * config-types.ts). SubagentManager forks via `agent`/`skill`/`compose`, not the
 * SDK's built-in `Agent` tool, so an `agents: { … }` registry on a fork config is
 * a silent no-op. Do NOT rely on this for nested dispatch — a lane that needs a
 * capability must be granted the tool directly (this is exactly the trap that
 * left the /diagnose git lane unable to run git). `tools` here also stay in the
 * vendored PascalCase namespace; use `vendoredToolAllowlist` for runtime gates.
 */
export function toAgentDefinition(agent: {
  systemPrompt: string;
  description: string;
  allowedTools?: readonly string[];
  model?: string;
}): AgentDefinition {
  const def: AgentDefinition = {
    description: agent.description,
    prompt: agent.systemPrompt,
  };
  if (agent.allowedTools) def.tools = [...agent.allowedTools];
  if (agent.model) def.model = agent.model;
  return def;
}

/**
 * Named agent definitions: types.
 *
 * A named agent is a reusable subagent configuration — system prompt, tool
 * allowlist, model, turn budget — addressable from the `agent` tool via the
 * `agent_type` parameter (alias: `subagent_type`). The on-disk format is
 * Claude Code's subagent markdown (YAML frontmatter + body-as-system-prompt),
 * so existing `.claude/agents/` files work unmodified.
 *
 * @module agent/agents/types
 */

import type { AgentDefinition } from '../types/sdk-types.js';

/**
 * Where a registered agent came from. Precedence (ascending — later shadows
 * earlier on name collision): `builtin` → `plugin:<name>` → `user`
 * (`~/.afk/agents/`) → `project` (`<cwd>/.afk/agents/`, plus read-only
 * `.claude/agents/` compat) → `config` (programmatic
 * `AgentSessionConfig.agents`). Mirrors Claude Code's scope ordering
 * (plugin lowest, project above user, CLI/`--agents` highest).
 */
export type AgentSource = 'builtin' | 'user' | 'project' | 'config' | `plugin:${string}`;

/** A named agent definition plus AFK-side registration metadata. */
export interface RegisteredAgent {
  /**
   * Identity. Comes from the frontmatter `name` field (Claude Code parity:
   * the filename does NOT have to match — unlike agentskills.io skills).
   */
  name: string;
  /**
   * The definition proper, in the same shape as `AgentSessionConfig.agents`
   * values (`sdk-types.AgentDefinition`): `description`, `prompt` (= markdown
   * body), optional `tools` / `disallowedTools` (raw tokens, unnormalized),
   * optional `model` / `maxTurns`, plus long-tail fields AFK parses
   * tolerantly but does not yet honor.
   */
  definition: AgentDefinition;
  source: AgentSource;
  /** Absolute path of the defining file. Absent for builtin/config agents. */
  filePath?: string;
  /**
   * AFK extension (`bash: read-only` frontmatter): when true and the agent's
   * resolved allowlist includes `bash`, the child dispatcher additionally
   * blocks mutating shell commands via `classifyBashCommand` — the same gate
   * read-only skills use.
   */
  bashReadOnly?: boolean;
  /**
   * Frontmatter keys that were recognized as Claude Code long-tail fields but
   * are not honored by AFK yet (e.g. `permissionMode`, `hooks`, `memory`).
   * Surfaced once as a scan warning; kept for `/agents` display.
   */
  ignoredKeys?: string[];
}

/**
 * The session-wide registry of named agents, keyed by agent name. Read-only
 * after load: built once at bootstrap (session-static, like the plugin scan)
 * and threaded by reference through executor nesting.
 */
export type AgentRegistry = ReadonlyMap<string, RegisteredAgent>;

/**
 * Result of resolving a registered agent's tool access into AFK runtime
 * terms. Consumed by the `agent` tool executor at dispatch time.
 */
export interface ResolvedAgentToolAccess {
  /**
   * Canonical AFK runtime tool names the child may use, or `undefined` when
   * the definition omits `tools` entirely — Claude Code parity: omitted means
   * "inherit all" (the executor then applies its default child surface).
   */
  allowedTools: string[] | undefined;
  /** Effective read-only-bash gate (from `bash: read-only` frontmatter). */
  bashReadOnly: boolean;
  /**
   * Tokens dropped fail-closed because they normalize to nothing AFK knows
   * (e.g. `NotebookEdit`). Surfaced in warnings so authors see the gap.
   */
  droppedTokens: string[];
  /**
   * Child agent types this agent may dispatch via the `agent` tool, extracted
   * from a scoped `Agent(x, y)` grant. `undefined` = unrestricted (bare
   * `Agent`/`Task`) or no dispatch tool. A non-empty list is enforced by the
   * subagent executor: the child rejects any `agent_type` outside it — and any
   * bare/no-type dispatch — closing the escalation where a read-only agent,
   * once granted `agent`, could spawn an unrestricted `general-purpose`
   * grandchild (the grandchild inherits the parent CAGE, which is unrestricted
   * at top level).
   */
  nestedAgentTypes?: string[];
}

/**
 * Named-agent resolution for compose DAG nodes.
 *
 * Extracted from compose-executor.ts to keep that file under the 350
 * code-line ceiling.
 *
 * When a compose node declares `agent_type`, the executor must:
 *  1. Resolve the name through the agent registry (fail fast on miss).
 *  2. Apply the named agent's tool allowlist as a `canUseTool` filter
 *     so the node's subagent is mechanically restricted — not just
 *     labelled.
 *  3. Substitute the named agent's markdown body as the node's system
 *     prompt (Claude Code parity: the definition body IS the child's
 *     system prompt, not the parent's orchestration prompt).
 *  4. Use the named agent's model default when the call-site omits a
 *     model (lower precedence than an explicit node model, higher than
 *     the compose-level default).
 *
 * Leaf invariant: compose nodes are task-worker leaves — they have no
 * `subagentExecutor` or `skillExecutor` (see `buildComposeNodeProvider`
 * in nesting.ts). Executor-backed tools (`agent`, `skill`) that survive
 * `resolveAgentToolAccess` are stripped here so the node's allowlist never
 * advertises tools it cannot run. When any such tools are stripped a
 * one-line notice is appended to the node's system prompt so the model
 * does not waste rounds attempting to delegate.
 *
 * @module agent/tools/compose-agent-resolve
 */

import { resolveAgentToolAccess } from '../agents/index.js';
import type { RegisteredAgent, AgentRegistry } from '../agents/index.js';
import type { CanUseTool } from '../types.js';
import type { PermissionResult } from '../types/sdk-types.js';
import { CHILD_ALLOWED_TOOLS, COMPOSE_LEAF_STRIPPED_TOOLS } from './nesting.js';
import { isComposeReplaySafe } from '../dag-subagent.recovery.js';
import { isReadOnlyGitToolEnabled, GIT_READ_TOOL_NAME } from './readonly-git-surface.js';
import { isChildWriteCapable } from './subagent/write-capability.js';

// Defined beside buildComposeNodeProvider (which withholds the executors);
// re-exported here for callers and tests.
export { COMPOSE_LEAF_STRIPPED_TOOLS } from './nesting.js';

/**
 * System-prompt suffix appended to a named compose node's prompt when one or
 * more executor-backed tools are stripped from its allowlist. Keeps the message
 * compact and actionable: one sentence, no markdown headers.
 */
export const COMPOSE_LEAF_NOTICE =
  'Note: this node is a compose leaf — the agent and skill tools are not ' +
  'available; do not attempt to delegate to sub-agents.';

/**
 * Result of resolving a named agent for a compose node.
 * Optional fields carry node instructions and provider tool restrictions;
 * only DAG-supported fields should be forwarded to `SubagentDAGNode`.
 */
export interface ResolvedComposeAgent {
  /** Proven pure read surface; omitted for inherit-all definitions. */
  replaySafe?: boolean;
  /**
   * Named agent's system prompt (definition body). Undefined when the
   * definition body is blank — callers should fall back to the executor's
   * base/operator prompt via `resolvedAgent.systemPrompt ?? ctx.systemPrompt`.
   *
   * Do NOT inline `leafNotice` here; append it AFTER the fallback resolves
   * so the base prompt is never suppressed (see `leafNotice`).
   */
  systemPrompt?: string;
  /**
   * Notice for stripped executor-backed tools. Kept separate from the body
   * so resolveComposeAgentPrompt appends it AFTER selecting the base/operator
   * fallback for blank definitions.
   */
  leafNotice?: string;
  /**
   * Tools stripped from the named agent's allowlist because compose leaf
   * nodes cannot run executor-backed tools (`agent`, `skill`). Populated only
   * when `leafNotice` is set — same condition. Used by `emitLeafToolStrips` in
   * `compose-executor.ts` to emit accurate per-node trace metadata instead of
   * the global `COMPOSE_LEAF_STRIPPED_TOOLS` constant.
   */
  strippedTools?: string[];
  /** Named agent's model default (undefined = inherit compose default). */
  namedAgentModel?: string;
  /**
   * `canUseTool` callback built from the named agent's effective tool
   * allowlist. Passed to the `SubagentDAGNode` so `forkSubagent` wires
   * it into the child session's permission gate.
   *
   * When the named agent's definition omits `tools` entirely (inherit-all),
   * this is `undefined` — no additional restriction is imposed beyond the
   * normal compose-node surface.
   */
  canUseTool?: CanUseTool;
  /**
   * The static allowlist that backs `canUseTool`, as a plain string array.
   *
   * Present whenever `canUseTool` is set.  Forwarded to
   * `buildComposeNodeProvider` so it can intersect the node's
   * `permissions.allowedTools` (which drives `toolDefs`) with this list —
   * keeping the advertised schema in sync with the enforced surface.
   *
   * Executor-backed tools (`agent`, `skill`) are stripped before building
   * both this array and `canUseTool`, keeping advertisement and enforcement
   * aligned (#3579, #3580). `compose` is absent from CHILD_ALLOWED_TOOLS.
   */
  namedAgentAllowedTools?: string[];
  /**
   * Named agent's `bashReadOnly` contract (e.g. git-investigator). Threaded
   * into the node provider's constructor so the dispatcher blocks mutating
   * bash. Set only when true.
   */
  readOnlyBash?: true;
  /**
   * The named agent's surface cannot write (same `isChildWriteCapable`
   * predicate as the agent tool's `childWriteCapable`). Drives the #3754
   * pre-dispatch implementation-intent gate in compose. Set only when true.
   */
  readOnly?: true;
  /**
   * Named agent's `maxTurns` frontmatter field. Forwarded so `buildComposeDagNode`
   * can apply the same call-site > named-agent precedence that the agent-tool path
   * enforces via `resolveChildBudgets` (#4042 Stage 3 budget parity).
   * Omitted when the definition does not declare a turn budget.
   */
  namedAgentMaxTurns?: number;
  /**
   * Named agent's `maxToolUseIterations` frontmatter field. Same precedence
   * chain as `namedAgentMaxTurns`.
   */
  namedAgentMaxToolUseIterations?: number;
}

/**
 * Build a `CanUseTool` callback from an explicit allowlist.
 *
 * Returns `{ behavior: 'allow' }` for any tool in `allowed`, and
 * `{ behavior: 'deny', message: … }` for all others. Fail-closed:
 * a tool not in the list is always denied, regardless of what the
 * parent surface allows.
 */
export function buildAllowlistCanUseTool(allowed: string[]): CanUseTool {
  const allowedSet = new Set(allowed);
  return async (
    toolName: string,
    _input: Record<string, unknown>,
    _options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> => {
    if (allowedSet.has(toolName)) {
      return { behavior: 'allow' };
    }
    return {
      behavior: 'deny',
      message:
        `Tool "${toolName}" is not in this compose node's named-agent tool allowlist. ` +
        `Allowed: ${[...allowedSet].sort().join(', ') || '(none)'}`,
    };
  };
}

/**
 * Resolve a named agent for a single compose node. Returns `{}` when the
 * node has no `agent_type`.
 *
 * Throws with the available-agent list when `agent_type` is set but not
 * found in the registry — the compose call should fail fast on a miss.
 */
export function resolveComposeNodeAgent(
  agentType: string | undefined,
  agentRegistry: AgentRegistry | undefined,
): ResolvedComposeAgent {
  if (agentType === undefined) return {};

  const agent: RegisteredAgent | undefined = agentRegistry?.get(agentType);
  if (agent === undefined) {
    const available = [...(agentRegistry?.keys() ?? [])].sort().join(', ');
    throw new Error(
      `Compose node agent_type "${agentType}" not found. ` +
        `Available agent types: ${available.length > 0 ? available : '(none)'}`,
    );
  }

  const resolvedAccess = resolveAgentToolAccess(agent, CHILD_ALLOWED_TOOLS);

  const result: ResolvedComposeAgent = {};

  // System prompt: named agent's definition body IS the child's system
  // prompt (Claude Code parity). Only set when the body is non-empty so
  // a definition with a blank body falls back to the executor's base prompt.
  const agentPrompt = agent.definition.prompt;
  if (typeof agentPrompt === 'string' && agentPrompt.trim().length > 0) {
    result.systemPrompt = agentPrompt;
  }

  // Model default: named agent's frontmatter `model` field. Omitted when
  // absent or 'inherit' (the compose node's default-subagent-model resolves
  // 'inherit' correctly, but it is the caller's responsibility to apply it
  // via resolveChildModel — we simply leave namedAgentModel unset here).
  const defModel = agent.definition.model;
  if (typeof defModel === 'string' && defModel !== 'inherit') {
    result.namedAgentModel = defModel;
  }

  // Budget defaults: named agent's `maxTurns` / `maxToolUseIterations`
  // frontmatter fields. Forwarded so buildComposeDagNode can apply the same
  // call-site > named-agent > unlimited precedence chain that the agent-tool
  // path enforces via resolveChildBudgets (#4042 Stage 3 budget parity).
  // Only set when the definition supplies a positive value.
  if (typeof agent.definition.maxTurns === 'number' && agent.definition.maxTurns > 0) {
    result.namedAgentMaxTurns = agent.definition.maxTurns;
  }
  if (typeof agent.definition.maxToolUseIterations === 'number' && agent.definition.maxToolUseIterations > 0) {
    result.namedAgentMaxToolUseIterations = agent.definition.maxToolUseIterations;
  }

  // Bash restriction: forwarded independently of the allowlist (a
  // `bashReadOnly` agent may inherit-all tools and still be shell-read-only).
  if (resolvedAccess.bashReadOnly) result.readOnlyBash = true;
  if (!isChildWriteCapable(resolvedAccess.allowedTools, resolvedAccess.bashReadOnly === true)) result.readOnly = true;

  // Tool restriction: build canUseTool from the effective allowlist.
  // When allowedTools is undefined (inherit-all definition), skip — no
  // additional restriction beyond the normal compose-node surface.
  if (resolvedAccess.allowedTools !== undefined) {
    // Leaf invariant: compose nodes have no subagentExecutor/skillExecutor
    // (buildComposeNodeProvider), so `agent`/`skill` can never run there even
    // when the definition declares them (e.g. `Agent(git-investigator)`).
    // Strip them ONCE here; the single resulting list feeds both the runtime
    // gate (canUseTool) and the advertised surface (namedAgentAllowedTools ->
    // permissions.allowedTools -> toolDefs), so they cannot drift (#3579, #3580).
    const strippedTools: string[] = [];
    const leafAllowed = resolvedAccess.allowedTools.filter((t) => {
      if (COMPOSE_LEAF_STRIPPED_TOOLS.has(t)) {
        strippedTools.push(t);
        return false;
      }
      return true;
    });

    // #3754: the provider swaps bash for git_read on a read-only-bash node when
    // AFK_READONLY_GIT_TOOL is on; admit git_read here too so the gates agree.
    const gateAllowed = resolvedAccess.bashReadOnly && isReadOnlyGitToolEnabled() && leafAllowed.includes('bash')
      ? [...leafAllowed, GIT_READ_TOOL_NAME]
      : leafAllowed;
    result.canUseTool = buildAllowlistCanUseTool(gateAllowed);
    result.namedAgentAllowedTools = leafAllowed;
    // compose-executor.ts still pins replaySafe to false for compose nodes
    // (conservative; unchanged).
    result.replaySafe = isComposeReplaySafe(leafAllowed);

    // The definition body may still tell the model to delegate; a one-line
    // runtime notice keeps it from spending rounds trying.
    // Store it separately so the executor can append it AFTER resolving
    // `resolvedAgent.systemPrompt ?? ctx.systemPrompt` — this preserves the
    // base/operator prompt even when the definition body is blank or absent
    // (previously setting systemPrompt = COMPOSE_LEAF_NOTICE alone caused the
    // ?? fallback to short-circuit, silently dropping the operator prompt).
    if (strippedTools.length > 0) {
      result.leafNotice = COMPOSE_LEAF_NOTICE;
      result.strippedTools = strippedTools;
    }
  }

  return result;
}

/** Resolve the body fallback before appending the leaf notice. */
export function resolveComposeAgentPrompt(agent: ResolvedComposeAgent, basePrompt: string): string {
  // Invariant: the effective leaf allowlist, not inherited generic tool guidance,
  // governs which calls can succeed. Keep the notice after the base fallback.
  const base = agent.systemPrompt ?? basePrompt;
  const withLeafNotice = agent.leafNotice ? `${base}\n\n${agent.leafNotice}` : base;
  if (agent.namedAgentAllowedTools === undefined) return withLeafNotice;
  // Invariant: render from the SAME effective list the provider advertises.
  // buildComposeNodeProvider intersects CHILD_ALLOWED_TOOLS (minus
  // COMPOSE_LEAF_STRIPPED_TOOLS) with namedAgentAllowedTools; mirror that
  // here so the prompt suffix never names a tool the provider withholds.
  const leafTools = CHILD_ALLOWED_TOOLS.filter((t) => !COMPOSE_LEAF_STRIPPED_TOOLS.has(t));
  const effectiveTools = leafTools.filter((t) => agent.namedAgentAllowedTools!.includes(t));
  // Name tools that are NOT in the effective list as examples of forbidden
  // tools — only if they are absent, so we never discourage a tool that is
  // actually allowed (#4012: previously hardcoded bash/workspace_query here
  // even when the named agent grants them).
  const exampleForbidden = ['bash', 'workspace_query'].filter((t) => !effectiveTools.includes(t));
  const forbiddenClause =
    exampleForbidden.length > 0
      ? `Do not call ${exampleForbidden.join(', ')}, or other tools unless they appear in this list; `
      : 'Do not call tools that do not appear in this list; ';
  return `${withLeafNotice}\n\nThis compose node can use only these tools: ${effectiveTools.join(', ') || '(none)'}. ` +
    `${forbiddenClause}use available read tools or return the missing capability to the parent.`;
}

/**
 * Extract the tool-restriction fields from a resolved agent for spreading into
 * a `SubagentDAGNode`. Returns an object with `canUseTool` and
 * `namedAgentAllowedTools` when the agent has an allowlist, or an empty object
 * when it is inherit-all. Extracted so compose-executor.ts can stay under its
 * 200-line function ceiling without duplicating the conditional spread logic.
 */
export function resolvedAgentToolRestriction(
  agent: ResolvedComposeAgent,
): Pick<ResolvedComposeAgent, 'canUseTool' | 'namedAgentAllowedTools'> | Record<string, never> {
  if (agent.canUseTool === undefined) return {};
  return {
    canUseTool: agent.canUseTool,
    ...(agent.namedAgentAllowedTools !== undefined
      ? { namedAgentAllowedTools: agent.namedAgentAllowedTools }
      : {}),
  };
}

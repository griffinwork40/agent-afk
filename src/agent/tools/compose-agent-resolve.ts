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
 * @module agent/tools/compose-agent-resolve
 */

import { resolveAgentToolAccess } from '../agents/index.js';
import type { RegisteredAgent, AgentRegistry } from '../agents/index.js';
import type { CanUseTool } from '../types.js';
import type { PermissionResult } from '../types/sdk-types.js';
import { CHILD_ALLOWED_TOOLS } from './nesting.js';
import { isComposeReplaySafe } from '../dag-subagent.recovery.js';

/**
 * Result of resolving a named agent for a compose node.
 * Every field is optional so callers can spread it directly into the
 * `SubagentDAGNode` without conditional spreading on each property.
 */
export interface ResolvedComposeAgent {
  /** Proven pure read surface; omitted for inherit-all definitions. */
  replaySafe?: boolean;
  /** Named agent's system prompt (definition body). */
  systemPrompt?: string;
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
   * Named agent's `bashReadOnly` contract (e.g. git-investigator). Threaded
   * into the node provider's constructor so the dispatcher blocks mutating
   * bash. Set only when true.
   */
  readOnlyBash?: true;
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

  // Bash restriction: forwarded independently of the allowlist (a
  // `bashReadOnly` agent may inherit-all tools and still be shell-read-only).
  if (resolvedAccess.bashReadOnly) result.readOnlyBash = true;

  // Tool restriction: build canUseTool from the effective allowlist.
  // When allowedTools is undefined (inherit-all definition), skip — no
  // additional restriction beyond the normal compose-node surface.
  if (resolvedAccess.allowedTools !== undefined) {
    result.canUseTool = buildAllowlistCanUseTool(resolvedAccess.allowedTools);
    // Contract: this value reflects the DECLARED frontmatter surface. The
    // node provider (buildComposeNodeProvider) enforces it via canUseTool on
    // top of CHILD_ALLOWED_TOOLS; compose-executor.ts still pins replaySafe to
    // false for compose nodes (conservative; unchanged).
    result.replaySafe = isComposeReplaySafe(resolvedAccess.allowedTools);
  }

  return result;
}

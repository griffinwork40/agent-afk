/**
 * Pre-fork admission guards for the agent tool.
 *
 * Extracted from subagent-executor.ts (file-size ceiling). Each guard either
 * returns an early-exit ToolResult (isError: true) or contributes to the
 * AdmissionResult that executeOnce consumes after all gates pass.
 *
 * @module agent/tools/subagent-executor.admission
 */

import type { RegisteredAgent } from '../agents/index.js';
import { resolveMaxNestingDepth } from './nesting.js';
import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../session/session-identity.js';
import { parseAgentInput, type AgentInput } from './subagent/input-parse.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { buildAgentMaxDepthRefusal } from './skill-depth-message.js';
import { buildBudgetRefusalMessage, type SpawnReceipt } from './delegation-budget.js';
import { errorMessage } from '../../utils/errors.js';
import type { ToolCall, ToolResult } from './types.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';

/** Successful admission: all guards passed. */
export interface AdmissionResult {
  parsed: AgentInput;
  namedAgent: RegisteredAgent | undefined;
  depth: number;
  maxDepth: number;
  identity: { origin?: TraceOrigin; actor?: TraceActor };
  budgetReceipt: SpawnReceipt | undefined;
}

/**
 * Run every pre-fork admission gate in sequence. Returns either:
 * - `{ admitted: true, ...AdmissionResult }` — all gates passed, or
 * - `{ admitted: false, result: ToolResult }` — an early-exit error response.
 */
export function runAdmissionGates(
  call: ToolCall,
  ctx: SubagentExecutorContext,
): { admitted: true } & AdmissionResult | { admitted: false; result: ToolResult } {
  // Gate 0: already-aborted signal.
  if (call.signal.aborted) {
    return { admitted: false, result: { content: 'Agent tool call aborted', isError: true } };
  }

  // Gate 1: parse + validate input.
  let parsed: AgentInput;
  try {
    parsed = parseAgentInput(call.input);
  } catch (err) {
    const message = errorMessage(err);
    return {
      admitted: false,
      result: { content: `Agent tool input validation failed: ${message}`, isError: true },
    };
  }

  // Gate 2: named-agent resolution.
  let namedAgent: RegisteredAgent | undefined;
  if (parsed.agent_type !== undefined) {
    namedAgent = ctx.agentRegistry?.get(parsed.agent_type);
    if (namedAgent === undefined) {
      const available = [...(ctx.agentRegistry?.keys() ?? [])].sort().join(', ');
      return {
        admitted: false,
        result: {
          content:
            `Agent type "${parsed.agent_type}" not found. ` +
            `Available agent types: ${available.length > 0 ? available : '(none)'}`,
          isError: true,
        },
      };
    }
  }

  // Gate 3: nested-dispatch scope gate.
  const nestedScope = ctx.nestedAgentAllowlist;
  if (nestedScope !== undefined) {
    const requested = parsed.agent_type;
    if (requested === undefined || !nestedScope.includes(requested)) {
      return {
        admitted: false,
        result: {
          content:
            nestedScope.length === 0
              ? 'This agent is not permitted to dispatch any nested agents ' +
                '(its definition granted the dispatch tool but named zero allowed ' +
                'types, e.g. `Agent()`). Complete the task with your own tools.'
              : `This agent may only dispatch the following agent type(s): ${nestedScope.join(', ')}. ` +
                (requested === undefined
                  ? 'A bare dispatch with no agent_type is not permitted here — ' +
                    'set agent_type to one of the allowed types, or complete the task with your own tools.'
                  : `agent_type "${requested}" is out of scope.`),
          isError: true,
        },
      };
    }
  }

  // Gate 4: depth cap.
  const depth = ctx.depth;
  const maxDepth = ctx.maxDepth ?? resolveMaxNestingDepth();

  // Session identity for routing-decision rows.
  const identity: { origin?: TraceOrigin; actor?: TraceActor } =
    ctx.surface !== undefined
      ? { origin: deriveOrigin(ctx.surface), actor: actorFromDepth(depth) }
      : {};

  if (depth >= maxDepth) {
    void appendRoutingDecision({
      ...identity,
      event: 'delegation.skipped',
      parent_session_id: ctx.parentSession.sessionId,
      reason: 'max_depth',
      depth,
      ...(parsed.agent_type !== undefined ? { requested_name: parsed.agent_type } : {}),
    }).catch(() => {});
    return {
      admitted: false,
      result: { content: buildAgentMaxDepthRefusal(depth, maxDepth), isError: true },
    };
  }

  // Gate 5: delegation budget.
  let budgetReceipt: SpawnReceipt | undefined;
  if (ctx.delegationBudget) {
    const check = ctx.delegationBudget.canSpawn(ctx.parentSession.sessionId ?? '');
    if (!check.allowed) {
      void appendRoutingDecision({ ...identity, event: 'delegation.skipped', parent_session_id: ctx.parentSession.sessionId, reason: check.reason ?? 'budget', depth, ...(parsed.agent_type !== undefined ? { requested_name: parsed.agent_type } : {}) }).catch(() => {});
      return { admitted: false, result: { content: buildBudgetRefusalMessage(check), isError: true } };
    }
    budgetReceipt = ctx.delegationBudget.recordSpawn(ctx.parentSession.sessionId ?? '');
  }

  return { admitted: true, parsed, namedAgent, depth, maxDepth, identity, budgetReceipt };
}

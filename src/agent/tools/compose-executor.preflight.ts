/**
 * Synchronous pre-dispatch gates, DAG start, and routing telemetry rows for
 * {@link ComposeExecutor}. Split out of `compose-executor.ts` to keep
 * `ComposeExecutor.execute` under the 200-line function ceiling (#1865).
 *
 * Every helper here is synchronous on purpose: compose detach tests count
 * microtask ticks between `execute()` entry and detach registration, so no
 * extra `await` boundaries may be introduced on that path.
 *
 * @module agent/tools/compose-executor.preflight
 */

import { parseComposeInput, type ComposeInput } from './compose-input-parse.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { deriveOrigin, actorFromDepth } from '../session/session-identity.js';
import { resolveMaxNestingDepth } from './nesting.js';
import { buildComposeMaxDepthRefusal } from './skill-depth-message.js';
import { errorMessage } from '../../utils/errors.js';
import { runSubagentDAG, type SubagentDAGNode } from '../dag-subagent.js';
import type { SubagentManager } from '../subagent.js';
import type { ToolCall, ToolResult } from './types.js';
import type { ComposeExecutorContext } from './compose-executor.context.js';

/** Routing-row identity fields (empty when the surface is unknown). */
export type ComposeRoutingIdentity =
  | { origin: ReturnType<typeof deriveOrigin>; actor: ReturnType<typeof actorFromDepth> }
  | Record<string, never>;

/** Successful preflight: everything execute() needs to build the DAG. */
export interface ComposePreflightOk {
  ok: true;
  parsed: ComposeInput;
  parseWarnings: string[];
  identity: ComposeRoutingIdentity;
  depth: number;
  maxDepth: number;
  maxToolRoundsPerNode: number | undefined;
}

/**
 * Run the synchronous compose gates in order: abort, input parse, API-key
 * presence, and depth cap. Returns the refusal ToolResult on the first failure.
 */
export function preflightComposeCall(
  call: ToolCall,
  ctx: ComposeExecutorContext,
): ComposePreflightOk | { ok: false; result: ToolResult } {
  if (call.signal.aborted) {
    return { ok: false, result: { content: 'Compose tool call aborted', isError: true } };
  }

  let parsed: ComposeInput;
  let parseWarnings: string[];
  try {
    ({ parsed, warnings: parseWarnings } = parseComposeInput(call.input));
  } catch (err) {
    const message = errorMessage(err);
    return {
      ok: false,
      result: { content: `Compose tool input validation failed: ${message}`, isError: true },
    };
  }

  if (!ctx.resolveApiKeyForModel && (!ctx.apiKey || ctx.apiKey.length === 0)) {
    return {
      ok: false,
      result: { content: 'Compose tool requires an API key (ctx.apiKey is missing or empty)', isError: true },
    };
  }

  // Session identity for routing-decision rows. Mirrors the same pattern
  // in SubagentExecutor (subagent-executor.ts:541-544): only emitted when
  // `surface` is set; legacy/un-threaded contexts omit both fields.
  // `actor` comes from `depth` (>0 ⟺ this executor is owned by a subagent).
  const identity: ComposeRoutingIdentity =
    ctx.surface !== undefined
      ? { origin: deriveOrigin(ctx.surface), actor: actorFromDepth(ctx.depth) }
      : {};

  // Depth cap, mirroring the `agent` and `skill` executors. See
  // ComposeExecutorContext.maxDepth: this is inert at any non-zero cap
  // because compose is never wired below the root, and exists so that
  // AFK_MAX_NESTING_DEPTH=0 disables every dispatch tool uniformly.
  const depth = ctx.depth ?? 0;
  const maxDepth = ctx.maxDepth ?? resolveMaxNestingDepth();
  if (depth >= maxDepth) {
    void appendRoutingDecision({
      ...identity,
      event: 'delegation.skipped',
      parent_session_id: ctx.parentSession.sessionId,
      reason: 'max_depth',
      depth,
    }).catch(() => {});
    return { ok: false, result: { content: buildComposeMaxDepthRefusal(depth, maxDepth), isError: true } };
  }

  // Contract: the per-node tool budget is enforced BY THE PROVIDER LOOP, not
  // by this executor. `max_tool_rounds_per_node` is forwarded to each node's
  // fork config as `maxToolUseIterations`, where the shared wind-down policy
  // (providers/shared/tool-loop-cap.ts) spends the budget and then runs one
  // final tools-stripped round so the node answers from what it gathered.
  //
  // This executor previously policed the budget itself: a chained
  // progressSink counted `tool_use_detail` chunks per subagentId and called
  // manager.kill() past the limit. That was wrong twice over. (1) The count
  // was provider-dependent — anthropic-direct emits `tool.use.start` twice
  // per tool block, so the budget bit at half its stated value there and at
  // full value on openai-compatible. (2) Killing mid-round destroys the
  // node's deliverable: a subagent's answer only exists once it stops calling
  // tools, so a killed node returned ~90 bytes of failure text no matter how
  // much work it had done, and `isError` then failed the whole compose call,
  // discarding healthy siblings too.
  const maxToolRoundsPerNode = parsed.max_tool_rounds_per_node;

  return { ok: true, parsed, parseWarnings, identity, depth, maxDepth, maxToolRoundsPerNode };
}

/** Explicit inputs for {@link startComposeDag}. */
export interface StartComposeDagArgs {
  manager: SubagentManager;
  ctx: ComposeExecutorContext;
  parsed: ComposeInput;
  dagNodes: SubagentDAGNode[];
  dagEdges: Array<{ from: string; to: string }>;
  currentCwd: string | undefined;
}

/**
 * Build the DAG promise — not yet awaited so the detach contract can race it.
 * Detach contract (#2542): DAG anchored to ctx.parentSession.abortSignal (not
 * call.signal) so it outlives the turn after detach (Invariant:D3).
 *
 * Delegation budget: per-node accounting is handled in runSubagentDAG
 * (dag-subagent.ts) via the delegationBudget option threaded here. A single
 * executor-level canSpawn check was removed (Item 2) because it was never
 * paired with recordSpawn — a 20-node DAG would have passed the gate once but
 * recorded zero spawns. Per-node checks in dag-subagent supersede it.
 */
export function startComposeDag(args: StartComposeDagArgs): ReturnType<typeof runSubagentDAG> {
  const { manager, ctx, parsed, dagNodes, dagEdges, currentCwd } = args;
  return runSubagentDAG({
    manager,
    parentSession: ctx.parentSession,
    nodes: dagNodes,
    edges: dagEdges,
    failFast: parsed.fail_fast,
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    nodeTimeoutMs: parsed.node_timeout_ms,
    ...(ctx.delegationBudget !== undefined ? { delegationBudget: ctx.delegationBudget } : {}),
    ...(currentCwd !== undefined ? { anchorCwd: currentCwd } : {}),
    // Stage 3 (#4042): seed model-resolution tiers 3 and 4 so dispatchDagNode
    // can apply the full resolveChildModel chain for any node whose spec.model
    // is absent (direct library callers that omit per-node model fields).
    // Compose pre-resolves spec.model for every node it builds, so these fields
    // are a no-op for compose nodes but keep the DAG layer consistent.
    ...(ctx.defaultSubagentModel !== undefined ? { defaultSubagentModel: ctx.defaultSubagentModel } : {}),
    ...(ctx.defaultModel !== undefined ? { defaultModel: ctx.defaultModel } : {}),
  });
}

/** Fire-and-forget `compose.completed` routing row. */
export function recordComposeCompleted(
  identity: ComposeRoutingIdentity,
  parentSessionId: ComposeExecutorContext['parentSession']['sessionId'],
  parsed: ComposeInput,
  result: { outputs: Record<string, unknown>; failed: unknown[]; skipped: unknown[] },
  startedAt: number,
): void {
  void appendRoutingDecision({
    ...identity,
    event: 'compose.completed',
    parent_session_id: parentSessionId,
    node_count: parsed.nodes.length,
    edge_count: parsed.edges?.length ?? 0,
    succeeded: Object.keys(result.outputs).length,
    failed: result.failed.length,
    skipped: result.skipped.length,
    duration_ms: Date.now() - startedAt,
  }).catch(() => {});
}

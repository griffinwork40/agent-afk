/**
 * ComposeExecutor: provider-level handler for the `compose` tool.
 *
 * Receives a ToolCall from the SessionToolDispatcher, builds a DAG of
 * subagent tasks, and delegates to {@link runSubagentDAG} for layer-by-layer
 * Kahn execution. Mirrors the {@link SubagentExecutor} and
 * {@link SkillExecutor} injection patterns.
 *
 * @module agent/tools/compose-executor
 */


import { resolveChildManagerReadRoots } from '../subagent-read-scope.js';
import { partialNodeFlag } from './compose-executor.partial.js';
import { buildComposeWaveManifest } from './compose-executor.wave-manifest.js';

import type { TraceSink } from '../trace/index.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { ToolCall, ToolResult } from './types.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { type ComposeExecutorContext } from './compose-executor.context.js';
export type { ComposeExecutorContext } from './compose-executor.context.js';

import { resolveComposeNodeAgent, COMPOSE_LEAF_STRIPPED_TOOLS } from './compose-agent-resolve.js';
import { checkComposeReadOnlyDispatchIntent } from './subagent-executor.dispatch-intent.js';
import { splitComposeNodeResults } from './compose-node-results.js';
import { formatDAGResult, cleanupComposeSpills } from './compose-executor.format.js';
// Re-export for callers that import cleanupComposeSpills from compose-executor.ts
// (test files, and any surface that predates the format-module extraction).
export { cleanupComposeSpills };
import { errorMessage } from '../../utils/errors.js';
import type { DetachableToolRegistry } from './detach-registry.js';
import { raceComposeDetach } from './detach-compose.js';
import { evaluateDispatchUsageForModel } from './usage-notice.js';
import { createComposeManager } from './compose-executor.manager.js';
import type { SubagentManager } from '../subagent.js';
import { buildComposeDagNode, type ComposeNodeBuildResult } from './compose-executor.node-build.js';
import { preflightComposeCall, startComposeDag, recordComposeCompleted } from './compose-executor.preflight.js';
import type { ComposeInput } from './compose-input-parse.js';
import { updateComposeWaveUnits, buildComposeResultContent, filterComposeEdges } from './compose-executor.settle.js';

/**
 * Emit a `compose_leaf_tools_stripped` session-phase trace event for every
 * resolved node whose executor-backed tools were stripped. PURE OBSERVABILITY
 * — the strip happened in `resolveComposeNodeAgent`; this makes it visible to
 * operators so they can see which `agent_type` grants were silently removed
 * without inspecting raw allowlists.
 *
 * Extracted as a named helper (not a closure) to keep `ComposeExecutor.execute`
 * under the 200-line function ceiling.
 */
function emitLeafToolStrips(
  nodes: import('./compose-input-parse.js').ComposeNodeInput[],
  resolvedAgents: ReturnType<typeof resolveComposeNodeAgent>[],
  traceWriter: TraceSink | undefined,
): void {
  // Guard first: emitSessionPhase is async; calling it with an undefined writer
  // still schedules a microtask (async function always returns a Promise).
  // Short-circuit here to avoid perturbing callers that rely on exact
  // microtask-tick counts (e.g. compose detach tests that use drainMicrotasks).
  if (!traceWriter) return;
  if (nodes.length !== resolvedAgents.length) return;
  for (let i = 0; i < nodes.length; i++) {
    const ra = resolvedAgents[i];
    const node = nodes[i];
    if (ra?.leafNotice !== undefined && node?.agent_type !== undefined) {
      // Use the actual stripped list from the resolved agent so the trace
      // reflects which tools were removed for THIS node, not the global
      // COMPOSE_LEAF_STRIPPED_TOOLS constant which may include tools the
      // agent's allowlist never declared.
      // ra.strippedTools is always defined when leafNotice is set (same
      // condition), so the ?? fallback is unreachable; kept for type safety.
      const strippedNames = ra.strippedTools?.join(', ') ?? [...COMPOSE_LEAF_STRIPPED_TOOLS].join(', ');
      void emitSessionPhase(traceWriter, {
        phase: 'compose_leaf_tools_stripped',
        metadata: { agentType: node.agent_type, strippedTools: strippedNames },
      });
    }
  }
}

export class ComposeExecutor {
  // Current worktree cwd. Seeded from ctx.cwd; updated by setCwd when the
  // session's cwd changes (born-named `afk -w` worktree created on turn 1) so
  // compose DAG nodes anchor to the worktree, not the host's process.cwd().
  // Mirrors the SubagentExecutor / SkillExecutor re-anchor convention.
  private currentCwd: string | undefined;
  private readonly billingManagers = new Set<SubagentManager>();
  private readonly pendingBillingStreams = new Set<Promise<void>>();

  /** Include live DAGs and receipts retained after their ephemeral manager teardown. */
  getPendingChildBillingStreams(): readonly Promise<void>[] {
    for (const manager of this.billingManagers) this.retainBillingStreams(manager);
    return [...this.pendingBillingStreams];
  }

  private retainBillingStreams(manager: SubagentManager): void {
    for (const stream of manager.getPendingChildBillingStreams?.() ?? []) {
      if (this.pendingBillingStreams.has(stream)) continue;
      this.pendingBillingStreams.add(stream);
      const remove = (): void => { this.pendingBillingStreams.delete(stream); };
      void stream.then(remove, remove);
    }
  }

  private async teardownManager(manager: SubagentManager): Promise<void> {
    // Capture before teardown can discard handles, and again for streams
    // abandoned during teardown. Keep only receipts, not the completed manager.
    this.retainBillingStreams(manager);
    try {
      await manager.teardownAll();
    } finally {
      this.retainBillingStreams(manager);
      this.billingManagers.delete(manager);
    }
  }

  constructor(private readonly ctx: ComposeExecutorContext) {
    this.currentCwd = ctx.cwd;
  }

  /**
   * Re-anchor the cwd inherited by compose DAG nodes after a mid-session cwd
   * change. Forks dispatched after this call inherit the new worktree instead
   * of the launch dir. Wired from `dispatcher.setResolveBase()` and
   * anthropic-direct's `cwdDependentsFactory`, mirroring the sub-agent / skill
   * executors. Only affects nodes spawned after the call.
   */
  setCwd(cwd: string): void {
    this.currentCwd = cwd;
  }

  /**
   * Re-point the trace writer compose DAG nodes inherit, after a REPL
   * `/resume` replaced the session that owned the previous writer. Only nodes
   * dispatched after this call use `writer` (#731).
   */
  setTraceWriter(writer: TraceSink | undefined): void {
    this.ctx.traceWriter = writer;
  }

  /**
   * Wire the subagent-success rollup callback so every DAG node's token usage
   * and USD cost accumulates into the parent session's `session_sealed`
   * telemetry. Mirrors the late-binding that `bootstrap.ts` applies to the
   * root manager: session must be constructed first, then this is called with
   * a closure over `session.recordSubagentCompletion`. Calling this more than
   * once replaces the prior callback (matches `SubagentManager` semantics).
   */
  setOnSubagentSucceeded(
    cb: (
      usage: import('../subagent/result.js').SubagentTrace['usage'],
      costUsd: number | undefined,
    ) => void,
  ): void {
    this.ctx.onSubagentSucceeded = cb;
  }

  /**
   * Execute a compose DAG call.
   *
   * @param call           The tool call from the dispatcher.
   * @param detachRegistry Optional detach registry for Ctrl+B support (#2542).
   *   When present, the executor registers its in-flight DAG so Ctrl+B can
   *   free the model's turn while the DAG keeps running. Absent on headless
   *   surfaces where no REPL can inject the late result.
   */
  async execute(call: ToolCall, detachRegistry?: DetachableToolRegistry): Promise<ToolResult> {
    // Abort / parse / API-key / depth-cap gates, plus the per-node tool-budget
    // Contract (provider-loop enforced) — see compose-executor.preflight.ts.
    const pre = preflightComposeCall(call, this.ctx);
    if (!pre.ok) return pre.result;
    const { parsed, parseWarnings, identity, depth, maxDepth, maxToolRoundsPerNode } = pre;

    // Usage notice: evaluate quota at compose-wave start; block at `over`.
    const { notice: usageNotice, blocked: usageBlocked } = await evaluateDispatchUsageForModel(this.ctx.defaultModel, this.ctx.traceWriter);

    // Contract: at `over` (>= 100%), refuse the compose dispatch instead of
    // spawning N nodes that each immediately fail with UsageLimitError.
    if (usageBlocked) {
      return {
        content: `Compose dispatch refused: usage limit exceeded. ${usageNotice ?? 'The subscription quota is exhausted.'}` +
          `\n\nReduce parallel dispatches, wait for the quota window to reset, or switch to a non-Claude model.`,
        isError: true,
      };
    }

    // Read-scope inheritance (#547): derive the DAG nodes' parentReadRoots from
    // the parent session's read scope + this executor's cwd, mirroring the
    // `agent` tool (subagent-executor.ts). Without it, nodes inherit read scope
    // from cwd alone and silently narrow when the parent session is read-open
    // or `/allow-dir`-widened beyond `[cwd, mainRoot]`. Writes stay confined.
    const nodeReadRoots = resolveChildManagerReadRoots(
      this.ctx.getReadScopeInputs?.(),
      this.currentCwd,
    );
    // Ephemeral per-call manager; wiring rationale lives in compose-executor.manager.ts.
    const manager = createComposeManager({
      ctx: this.ctx,
      signal: call.signal,
      currentCwd: this.currentCwd,
      nodeReadRoots,
    });
    this.billingManagers.add(manager);

    const startedAt = Date.now();
    void appendRoutingDecision({
      ...identity,
      event: 'compose.started',
      parent_session_id: this.ctx.parentSession.sessionId,
      node_count: parsed.nodes.length,
      edge_count: parsed.edges?.length ?? 0,
    }).catch(() => {});

    // Detach state: declared OUTSIDE the try block so the finally clause can
    // read detachedRef.value to skip manager.teardownAll() on the detach path
    // (the continuation Promise handles it).
    // Ordered-operation constraint: detachedRef must be initialized before any
    // await so the finally clause never sees an uninitialized reference.
    const detachedRef = { value: false };

    try {
      // Render hints for the CLI tool-lane: each spawned subagent passes
      //   • parentId  = this compose call's tool_use_id  → anchors the
      //     synthesized `Agent(<label>)` entry as a child of the compose
      //     entry (vs. a top-level sibling).
      //   • agentType = `<nodeId> [k/N]`  → human-readable lane label that
      //     also conveys progress through the DAG. Independent of idPrefix
      //     (which is still `compose-<nodeId>` for routing telemetry).
      const composeToolUseId = call.id;
      const totalNodes = parsed.nodes.length;

      // Named-agent resolution: resolve ALL node agent_types before building
      // the DAG so a missing type fails the ENTIRE compose call (not just one
      // node) before any subagent is forked. Mirrors the agent tool's fail-fast
      // pattern (subagent-executor.ts:342-353). Errors are surfaced early with
      // the available-agent list so the model can correct the type without
      // waiting for the DAG to partially execute.
      let resolvedAgents: ReturnType<typeof resolveComposeNodeAgent>[];
      try {
        resolvedAgents = parsed.nodes.map((n) =>
          resolveComposeNodeAgent(n.agent_type, this.ctx.agentRegistry),
        );
      } catch (resolveErr) {
        const message = errorMessage(resolveErr);
        return { content: message, isError: true };
      }
      // #3754: same pre-dispatch implementation-intent gate as the agent tool,
      // applied eagerly so no node forks when any read-only node is misbriefed.
      const intentRefusal = checkComposeReadOnlyDispatchIntent(parsed.nodes, resolvedAgents);
      if (intentRefusal !== undefined) return intentRefusal;
      emitLeafToolStrips(parsed.nodes, resolvedAgents, this.ctx.traceWriter);
      // Invariant: attachment resolution errors are isolated per-node so a bad
      // path or unknown image id on one node never aborts siblings. Each callback
      // either resolves with a SubagentDAGNode (success) or a sentinel
      // { attachmentError } object (failure). After Promise.all the sentinels are
      // split out and injected as pre-failed nodes into the result so
      // `formatDAGResult` surfaces them alongside any runtime failures.
      const nodeBuildResults: ComposeNodeBuildResult[] = await Promise.all(parsed.nodes.map((n, i) =>
        buildComposeDagNode({
          node: n,
          index: i,
          // `resolvedAgents` is built from the same `parsed.nodes` array above,
          // so the index is always in-bounds. The non-null assertion is safe.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          resolvedAgent: resolvedAgents[i]!,
          totalNodes,
          composeToolUseId,
          ctx: this.ctx,
          currentCwd: this.currentCwd,
          nodeReadRoots,
          maxToolRoundsPerNode,
          depth,
          maxDepth,
        }),
      ));

      // Split build results into runnable DAG nodes and pre-failed attachment errors.
      // Nodes with attachment errors are injected into result.failed so they appear
      // in the formatted output alongside runtime failures — siblings still run.
      const { dagNodes, attachmentErrors } = splitComposeNodeResults(nodeBuildResults);

      // Wave manifest: create before the DAG starts so a crash mid-run leaves
      // a recoverable record. Only for ≥2 nodes (no manifest for solo dispatch).
      // Extracted to buildWaveManifest() to keep execute() within the funcsize
      // baseline (the inline block grew execute() above the 487-line baseline).
      const composeWaveId = this.buildWaveManifest(parsed, dagNodes.length);

      // Invariant: SubagentDAGOptions exposes no maxConcurrency field, so the
      // model-facing compose tool has no way to widen its own fan-out — width is
      // governed solely by the operator's AFK_MAX_CONCURRENT_SUBAGENT_CALLS
      // ceiling. Adding such a field would let the agent override an operator
      // safety limit, which is why it is absent rather than merely unset here.
      // Filter edges that reference pre-failed nodes so validateDAG does not
      // throw "Edge references non-existent node" for an attachment-error node.
      const dagEdges = filterComposeEdges(parsed.edges, attachmentErrors);

      // Build the DAG promise — not yet awaited so the detach contract can race it.
      // Detach contract (#2542): anchored to ctx.parentSession.abortSignal (Invariant:D3).
      const dagPromise = startComposeDag({
        manager, ctx: this.ctx, parsed, dagNodes, dagEdges, currentCwd: this.currentCwd,
      });
      // raceComposeDetach registers with the detach registry, races the DAG, and
      // either returns a detach placeholder (Ctrl+B path) or the normal DAG result.
      // When detachRegistry is absent it returns { kind: 'normal', dagResult } immediately.
      const nodeIds = dagNodes.map((n) => n.id);
      const spillSessionId = this.ctx.parentSession.sessionId ?? 'unknown-session';
      const outcome = detachRegistry !== undefined && call.id.length > 0 // guard empty string (defensive)
        ? await raceComposeDetach({
            dagPromise, nodeIds, toolUseId: call.id, attachmentErrors, startedAt,
            formatResult: (r) => formatDAGResult(r, { sessionId: spillSessionId, callId: call.id }).content,
            teardown: () => this.teardownManager(manager),
            detachRegistry,
            onDetach: () => { detachedRef.value = true; },
          })
        : { kind: 'normal' as const, dagResult: await dagPromise };
      if (outcome.kind === 'detached') return outcome.placeholder;
      const dagResult = outcome.dagResult;

      // Merge pre-failed attachment-error nodes into the DAG result so they
      // appear in the formatted output alongside runtime failures. Prepend so
      // failed-resolution nodes are listed before any runtime-failed nodes.
      const result = attachmentErrors.length > 0
        ? { ...dagResult, failed: [...attachmentErrors, ...dagResult.failed] }
        : dagResult;

      recordComposeCompleted(identity, this.ctx.parentSession.sessionId, parsed, result, startedAt);

      // Wave manifest: update unit statuses based on DAG outcome.
      updateComposeWaveUnits(composeWaveId, result);

      // spillSessionId declared above for the detach path; reuse it here.
      const content = buildComposeResultContent({
        result, spillSessionId, callId: call.id, parseWarnings, usageNotice,
      });
      return { content, isError: result.failed.length > 0, ...partialNodeFlag(result.partial) };
    } catch (err) {
      // On any throw in the normal (non-detach) path, also deregister so
      // hasDetachable() returns false — parallel to Fix #2 for bash.
      if (detachRegistry !== undefined && call.id.length > 0) detachRegistry.deregister(call.id);
      const message = errorMessage(err);
      void appendRoutingDecision({
        ...identity,
        event: 'compose.failed',
        parent_session_id: this.ctx.parentSession.sessionId,
        error_message: message.slice(0, 240),
        duration_ms: Date.now() - startedAt,
      }).catch(() => {});
      return { content: `Compose execution error: ${message}`, isError: true };
    } finally {
      // The detach path's continuation manages its own teardownAll; skip here
      // to avoid racing with it (teardownAll on a detached manager is idempotent
      // but the double-teardown is confusing in traces). detachedRef.value is
      // true only when the detach path returned early above.
      if (!detachedRef.value) {
        await this.teardownManager(manager);
      }
    }
  }

  /**
   * Build and register a wave-manifest for crash-recovery. Called from
   * `execute()` when ≥2 DAG nodes are present and depth is 0.
   * Delegates to `compose-executor.wave-manifest.ts` (#3481 file-size ceiling).
   */
  private buildWaveManifest(
    parsed: ComposeInput,
    dagNodeCount: number,
  ): string | undefined {
    return buildComposeWaveManifest({
      parsed,
      dagNodeCount,
      depth: this.ctx.depth,
      currentCwd: this.currentCwd,
      defaultModel: this.ctx.defaultModel,
      defaultSubagentModel: this.ctx.defaultSubagentModel,
      parentSessionId: this.ctx.parentSession.sessionId,
      agentRegistry: this.ctx.agentRegistry,
    });
  }
}

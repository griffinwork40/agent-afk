/**
 * SubagentDAG convenience layer.
 *
 * Builds a DAG whose nodes are subagent forks via {@link SubagentManager},
 * inheriting hook dispatch, permission bubbling, and abort-graph wiring.
 * This is the primary API for skills — the generic {@link runDAG} is the
 * fallback for non-subagent workflows.
 *
 * @module agent/dag-subagent
 */

import type { ZodType } from 'zod';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AgentModelInput, CanUseTool, IAgentSession } from './types.js';
import type { ModelProvider } from './provider.js';
import type { SubagentManager } from './subagent.js';
import { runDAG, type DAGEdge, type DAGNode, type DAGRunResult } from './dag.js';
import { attachSubagentContext, annotateIfIncomplete } from './subagent/result.js';
import { TimeoutError } from '../utils/errors.js';
import { resolveSoftDeadlineMs } from './providers/shared/soft-deadline.js';
import { resolveSubagentTimeoutMs } from './subagent/constants.js';
import { isTooBroadRoot, ungatedSensitiveRoot } from './tools/subagent/root-validation.js';
import { realpathSafe } from './tools/handlers/_cwd-utils.js';
import type { DelegationBudget, SpawnReceipt } from './tools/delegation-budget.js';

export interface SubagentDAGNode {
  id: string;
  systemPrompt: string;
  promptBuilder: (inputs: Record<string, unknown>) => string;
  model?: AgentModelInput;
  outputSchema?: ZodType;
  canUseTool?: CanUseTool;
  idPrefix?: string;
  /**
   * Optional render-only display label forwarded to the CLI's tool-lane
   * (e.g. `"diagnose [1/3]"`). Threaded into the synthesized `Agent(...)`
   * entry. See {@link import('./subagent.js').ForkSubagentOptions.agentType}.
   */
  agentType?: string;
  /**
   * Optional render-only parent id forwarded to the CLI renderer to anchor
   * nesting. Used by the `compose` tool to pass its own `tool_use_id` so
   * spawned subagents render nested under the compose entry. See
   * {@link import('./subagent.js').ForkSubagentOptions.parentId}.
   */
  parentId?: string;
  /**
   * Optional working directory override for this node's subagent session.
   * When set, all file-system tool handlers (bash, read_file, write_file,
   * edit_file) are restricted to this directory. Corresponds to
   * `AgentConfig.cwd`.
   */
  cwd?: string;
  /**
   * Allowed roots for read-class tools in this node's subagent session.
   * Corresponds to `AgentConfig.readRoots`.
   */
  readRoots?: string[];
  /**
   * Additive extra read roots for this node's subagent session. Corresponds to
   * `AgentConfig.extraReadRoots` — DISTINCT from {@link readRoots}: this field
   * COMPOSES with the child's inherited read scope (union) rather than pinning
   * it. Use this instead of `readRoots` when the goal is to widen access beyond
   * the fork's natural scope without suppressing inheritance (the `readRoots`
   * pin path used by `afk farm`).
   *
   * @deprecated Prefer `manager.parentReadRoots` for additive read scope
   * widening. Direct use of `extraReadRoots` on a node spec bypasses the
   * manager's consolidated read-scope tracking and will be removed in a future
   * release. Callers currently setting this field should migrate to passing
   * extra roots through the SubagentManager construction options instead.
   */
  extraReadRoots?: string[];
  /**
   * Allowed roots for write-class tools in this node's subagent session.
   * Corresponds to `AgentConfig.writeRoots`.
   */
  writeRoots?: string[];
  /**
   * Per-node API key. When set, forwarded directly into the node's fork
   * config so the node's subagent authenticates with its own credential
   * rather than the manager's `parentApiKey` fallback. Corresponds to
   * `AgentConfig.apiKey`.
   */
  apiKey?: string;
  /**
   * Per-node cap on tool-use ROUNDS within the node's turn. Forwarded into the
   * fork config as `AgentConfig.maxToolUseIterations`, where the provider loop
   * spends the budget and then runs one tools-stripped wind-down round (see
   * providers/shared/tool-loop-cap.ts) so a capped node still returns a real
   * answer instead of being cut off mid-round. Omit to inherit
   * `SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS`; `0` opts into unbounded.
   * Passing `0` disables the anti-hang cap entirely — it does not request the
   * default. The compose tool's input schema rejects `0` outright, so the two
   * layers disagree deliberately.
   */
  maxToolUseIterations?: number;
  /**
   * Per-node turn budget. Forwarded into the fork config as
   * `AgentConfig.maxTurns`. Omit to inherit the session default (unlimited).
   */
  maxTurns?: number;
  /**
   * Optional pre-built provider for this node's subagent session. When set,
   * forwarded directly into the fork config as `AgentConfig.provider` so the
   * node's `AgentSession` uses this provider instead of falling back to bare
   * `resolveProvider`. Used by compose-executor to thread a workspace-aware
   * provider ({@link buildComposeNodeProvider}) onto each DAG node when the
   * parent session has a `workspaceStore` — ensuring nodes can call
   * `workspace_publish` / `workspace_query` even though compose nodes never
   * receive a `childProviderFactory`.
   */
  provider?: ModelProvider;
  /**
   * Optional async alternative to {@link promptBuilder}. When present, the DAG
   * executor awaits this function and uses its result as the node's prompt
   * instead of `promptBuilder`. Used by the compose executor to attach
   * resolved image bytes as multimodal `ContentBlockParam[]` blocks without
   * requiring synchronous resolution or changing the base `promptBuilder`
   * signature. Prefer this over `promptBuilder` when the prompt construction
   * involves I/O (e.g. reading attachment files).
   *
   * @deprecated This field is scheduled for removal once the compose executor
   * migrates to a unified async prompt contract. New callers should use
   * `promptBuilder` for synchronous prompts; the multimodal attachment use
   * case will be served by a dedicated `attachments` field on the node spec.
   * Existing callers will receive a compatibility shim during the transition.
   */
  buildPromptAsync?: (
    inputs: Record<string, unknown>,
  ) => Promise<string | ContentBlockParam[]>;
}

export interface SubagentDAGOptions {
  manager: SubagentManager;
  parentSession: Pick<IAgentSession, 'sessionId' | 'abortSignal'>;
  nodes: SubagentDAGNode[];
  edges: DAGEdge[];
  failFast?: boolean;
  /**
   * Per-node max runtime in ms. Forwarded to {@link runDAG}; when a node
   * exceeds the deadline, its `nodeSignal` aborts with a {@link TimeoutError}
   * reason, this layer forwards the abort into `handle.cancel()` so the
   * subagent's stream actually tears down, and the resulting failure is
   * surfaced with the timeout message + any partial findings.
   */
  nodeTimeoutMs?: number;
  /**
   * Item 2: optional tree-wide delegation budget. When set, each DAG node
   * checks `canSpawn` before forking and calls `recordSpawn` on success so
   * all DAG nodes are counted against the tree-wide concurrent/total limits.
   * Without this, a 20-node DAG would fork 20 agents with zero budget
   * accounting. The `parentId` used for `maxConcurrentChildrenPerAgent` tracking is the
   * parent session's `sessionId`.
   */
  delegationBudget?: DelegationBudget;
}

/**
 * Validate that a DAG node's `cwd`, `readRoots`, and `writeRoots` pass the
 * same grant-breadth guards that `parseAgentInput` enforces on the agent-tool
 * path. Without this, `runSubagentDAG` is a second, unguarded doorway into
 * `forkSubagent` — any root that would drop credential candidates from the
 * bash restriction hook bypasses the guard entirely (#982).
 *
 * Farm's pinned roots (worktree subdirectories) pass both guards — they are
 * deep project-specific paths, not home / filesystem root / AFK dirs.
 */
function validateDagNodeRoots(spec: SubagentDAGNode): void {
  const candidates: Array<{ value: string; field: string }> = [];
  if (spec.cwd !== undefined) candidates.push({ value: spec.cwd, field: 'cwd' });
  for (const r of spec.readRoots ?? []) candidates.push({ value: r, field: 'readRoots' });
  for (const r of spec.writeRoots ?? []) candidates.push({ value: r, field: 'writeRoots' });
  // Internal field is `extraReadRoots` but the user-facing compose schema calls it `readRoots`.
  // Use the user-facing name in error messages so the model can map errors to its input.
  for (const r of spec.extraReadRoots ?? []) candidates.push({ value: r, field: 'readRoots (extraReadRoots)' });

  for (const { value, field } of candidates) {
    // Resolve symlinks before checking — mirrors input-parse.ts's dual-check
    // pattern. A symlink to $HOME or / passes the lexical check yet grants a
    // broad real root at fork time (#982 symlink sub-vector).
    const real = realpathSafe(value);
    if (isTooBroadRoot(value) || isTooBroadRoot(real)) {
      throw new Error(
        `DAG node "${spec.id}" ${field} "${value}" is too broad ` +
          '(filesystem root, home directory, or AFK directory)',
      );
    }
    const sensitive = ungatedSensitiveRoot(value) ?? ungatedSensitiveRoot(real);
    if (sensitive !== undefined) {
      throw new Error(
        `DAG node "${spec.id}" ${field} "${value}" would un-gate ` +
          `credential root "${sensitive}"`,
      );
    }
  }
}

export async function runSubagentDAG(options: SubagentDAGOptions): Promise<DAGRunResult> {
  const { manager, parentSession, nodes, edges, failFast, nodeTimeoutMs, delegationBudget } = options;
  const signal = parentSession.abortSignal ?? new AbortController().signal;

  // Soft deadline for every node in this DAG (see the arming comment in the
  // fork config below). Computed once — it is the same for every node.
  //
  // Contract: derive from the SMALLER of the two hard budgets that can fire.
  // A DAG node is bounded twice — by runDAG's per-node timer AND by the fork's
  // own `withTimeout` (this layer never sets `config.timeoutMs`, so that is
  // `resolveSubagentTimeoutMs()`). Deriving from the node budget alone would,
  // whenever it is the larger of the two, place the soft deadline AFTER the
  // budget that actually fires — arming a wind-down that can never run. `0`
  // means unbounded on either side and so never binds; when the result is `0`,
  // `forkSubagent` still derives a deadline from its own budget.
  const nodeBudgets = [nodeTimeoutMs ?? 0, resolveSubagentTimeoutMs()].filter((ms) => ms > 0);
  const softDeadlineForNode =
    nodeBudgets.length > 0 ? resolveSoftDeadlineMs(Math.min(...nodeBudgets)) : 0;

  const dagNodes: DAGNode[] = nodes.map((spec) => ({
    id: spec.id,
    async run(inputs: Record<string, unknown>, nodeSignal: AbortSignal): Promise<unknown> {
      // Invariant (#982): validate roots BEFORE forkSubagent — this is the
      // only guard on the DAG path. parseAgentInput guards the agent-tool path;
      // this guards the library-API path. Without it, a caller that derives a
      // root from model output bypasses both isTooBroadRoot and
      // ungatedSensitiveRoot.
      validateDagNodeRoots(spec);

      // Item 2: per-node delegation budget check + charge. The single canSpawn
      // call in compose-executor was never followed by recordSpawn, so a 20-node
      // DAG counted as zero spawns. Checking here ensures every forked node is
      // counted and released. parentId is the parent session's sessionId so the
      // per-agent child count tracks against the root (compose nodes share one
      // parent session, mirroring the agent-tool path).
      let dagNodeBudgetReceipt: SpawnReceipt | undefined;
      if (delegationBudget) {
        const budgetCheck = delegationBudget.canSpawn(parentSession.sessionId ?? '');
        if (!budgetCheck.allowed) {
          throw new Error(
            `DAG node "${spec.id}" blocked by delegation budget: ${budgetCheck.detail ?? budgetCheck.reason ?? 'budget exceeded'}`,
          );
        }
        dagNodeBudgetReceipt = delegationBudget.recordSpawn(parentSession.sessionId ?? '');
      }

      let handle: Awaited<ReturnType<typeof manager.forkSubagent>>;
      try {
        handle = await manager.forkSubagent({
          parent: { sessionId: parentSession.sessionId },
          config: {
            model: spec.model ?? 'sonnet',
            systemPrompt: spec.systemPrompt,
            ...(spec.canUseTool !== undefined ? { canUseTool: spec.canUseTool } : {}),
            ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
            ...(spec.readRoots !== undefined ? { readRoots: spec.readRoots } : {}),
            ...(spec.extraReadRoots !== undefined ? { extraReadRoots: spec.extraReadRoots } : {}),
            ...(spec.writeRoots !== undefined ? { writeRoots: spec.writeRoots } : {}),
            ...(spec.apiKey !== undefined ? { apiKey: spec.apiKey } : {}),
            ...(spec.maxToolUseIterations !== undefined
              ? { maxToolUseIterations: spec.maxToolUseIterations }
              : {}),
            ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
            // Workspace provider: when present, the compose executor has built a
            // workspace-aware provider via buildComposeNodeProvider so that this
            // node can call workspace_publish / workspace_query. Without it the
            // node's AgentSession falls back to bare resolveProvider which never
            // carries workspaceStore, silently stripping both tools from the schema.
            ...(spec.provider !== undefined ? { provider: spec.provider } : {}),
            // Invariant: a DAG node has a SECOND wall-clock enforcer that does not
            // route through `agent/timeout.ts` — runDAG arms its own per-node
            // `setTimeout` (dag.ts) and cascades expiry into `handle.cancel()`
            // below. That path has the identical gap the fork budget had: it kills
            // a slow-but-working child with everything it learned unsynthesized.
            // Arm the soft deadline from the node budget so the node winds down at
            // a round boundary first. `resolveSoftDeadlineMs` returns 0 (off) for
            // an absent or too-short node budget, so unbounded nodes and short ones
            // keep prior behaviour exactly; when it is off here, `forkSubagent`
            // still derives one from the fork's own timeout. Whichever budget is
            // SMALLER binds, so take the min: deriving from the node timeout alone
            // would arm a deadline later than the fork budget that will actually
            // fire.
            ...(softDeadlineForNode !== 0 ? { softDeadlineMs: softDeadlineForNode } : {}),
          },
          idPrefix: spec.idPrefix ?? `dag-${spec.id}`,
          ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
          // Render hints: lift label + parent anchor through to the CLI so the
          // tool-lane can render `Agent(<label>)` entries nested under the
          // dispatching tool's entry (e.g. `compose`). agentType is required
          // on ForkSubagentOptions — fall back to idPrefix when the caller did
          // not supply an explicit display label.
          agentType: spec.agentType ?? spec.idPrefix ?? `dag-${spec.id}`,
          ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
        });
      } catch (forkErr) {
        // Item 2: rollback ALL budget counters on fork failure — the child
        // never ran, so total and concurrentChildrenByAgent must not reflect this spawn.
        dagNodeBudgetReceipt?.rollback();
        dagNodeBudgetReceipt = undefined;
        throw forkErr;
      }

      // Forward DAG-level node abort (e.g. nodeTimeoutMs, fail-fast cascade,
      // parent compose-call abort) into the subagent handle. Without this,
      // nodeController.abort() reaches no consumer — the handle's controller
      // is independent — and the subagent keeps streaming until natural
      // completion. Wiring this is what makes DAG-level supervision REAL
      // rather than fake.
      const onNodeAbort = (): void => {
        void handle.cancel().catch(() => undefined);
      };
      if (nodeSignal.aborted) {
        void handle.cancel().catch(() => undefined);
      } else {
        nodeSignal.addEventListener('abort', onNodeAbort, { once: true });
      }

      try {
        if (nodeSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        // Prefer buildPromptAsync (used for multimodal nodes with image
        // attachments) over the synchronous promptBuilder. When the async
        // builder is present it takes full responsibility for constructing the
        // final prompt — including upstream context injection — so promptBuilder
        // is only called as a fallback when no async builder is wired.
        const prompt: string | ContentBlockParam[] = spec.buildPromptAsync !== undefined
          ? await spec.buildPromptAsync(inputs)
          : spec.promptBuilder(inputs);
        const result = await handle.runToResult(prompt);
        if (result.status !== 'succeeded') {
          // When a TimeoutError was the abort reason, surface it as the
          // outer error message so the parent learns *why* the node stopped
          // (distinct from generic cancel / cascade). The original failure
          // is preserved on `cause`.
          let throwable: Error;
          const reason = nodeSignal.reason;
          if (reason instanceof TimeoutError) {
            throwable = new Error(
              `Subagent ${spec.id} aborted: ${reason.message}`,
              result.error ? { cause: result.error } : {},
            );
          } else {
            throwable = result.error ?? new Error(`Subagent ${spec.id} ${result.status}`);
          }
          // Decorate the thrown error with partial findings + subagent id so
          // compose's failure renderer can surface them. Without this, the
          // partialOutput populated by handle.runToResult is dropped by the
          // generic DAG executor (which only records `{ id, error }`).
          throw attachSubagentContext(throwable, {
            partialOutput: result.partialOutput,
            subagentId: result.id,
          });
        }
        // result.output is a structured parse (complete by construction); only
        // the raw-text fallback can be an incomplete partial, so annotate just
        // that branch. No-op marker for clean completions.
        if (result.output !== undefined) return result.output;
        const text = result.message?.content;
        return typeof text === 'string'
          ? annotateIfIncomplete(text, result.stopReason)
          : text;
      } finally {
        nodeSignal.removeEventListener('abort', onNodeAbort);
        await handle.teardown().catch(() => undefined);
        // Item 2: release the concurrent slot now that the node has settled.
        // The fork succeeded, so use release() — total and concurrentChildrenByAgent
        // correctly reflect a real spawn even if the run aborted mid-flight.
        dagNodeBudgetReceipt?.release();
      }
    },
  }));

  return runDAG({ nodes: dagNodes, edges }, signal, { failFast, nodeTimeoutMs });
}

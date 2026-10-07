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
import type { AgentModelInput, CanUseTool, IAgentSession } from './types.js';
import type { ModelProvider } from './provider.js';
import type { SubagentManager } from './subagent.js';
import type { JournalParent } from './subagent/fork-types.js';
import { runDAG, type DAGEdge, type DAGNode, type DAGRunResult } from './dag.js';
import { attachSubagentContext, annotateIfIncomplete, isIncompleteStopReason } from './subagent/result.js';
import { TimeoutError } from '../utils/errors.js';
import { resolveSoftDeadlineMs } from './providers/shared/soft-deadline.js';
import { resolveSubagentTimeoutMs } from './subagent/constants.js';
import type { DelegationBudget } from './tools/delegation-budget.js';
import type { ImageBlockAttachment } from './content/image-blocks.js';

import { dispatchDagNode } from './dag-subagent.dispatch.js';
import { recoverDagNode } from './dag-subagent.recovery.js';
import type { TraceSink } from './trace/index.js';

export interface SubagentDAGNode {
  /** Internal proof from the named-agent allowlist, not model input. Defaults false. */
  replaySafe?: boolean;
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
   * PINNING read roots for this node's subagent session. When set,
   * inheritance from the parent is SUPPRESSED entirely -- the child sees ONLY
   * these roots (plus its own cwd). Use exclusively for deliberate confinement
   * (e.g. `afk farm` restricting each branch worker to its own worktree).
   *
   * For additive scope widening (the common case), set `extraReadRoots`
   * instead -- it composes with inherited scope rather than replacing it.
   *
   * Corresponds to `AgentConfig.readRoots`.
   */
  pinnedReadRoots?: string[];
  /**
   * Additive extra read roots for this node's subagent session. Corresponds to
   * `AgentConfig.extraReadRoots` -- DISTINCT from {@link pinnedReadRoots}: this
   * field COMPOSES with the child's inherited read scope (union) rather than
   * pinning it. Use this instead of `pinnedReadRoots` when the goal is to widen
   * access beyond the fork's natural scope without suppressing inheritance (the
   * `pinnedReadRoots` pin path used by `afk farm`).
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
   * Filesystem isolation for this node. "none" (default) runs the node in
   * the shared parent tree. "worktree" creates a fresh managed git worktree
   * before forking so this node's writes/tests never collide with sibling
   * nodes. The worktree is torn down in the finally block after the node
   * finishes — dirty or commits-ahead trees are preserved and locked.
   * Mutually exclusive with `cwd` — enforced at parse time by compose-input-parse.ts.
   */
  isolation?: 'none' | 'worktree';
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
   * This node's resolved nesting depth (`parent depth + 1`). When set,
   * forwarded into the fork config so the identity preamble
   * (`identity-preamble.ts`) can emit the correct at-cap / may-delegate line.
   * Without it the preamble treats undefined depth as "below the cap" and
   * may incorrectly tell a node at the cap that it may dispatch further
   * (issue #2266). Set by the compose executor, which computes depth from its
   * own context before building the node list.
   */
  depth?: number;
  /**
   * The dispatch cap threaded alongside {@link depth}. When set, forwarded into
   * the fork config as `AgentConfig.maxDepth`. Defaults to
   * `resolveMaxNestingDepth()` in the compose executor, matching the value the
   * `compose` and `skill` executors use for their own depth-refusal gate.
   */
  maxDepth?: number;
  /**
   * Pre-resolved image attachments for this node's initial prompt. When set,
   * the run loop (see dag-subagent.dispatch.ts) builds a `ContentBlockParam[]`
   * array — a text block with the prompt followed by image blocks — instead of
   * a bare string. Populated by compose-executor.ts via
   * `resolveSubagentAttachments` for nodes that declare `attachments` in the
   * compose input.
   */
  resolvedAttachments?: ImageBlockAttachment[];
}

export interface SubagentDAGOptions {
  traceWriter?: TraceSink;
  manager: SubagentManager;
  parentSession: Pick<IAgentSession, 'sessionId' | 'abortSignal'> & JournalParent;
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
  /**
   * Working directory used as the anchor when creating isolated worktrees for
   * nodes with `isolation:"worktree"`. Passed as `cwd` to
   * {@link createIsolatedWorktree} so the worktree is created relative to the
   * git repo that owns the parent session. Defaults to `process.cwd()` when
   * absent. Seeded by the compose executor from its own `currentCwd`.
   */
  anchorCwd?: string;
}

type PartialNode = DAGRunResult['partial'][number];

/**
 * Record a node that SUCCEEDED but wound down early (soft deadline, budget
 * cap) so compose can surface it to the parent and the facet (#2970).
 * Contract: does not change what `isError` means and does not withhold the
 * node's output from downstream DAG nodes. Hard `node_timeout_ms` failures
 * never reach here; they throw into `failed`.
 */
function recordIfPartial(sink: PartialNode[], id: string, stopReason: string | undefined): void {
  if (isIncompleteStopReason(stopReason)) sink.push({ id, stopReason: stopReason as string });
}

/**
 * Soft deadline shared by every node in one DAG. Computed once per DAG.
 *
 * Contract: derive from the SMALLER of the two hard budgets that can fire.
 * A DAG node is bounded twice: by runDAG's per-node timer AND by the fork's
 * own `withTimeout` (this layer never sets `config.timeoutMs`, so that is
 * `resolveSubagentTimeoutMs()`). Deriving from the node budget alone would,
 * whenever it is the larger of the two, place the soft deadline AFTER the
 * budget that actually fires, arming a wind-down that can never run. `0`
 * means unbounded on either side and so never binds; when the result is `0`,
 * `forkSubagent` still derives a deadline from its own budget.
 */
function resolveDagSoftDeadlineMs(nodeTimeoutMs: number | undefined): number {
  const nodeBudgets = [nodeTimeoutMs ?? 0, resolveSubagentTimeoutMs()].filter((ms) => ms > 0);
  return nodeBudgets.length > 0 ? resolveSoftDeadlineMs(Math.min(...nodeBudgets)) : 0;
}

/**
 * Run a subagent DAG by topologically ordering nodes and executing each in
 * dependency order.
 *
 * Intentional omission: `nestedAgentAllowlist` is NOT forwarded to forked DAG
 * nodes. DAG nodes are task-workers (INV-028), not scoped agents, so the
 * allowlist concept does not apply — forwarding it would silently grant
 * scope-narrowing semantics that only make sense on the agent-tool path.
 * (#2848)
 */
export async function runSubagentDAG(options: SubagentDAGOptions): Promise<DAGRunResult> {
  const { parentSession, nodes, edges, failFast, nodeTimeoutMs } = options;
  const signal = parentSession.abortSignal ?? new AbortController().signal;
  // Human-readable slug counter; random suffix supplies cross-call uniqueness.
  let dagIsolationCounter = 0;

  // Soft deadline for every node (see resolveDagSoftDeadlineMs).
  const softDeadlineForNode = resolveDagSoftDeadlineMs(nodeTimeoutMs);

  // Side-channel: nodes that succeeded but wound down early (#2970).
  const partialNodes: PartialNode[] = [];

  const dagNodes: DAGNode[] = nodes.map((originalSpec) => ({
    id: originalSpec.id,
    async run(inputs: Record<string, unknown>, nodeSignal: AbortSignal): Promise<unknown> {
      // Invariant: recovery stays inside this run() so delay and fresh forks share
      // the original node timeout and fail-fast/parent cancellation signal.
      const result = await recoverDagNode(originalSpec.id,
        () => dispatchDagNode(originalSpec, inputs, nodeSignal, options, softDeadlineForNode, ++dagIsolationCounter),
        nodeSignal, originalSpec.replaySafe === true && originalSpec.canUseTool !== undefined, options.traceWriter);
      if (result.status !== 'succeeded') {
        const reason = nodeSignal.reason;
        const throwable = reason instanceof TimeoutError
          ? new Error(`Subagent ${originalSpec.id} aborted: ${reason.message}`, result.error ? { cause: result.error } : {})
          : result.error ?? new Error(`Subagent ${originalSpec.id} ${result.status}`);
        throw attachSubagentContext(throwable, { partialOutput: result.partialOutput, subagentId: result.id });
      }
      recordIfPartial(partialNodes, originalSpec.id, result.stopReason);
      if (result.output !== undefined) return result.output;
      const text = result.message?.content;
      return typeof text === 'string' ? annotateIfIncomplete(text, result.stopReason) : text;
    },
  }));

  // runDAG's own `partial` is always [] (it has no notion of partial output).
  const dagResult = await runDAG({ nodes: dagNodes, edges }, signal, { failFast, nodeTimeoutMs });
  return { ...dagResult, partial: partialNodes };
}

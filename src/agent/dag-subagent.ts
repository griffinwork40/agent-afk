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
import type { SubagentManager } from './subagent.js';
import { runDAG, type DAGEdge, type DAGNode, type DAGRunResult } from './dag.js';
import { attachSubagentContext } from './subagent/result.js';
import { TimeoutError } from '../utils/errors.js';

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
}

export async function runSubagentDAG(options: SubagentDAGOptions): Promise<DAGRunResult> {
  const { manager, parentSession, nodes, edges, failFast, nodeTimeoutMs } = options;
  const signal = parentSession.abortSignal ?? new AbortController().signal;

  const dagNodes: DAGNode[] = nodes.map((spec) => ({
    id: spec.id,
    async run(inputs: Record<string, unknown>, nodeSignal: AbortSignal): Promise<unknown> {
      const handle = await manager.forkSubagent({
        parent: { sessionId: parentSession.sessionId },
        config: {
          model: spec.model ?? 'sonnet',
          systemPrompt: spec.systemPrompt,
          ...(spec.canUseTool !== undefined ? { canUseTool: spec.canUseTool } : {}),
          ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
          ...(spec.readRoots !== undefined ? { readRoots: spec.readRoots } : {}),
          ...(spec.writeRoots !== undefined ? { writeRoots: spec.writeRoots } : {}),
          ...(spec.apiKey !== undefined ? { apiKey: spec.apiKey } : {}),
        },
        idPrefix: spec.idPrefix ?? `dag-${spec.id}`,
        ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
        // Render hints: lift label + parent anchor through to the CLI so the
        // tool-lane can render `Agent(<label>)` entries nested under the
        // dispatching tool's entry (e.g. `compose`). Both are optional and
        // execution-neutral — see ForkSubagentOptions.
        ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
        ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
      });

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
        const prompt = spec.promptBuilder(inputs);
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
        return result.output ?? result.message?.content;
      } finally {
        nodeSignal.removeEventListener('abort', onNodeAbort);
        await handle.teardown().catch(() => undefined);
      }
    },
  }));

  return runDAG({ nodes: dagNodes, edges }, signal, { failFast, nodeTimeoutMs });
}

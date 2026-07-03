/**
 * Workflow DAG executor — Phase 2.
 *
 * Layer-by-layer Kahn execution: nodes with satisfied dependencies run in
 * parallel per layer (bounded by {@link DAGRunOptions.maxConcurrency} — each
 * node may fork an AgentSession), then the next layer starts. Layer boundaries
 * are the natural drain points; the per-layer limiter is a fresh, per-call pool
 * (never a shared/tree-wide semaphore), so a node that forks a nested compose
 * cannot deadlock waiting on its own ancestor's permits.
 *
 * @module agent/dag
 */

import { TimeoutError } from '../utils/errors.js';
import { settleWithConcurrencyLimit, DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS } from './concurrency-pool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DAGNode {
  id: string;
  run: (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}

export interface DAGEdge {
  from: string;
  to: string;
}

export interface DAGGraph {
  nodes: DAGNode[];
  edges: DAGEdge[];
}

export interface DAGRunOptions {
  /** Cancel unstarted + in-flight nodes on first failure. Default: true. */
  failFast?: boolean;
  /**
   * Per-node max runtime in milliseconds. When a node exceeds the deadline,
   * its controller is aborted with a {@link TimeoutError} reason. Siblings
   * keep running (each node has its own controller); downstream is gated
   * by {@link DAGRunOptions.failFast} as usual.
   *
   * Honest wall-clock timeout — not idle-detection. The DAG cannot see
   * intra-node progress, so an idle policy would be fake; max-runtime is
   * the only policy this layer can enforce truthfully.
   *
   * Undefined (default) or non-positive = no timeout, matching prior behavior.
   */
  nodeTimeoutMs?: number;
  /**
   * Max nodes executed concurrently within a single layer. Each node typically
   * forks an `AgentSession` (compose), so an unbounded layer can exhaust memory
   * or storm the provider rate limit. The layer drains through a bounded pool;
   * per-node results and their order are unaffected (the post-layer processing
   * still keys off `ready` order). Default:
   * {@link DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS}; floored at 1. Injected by
   * tests to assert the cap.
   */
  maxConcurrency?: number;
}

export interface DAGRunResult {
  outputs: Record<string, unknown>;
  failed: Array<{ id: string; error: Error }>;
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDAG(graph: DAGGraph): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Duplicate node ID: ${node.id}`);
    nodeIds.add(node.id);
  }

  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) throw new Error(`Edge references non-existent node: ${edge.from}`);
    if (!nodeIds.has(edge.to)) throw new Error(`Edge references non-existent node: ${edge.to}`);
    const key = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) throw new Error(`Duplicate edge: ${edge.from} -> ${edge.to}`);
    edgeKeys.add(key);
  }

  // Cycle detection via Kahn's in-degree drain using pre-built adjacency.
  const adj = buildAdjacency(graph);
  const inDegree = new Map(adj.inDegree);
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const child of adj.downstream.get(id) ?? []) {
      const newDeg = inDegree.get(child)! - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }
  if (visited !== nodeIds.size) throw new Error('Cycle detected in DAG');
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Adjacency {
  downstream: Map<string, Set<string>>;
  upstream: Map<string, Set<string>>;
  inDegree: Map<string, number>;
}

function buildAdjacency(graph: DAGGraph): Adjacency {
  const downstream = new Map<string, Set<string>>();
  const upstream = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    downstream.set(node.id, new Set());
    upstream.set(node.id, new Set());
    inDegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    downstream.get(edge.from)!.add(edge.to);
    upstream.get(edge.to)!.add(edge.from);
    inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
  }
  return { downstream, upstream, inDegree };
}

function markTransitiveSkipped(
  nodeId: string,
  downstream: Map<string, Set<string>>,
  skipped: Set<string>,
): void {
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of downstream.get(current) ?? []) {
      if (!skipped.has(child)) {
        skipped.add(child);
        queue.push(child);
      }
    }
  }
}

export async function runDAG(
  graph: DAGGraph,
  signal: AbortSignal,
  options: DAGRunOptions = {},
): Promise<DAGRunResult> {
  if (graph.nodes.length === 0) return { outputs: {}, failed: [], skipped: [] };

  validateDAG(graph);

  const { failFast = true, nodeTimeoutMs, maxConcurrency = DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS } = options;
  const nodeTimeoutEnabled =
    nodeTimeoutMs !== undefined && Number.isFinite(nodeTimeoutMs) && nodeTimeoutMs > 0;
  const adj = buildAdjacency(graph);
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const outputs: Record<string, unknown> = {};
  const failed: Array<{ id: string; error: Error }> = [];
  const skipped = new Set<string>();
  const completed = new Set<string>();
  const inDegree = new Map(adj.inDegree);

  // Use a named abort handler so we can remove it in the finally block,
  // preventing a listener leak when the DAG completes before the outer
  // signal is ever aborted (C8 fix).
  const dagController = new AbortController();
  const forwardAbort = (): void => {
    if (!dagController.signal.aborted) dagController.abort(signal.reason);
  };

  if (signal.aborted) {
    dagController.abort(signal.reason);
  } else {
    signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    while (!dagController.signal.aborted) {
      const ready: string[] = [];
      for (const [id, deg] of inDegree) {
        if (deg === 0 && !completed.has(id) && !skipped.has(id)) ready.push(id);
      }
      if (ready.length === 0) break;

      // Bounded per-layer fan-out: at most `maxConcurrency` nodes run at once,
      // so a wide layer (e.g. a 20-node compose) cannot fork an unbounded burst
      // of AgentSessions. Within the cap this is identical to the prior
      // `Promise.allSettled(ready.map(...))` — results stay in `ready` order.
      // The whole per-node closure (AbortController + abort listener + timeout
      // arming, below) is the pool `worker`, and the pool invokes it lazily on
      // dequeue — so a node queued behind the cap does NOT arm its timeout while
      // waiting (queue-wait is never charged against nodeTimeoutMs).
      const layerResults = await settleWithConcurrencyLimit(
        ready,
        maxConcurrency,
        async (id) => {
          const node = nodeMap.get(id)!;
          const nodeController = new AbortController();

          // Forward dagController abort to nodeController, and clean up the
          // listener when the node finishes to avoid per-node leaks.
          const forwardNodeAbort = (): void => {
            if (!nodeController.signal.aborted) {
              nodeController.abort(dagController.signal.reason);
            }
          };

          if (dagController.signal.aborted) {
            nodeController.abort(dagController.signal.reason);
          } else {
            dagController.signal.addEventListener('abort', forwardNodeAbort, { once: true });
          }

          // Per-node max-runtime timer. Aborts the node's own controller with
          // a labeled TimeoutError so consumers (dag-subagent) can surface
          // the cause distinct from a generic cancel/cascade. Sibling
          // controllers are independent — this never propagates upward.
          let nodeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
          if (nodeTimeoutEnabled && !nodeController.signal.aborted) {
            nodeTimeoutHandle = setTimeout(() => {
              if (!nodeController.signal.aborted) {
                nodeController.abort(
                  new TimeoutError(
                    `DAG node "${id}" exceeded nodeTimeoutMs of ${nodeTimeoutMs}ms`,
                    nodeTimeoutMs as number,
                  ),
                );
              }
            }, nodeTimeoutMs as number);
          }


          const inputs: Record<string, unknown> = {};
          for (const upId of adj.upstream.get(id) ?? []) {
            inputs[upId] = outputs[upId];
          }

          try {
            const result = await node.run(inputs, nodeController.signal);
            return { id, result };
          } finally {
            // Clear the timer before any other cleanup so a fire-after-resolve
            // race can't leak into the next layer's controllers. Synchronous
            // in the await-microtask chain — no event-loop window for the
            // timer to fire between node.run resolving and clearTimeout.
            if (nodeTimeoutHandle !== undefined) clearTimeout(nodeTimeoutHandle);
            dagController.signal.removeEventListener('abort', forwardNodeAbort);
          }
        },
      );

      for (let i = 0; i < layerResults.length; i++) {
        const settled = layerResults[i]!;
        if (settled.status === 'fulfilled') {
          const { id, result } = settled.value;
          outputs[id] = result;
          completed.add(id);
          inDegree.delete(id);
          for (const downId of adj.downstream.get(id) ?? []) {
            inDegree.set(downId, inDegree.get(downId)! - 1);
          }
        } else {
          const err = settled.reason instanceof Error ? settled.reason : new Error(String(settled.reason));
          const nodeId = ready[i]!;
          failed.push({ id: nodeId, error: err });
          completed.add(nodeId);
          inDegree.delete(nodeId);
          markTransitiveSkipped(nodeId, adj.downstream, skipped);
          if (failFast) dagController.abort('fail-fast');
        }
      }
    }
  } finally {
    // Always remove the forwarding listener; safe to call even if already fired.
    signal.removeEventListener('abort', forwardAbort);
  }

  return { outputs, failed, skipped: Array.from(skipped) };
}

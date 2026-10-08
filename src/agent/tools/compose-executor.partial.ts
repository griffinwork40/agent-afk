import type { DAGRunResult } from '../dag.js';

/**
 * Tool-result flag for a compose run where at least one node SUCCEEDED but
 * wound down early (soft deadline, tool-round cap) (#2970).
 *
 * Contract: `isError` keeps its meaning (hard failures only); `incomplete`
 * lets facet accounting count partial nodes. Returns `{}` for clean runs so
 * the spread is a no-op. `?? []` tolerates DAG results (and test mocks) that
 * predate the `partial` bucket.
 */
export function partialNodeFlag(
  partial: DAGRunResult['partial'] | undefined,
): { incomplete: true; incompleteReason: string; partialNodeCount: number } | Record<string, never> {
  const count = (partial ?? []).length;
  // partialNodeCount (#2978) lets the facet count nodes, not just calls.
  return count > 0 ? { incomplete: true, incompleteReason: 'compose_partial_nodes', partialNodeCount: count } : {};
}

/**
 * Bounded-concurrency worker pool shared by every subagent fan-out site.
 *
 * `settleWithConcurrencyLimit` was extracted from the tool dispatcher (which
 * bounded the foreground safe-batch, PR #376) so the two other subagent
 * fan-out paths can reuse the same primitive instead of an unbounded
 * `Promise.all`/`Promise.allSettled`:
 *   - the compose/DAG layer executor (`agent/dag.ts`), where one `compose`
 *     tool call can enqueue up to 20 nodes in a single layer, and
 *   - the skill wave runner (`agent/subagent/wave.ts`).
 *
 * @module agent/concurrency-pool
 */

/**
 * Ceiling on subagent forks dispatched simultaneously from a SINGLE fan-out
 * site — one compose/DAG layer, or one `runWave` call. Each unit is a forked
 * `AgentSession` (the real memory + provider-rate-limit cost), so an unbounded
 * layer — e.g. a 20-node `compose` — could exhaust memory or storm the 429
 * ceiling. 8 sits above typical parallel-wave width (2–6 nodes/critics) so
 * ordinary fan-outs are never throttled, while bounding a runaway one; it
 * mirrors the dispatcher's safe-batch ceiling and the background-job ceiling
 * of 10. Injectable per site (DAGRunOptions.maxConcurrency /
 * RunWaveOptions.maxConcurrency) for tuning and tests.
 *
 * Deadlock-free by construction: each fan-out site drains its OWN fresh pool
 * (this function is stateless — no shared/module-level limiter object), so a
 * parent subagent that forks a child which itself fans out never contends for
 * its parent's permits. A single shared cross-site/tree-wide semaphore WOULD
 * deadlock (a parent holds a permit while awaiting a child that needs one);
 * the per-site design avoids that hold-and-wait cycle.
 */
export const DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS = 8;

/**
 * Run `worker` over every `items` element with at most `limit` invocations in
 * flight, returning results in `items` order with the same fulfilled/rejected
 * shape as `Promise.allSettled`. Workers are started eagerly up to the cap, so
 * when `limit >= items.length` this is behaviourally identical to
 * `Promise.allSettled(items.map(worker))` — the parallel-timing tests rely on
 * that. `limit` is floored at 1, so a non-positive cap degrades to sequential
 * rather than deadlocking on an empty pool.
 *
 * Invariant: `worker` is invoked LAZILY, once per dequeue (never before an
 * item's turn). Callers that must defer per-item setup (arming a timeout,
 * wiring an AbortController) until the item actually runs — so queue-wait is
 * not charged against a runtime budget — should perform that setup INSIDE
 * `worker`, not before enqueueing. dag.ts relies on this for timeout fairness.
 */
export async function settleWithConcurrencyLimit<T, I>(
  items: readonly I[],
  limit: number,
  worker: (item: I) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length);
  const poolSize = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let w = 0; w < poolSize; w++) {
    runners.push(
      (async () => {
        // `cursor < length` test and `cursor++` are not separated by an await,
        // so each index is claimed by exactly one runner (no double-dispatch,
        // no skip) despite the shared cursor.
        while (cursor < items.length) {
          const i = cursor++;
          try {
            results[i] = { status: 'fulfilled', value: await worker(items[i]!) };
          } catch (reason) {
            results[i] = { status: 'rejected', reason };
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

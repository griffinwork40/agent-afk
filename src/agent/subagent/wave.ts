/**
 * Parallel subagent fan-out with disciplined completion semantics.
 *
 * Replaces the ad-hoc `Promise.all(handles.map(h => h.runToResult(prompt)))`
 * pattern in skill handlers. Three guarantees that the raw pattern does not
 * provide:
 *
 *   1. **No lost partial successes.** Every task's `SubagentResult` is
 *      returned in task order — even when peers fail. Callers decide whether
 *      a partial failure is fatal.
 *
 *   2. **Fail-fast cancellation.** When any task resolves non-succeeded and
 *      `failFast` is on (default), every peer still executing a run is
 *      cancelled. Saves wasted API calls on slow siblings after an early
 *      failure has already doomed the wave.
 *
 *   3. **End-of-wave teardown.** After all runs settle, each handle's
 *      `teardown()` is invoked so `SubagentStop` fires exactly once per handle
 *      with its true terminal status. Without this, the happy-path subagent
 *      lifecycle ends silently (no hook dispatch) because `run()` alone does
 *      not trigger `SubagentStop`.
 *
 * @module agent/subagent/wave
 */

import type { SubagentHandle } from './handle.js';
import type { SubagentResult } from './result.js';
import { settleWithConcurrencyLimit, DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS } from '../concurrency-pool.js';

export interface WaveTask<T = unknown> {
  handle: SubagentHandle<T>;
  prompt: string;
}

export interface RunWaveOptions {
  /**
   * Cancel still-running peers when any task resolves non-succeeded.
   * Default: `true`. Set `false` when partial failure should not prevent
   * peers from completing their work.
   */
  failFast?: boolean;
  /**
   * Call `handle.teardown()` on every task at the end of the wave so
   * `SubagentStop` fires once per handle. Default: `true`. Set `false` only
   * when the caller wants to reuse handles for additional runs.
   */
  teardown?: boolean;
  /**
   * Max subagent runs in flight at once (each is a forked AgentSession).
   * Bounds a wide wave so it cannot storm memory / the provider rate limit.
   * Default: {@link DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS}; floored at 1.
   */
  maxConcurrency?: number;
}

/**
 * Execute N subagent runs in parallel and collect their results.
 *
 * Never rejects — errors from individual subagents surface through their
 * `SubagentResult.status` (`'failed'`, `'cancelled'`) and optional
 * `error`/`schemaError` fields. Returns results in the same order as `tasks`.
 */
export async function runWave<T = unknown>(
  tasks: ReadonlyArray<WaveTask<T>>,
  options: RunWaveOptions = {},
): Promise<SubagentResult<T>[]> {
  const { failFast = true, teardown = true, maxConcurrency = DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS } = options;
  if (tasks.length === 0) return [];

  const results = new Array<SubagentResult<T>>(tasks.length);
  const pending = new Set(tasks.map((_, i) => i));

  // Bounded fan-out: at most `maxConcurrency` subagent runs are in flight at
  // once (each is a forked AgentSession). Within the cap this is identical to
  // the prior unbounded `Promise.all(tasks.map(...))`. `runToResult` absorbs
  // its own errors into SubagentResult and each index is dispatched exactly
  // once, so the worker never rejects; `results[i]` is filled in task order.
  //
  // fail-fast note: peer-cancellation only targets handles already `running`.
  // When tasks.length > maxConcurrency, a task still QUEUED behind the cap is
  // not yet running, so an earlier failure does not cancel it — it runs when
  // dequeued (a minor efficiency-only difference under fail-fast, never a
  // correctness one; every result is still populated). At or under the cap
  // (all current callers) behaviour is unchanged.
  await settleWithConcurrencyLimit(
    tasks.map((_, i) => i),
    maxConcurrency,
    async (i) => {
      const task = tasks[i]!;
      const result = await task.handle.runToResult(task.prompt);
      results[i] = result;
      pending.delete(i);

      if (failFast && result.status !== 'succeeded') {
        // Cancel every peer still executing a run. `cancel()` is idempotent
        // (stopDispatched guard in handle.ts) so concurrent fail-fast hits on
        // the same peer dispatch `SubagentStop` once.
        for (const peerIdx of pending) {
          const peer = tasks[peerIdx];
          if (peer && peer.handle.status === 'running') {
            // Best-effort; the peer may already be tearing down concurrently.
            void peer.handle.cancel().catch(() => undefined);
          }
        }
      }
    },
  );

  if (teardown) {
    await Promise.allSettled(tasks.map((t) => t.handle.teardown()));
  }

  return results;
}

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
  const { failFast = true, teardown = true } = options;
  if (tasks.length === 0) return [];

  const results = new Array<SubagentResult<T>>(tasks.length);
  const pending = new Set(tasks.map((_, i) => i));

  const promises = tasks.map((task, i) =>
    task.handle.runToResult(task.prompt).then((result) => {
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
    }),
  );

  // `runToResult` absorbs errors into SubagentResult, so this Promise.all
  // never rejects in practice — it simply waits for every task to settle.
  await Promise.all(promises);

  if (teardown) {
    await Promise.allSettled(tasks.map((t) => t.handle.teardown()));
  }

  return results;
}

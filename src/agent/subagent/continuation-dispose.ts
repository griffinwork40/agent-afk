/**
 * Session-end release of worktrees kept for continuation chains (#4266).
 *
 * Every surface drains its subagent tree at session end and then disposes the
 * continuation registry so kept (git-locked) worktrees are handed back to the
 * sweep. The dispose must run even when the drain rejects; otherwise a failed
 * drain leaves every kept worktree locked forever. These helpers are the one
 * place that ordering lives, so the five session-end sites cannot drift.
 *
 * @module agent/subagent/continuation-dispose
 */

/** Minimal registry surface: `dispose()` is best-effort and never throws. */
export interface DisposableContinuationRegistry {
  dispose(): void;
}

/**
 * Run `drain`, then dispose `registry` whether the drain resolved or
 * rejected. The drain's result (or rejection) propagates unchanged.
 */
export async function drainThenDispose<T>(
  drain: () => Promise<T>,
  registry: DisposableContinuationRegistry,
): Promise<T> {
  try {
    return await drain();
  } finally {
    registry.dispose();
  }
}

/**
 * Wrap a shutdown config's `drainSubagents` so the continuation registry is
 * disposed after the drain settles, including when it rejects.
 */
export function withContinuationDispose<S extends { drainSubagents?: (reason: string) => Promise<unknown> }>(
  shutdown: S,
  registry: DisposableContinuationRegistry,
): S & { drainSubagents: (reason: string) => Promise<unknown> } {
  const inner = shutdown.drainSubagents;
  return {
    ...shutdown,
    drainSubagents: (reason: string) =>
      drainThenDispose(async () => (inner !== undefined ? inner(reason) : undefined), registry),
  };
}

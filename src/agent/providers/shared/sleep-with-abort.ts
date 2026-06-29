/**
 * Provider-neutral abort-aware sleep helper.
 *
 * Resolves immediately when `signal` is already aborted; otherwise waits
 * `ms` milliseconds, resolving early if the signal fires while sleeping.
 * The `timer.unref()` call prevents Node.js from keeping the event loop
 * alive solely due to the timeout — correct for server-side agentic loops
 * where the process should exit freely when all real work is done.
 *
 * Previously duplicated verbatim in:
 *   - `anthropic-direct/loop.ts`   (`sleepWithAbort`)
 *   - `openai-compatible/query.ts` (`sleepWithAbort`)
 *
 * Both copies have been replaced with an import from this module.
 *
 * @module agent/providers/shared/sleep-with-abort
 */

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

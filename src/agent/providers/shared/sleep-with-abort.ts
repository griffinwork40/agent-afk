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

/**
 * Plain unconditional sleep with no abort awareness. Uses `timer.unref()` so
 * Node does not keep the event loop alive solely due to this timeout.
 *
 * Use this instead of `new Promise(r => setTimeout(r, ms))` so the behaviour
 * (no event-loop pin) is consistent across every call site.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
  });
}

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

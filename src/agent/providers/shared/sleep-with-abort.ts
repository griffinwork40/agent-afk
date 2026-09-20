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
 * Plain unconditional sleep with no abort awareness.
 *
 * By default the timer is **ref'd** — the event loop stays alive until it
 * fires, which is the correct behavior for CLI-visible sleeps (Telegram
 * startup probes, setup-wizard pauses, rate-limit backoff).  Pass
 * `{ unref: true }` when the timer is purely advisory and should not
 * prevent process exit.
 */
export function sleep(ms: number, opts?: { unref?: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (opts?.unref) timer.unref();
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

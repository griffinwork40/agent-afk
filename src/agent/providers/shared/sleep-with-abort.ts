/**
 * Provider-neutral abort-aware sleep helper.
 *
 * Resolves immediately when `signal` is already aborted; otherwise waits
 * `ms` milliseconds, resolving early if the signal fires while sleeping.
 * Invariant: the timer is ref'd. An awaited backoff IS pending work: a
 * one-shot `afk chat` waiting out a connection outage has no other ref'd
 * handle, and an unref'd timer let the event loop drain so the process
 * exited 0 mid-retry with no output (observed 2026-10-06, sprint Lane V).
 * Abort clears the timer, so cancellation never waits it out.
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

/**
 * Abort-aware sleep.
 *
 * By default the timer is **ref'd** so the event loop stays alive during
 * backoff (required fix for #3171 — an unref'd timer let a one-shot CLI exit
 * 0 mid-retry).  Pass `{ unref: true }` for purely advisory sleeps that
 * should not prevent process exit (e.g. background health-probes that already
 * have other ref'd work in flight).
 */
export function sleepWithAbort(
  ms: number,
  signal: AbortSignal,
  opts?: { unref?: boolean },
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (opts?.unref) timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

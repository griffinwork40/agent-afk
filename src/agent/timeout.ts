/**
 * Promise timeout helper that aborts an associated {@link AbortController}
 * when the timeout fires.
 *
 * Used so that a timed-out sub-agent turn cascades through the
 * {@link AbortGraph} to every descendant rather than leaving children running
 * in the background.
 *
 * @module agent/timeout
 */

import { TimeoutError } from '../utils/errors.js';

export const DEFAULT_SESSION_TIMEOUT_MS = 0;

/**
 * Bounded wait used by `AgentSession.reset()` and `AgentSession.close()` to
 * drain the in-flight stream-consumer before tearing down the SDK plumbing.
 * The wait is intentionally short — a stuck consumer must not block /clear
 * or the close path. 5s gives normal turns room to finish naturally; longer
 * waits should use abort, not delay.
 */
export const RESET_DRAIN_TIMEOUT_MS = 5_000;

export interface WithTimeoutOptions {
  /** Controller aborted on timeout so the underlying work can wind down. */
  controller?: AbortController;
  /** Human-readable label used in the error message (e.g. session id). */
  label?: string;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  options: WithTimeoutOptions = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const label = options.label ? ` (${options.label})` : '';
      const err = new TimeoutError(`Operation timed out after ${timeoutMs}ms${label}`, timeoutMs);
      if (options.controller && !options.controller.signal.aborted) {
        options.controller.abort(err);
      }
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

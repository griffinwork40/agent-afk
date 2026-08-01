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

/**
 * Optional policy object that may grant a BOUNDED extension when the timeout
 * deadline is reached, instead of firing immediately.
 *
 * Exists so a wall-clock budget can honor a provider-communicated pause (HTTP
 * 429 / OAuth subscription park) without becoming resettable by the work it
 * bounds. The extender is consulted ONLY at the deadline, and the guarantee that
 * matters is delegated to it: an implementation must cap total accumulated
 * extension so the overall wait stays finite and predictable. See
 * {@link import('./subagent/pause-ceiling.js').PauseAwareCeiling}.
 *
 * When no extender is supplied, {@link withTimeout} behaves exactly as it did
 * before this seam existed: one timer, one fire, identical error message.
 */
export interface TimeoutExtender {
  /**
   * Called when the deadline is reached. Return the number of ms to extend by,
   * or `0` (or any non-positive/non-finite value) to let the timeout fire.
   * Must eventually return `0` — an implementation that always extends would
   * never let the timeout fire.
   */
  onDeadline(): number;
  /**
   * Optional context appended to the {@link TimeoutError} message when the
   * timeout finally does fire, so a pause-related expiry is diagnosable.
   * Returning `undefined` leaves the message unchanged.
   */
  describe?(): string | undefined;
}

export interface WithTimeoutOptions {
  /** Controller aborted on timeout so the underlying work can wind down. */
  controller?: AbortController;
  /** Human-readable label used in the error message (e.g. session id). */
  label?: string;
  /**
   * Optional bounded-extension policy consulted at the deadline. Omit for the
   * classic single-shot behaviour.
   */
  extender?: TimeoutExtender;
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
    // Total ms actually waited across the initial window plus every granted
    // extension. Reported in the error so the effective budget is legible when
    // an extension was in play; equals `timeoutMs` in the no-extender case, which
    // keeps that message byte-for-byte identical.
    let waitedMs = 0;

    const arm = (windowMs: number): void => {
      timer = setTimeout(() => {
        waitedMs += windowMs;
        // Consult the extension policy (if any) BEFORE building the error: a
        // granted extension re-arms the same single timer and nothing else
        // observes the deadline having been reached. Extender faults must never
        // strand the wait, so a throw is treated as "no extension" and fires.
        let extensionMs = 0;
        if (options.extender) {
          try {
            extensionMs = options.extender.onDeadline();
          } catch {
            extensionMs = 0;
          }
        }
        if (Number.isFinite(extensionMs) && extensionMs > 0) {
          arm(extensionMs);
          return;
        }

        const label = options.label ? ` (${options.label})` : '';
        let context = '';
        if (options.extender?.describe) {
          try {
            const described = options.extender.describe();
            if (described !== undefined && described !== '') context = ` ${described}`;
          } catch {
            // Diagnostics are best-effort; never suppress the timeout.
          }
        }
        const err = new TimeoutError(
          `Operation timed out after ${waitedMs}ms${label}${context}`,
          waitedMs,
        );
        if (options.controller && !options.controller.signal.aborted) {
          options.controller.abort(err);
        }
        reject(err);
      }, windowMs);
    };

    arm(timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

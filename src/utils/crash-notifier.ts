/**
 * Shared crash-notifier helper.
 *
 * Registers `uncaughtException` and `unhandledRejection` process listeners
 * that push a best-effort notification before exiting. Used by both the
 * Telegram bot entrypoint and the daemon command so the behaviour is
 * byte-identical and the registration lives in exactly one place.
 *
 * Layering invariant: this module lives in `src/utils/` and MUST NOT import
 * from `src/cli/`, `src/telegram/`, or `src/agent/`. It accepts the push
 * function as an explicit parameter so the caller controls the transport
 * without creating an upward import.
 *
 * Re-entry safety: the returned `reset` function clears the guard flag AND
 * removes the registered process listeners (`process.off`), so tests can call
 * `installCrashNotifier` multiple times from a clean state without leaking
 * real `process.on` registrations.
 */

import { errorMessage } from './errors.js';

/** How long (ms) to wait after firing the crash notification before exiting,
 *  giving the fire-and-forget HTTP push a chance to flush. */
export const CRASH_EXIT_DELAY_MS = 200;

/** Minimum gap (ms) between consecutive crash pushes — prevents crash-loop
 *  self-DOS when the process thrashes rapidly. */
export const CRASH_PUSH_GUARD_MS = 60_000;

export interface CrashNotifierOptions {
  /**
   * Optional provider of supplementary lines appended to the crash notice
   * after the error message. Called synchronously inside the handler; MUST
   * NOT throw (a thrown error is logged and swallowed to protect the handler).
   */
  extraLines?: () => string[];
}

export interface CrashNotifierHandle {
  /**
   * Clear the re-entry guard and remove the registered process listeners.
   * Exported for testing only — do not call in production code. Allows a
   * test to call `installCrashNotifier` again from a clean state without
   * leaking real `process.on` registrations.
   *
   * @internal
   */
  reset: () => void;
}

/**
 * Register `uncaughtException` and `unhandledRejection` process handlers.
 *
 * @param label  Short identifier included in the push message, e.g. `"telegram"` or `"daemon"`.
 * @param pushFn Fire-and-forget notification function. Receives the composed
 *               message string; its returned Promise is void-caught internally.
 * @param opts   Optional extra-lines provider and other configuration.
 * @returns      A handle with a `reset()` function for test teardown.
 */
export function installCrashNotifier(
  label: string,
  pushFn: (message: string) => Promise<unknown>,
  opts: CrashNotifierOptions = {},
): CrashNotifierHandle {
  let installed = false;

  let lastCrashPushAt = 0;

  // Invariant: reset() must process.off() the exact refs captured here.
  // Re-installing after a reset stacks a second listener pair otherwise.
  let uncaughtHandler: ((err: unknown) => void) | undefined;
  let rejectionHandler: ((err: unknown) => void) | undefined;

  const notifyCrash = (kind: string, err: unknown): void => {
    const nowMs = Date.now();
    if (nowMs - lastCrashPushAt < CRASH_PUSH_GUARD_MS) return;
    lastCrashPushAt = nowMs;

    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const lines: string[] = [`🛑 agent-afk ${label} ${kind}`, msg.slice(0, 500)];

    if (opts.extraLines !== undefined) {
      try {
        const extra = opts.extraLines();
        if (extra.length > 0) lines.push(...extra);
      } catch (extraErr) {
        // extraLines must never crash the crash handler — log a breadcrumb and go on.
        // eslint-disable-next-line no-console
        console.error(`[${label}] crash notifier extraLines threw:`, errorMessage(extraErr));
      }
    }

    void pushFn(lines.join('\n')).catch((pushErr: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[${label}] crash notification push failed:`, errorMessage(pushErr));
    });
  };

  const register = (): void => {
    if (installed) return;
    installed = true;

    uncaughtHandler = (err) => {
      notifyCrash('uncaughtException', err);
      // exitCode is set first so a natural (early) exit — before the timer fires
      // — still reports code 1 to the supervisor. The unref'd timer fires if the
      // in-flight push keeps the event loop alive past CRASH_EXIT_DELAY_MS.
      process.exitCode = 1;
      setTimeout(() => process.exit(1), CRASH_EXIT_DELAY_MS).unref();
    };
    process.on('uncaughtException', uncaughtHandler);

    rejectionHandler = (err) => {
      notifyCrash('unhandledRejection', err);
      // Same rationale as uncaughtException above.
      process.exitCode = 1;
      setTimeout(() => process.exit(1), CRASH_EXIT_DELAY_MS).unref();
    };
    process.on('unhandledRejection', rejectionHandler);
  };

  register();

  return {
    reset: () => {
      if (uncaughtHandler !== undefined) process.off('uncaughtException', uncaughtHandler);
      if (rejectionHandler !== undefined) process.off('unhandledRejection', rejectionHandler);
      uncaughtHandler = undefined;
      rejectionHandler = undefined;
      installed = false;
      lastCrashPushAt = 0;
    },
  };
}

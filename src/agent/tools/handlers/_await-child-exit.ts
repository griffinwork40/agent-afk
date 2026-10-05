/**
 * Bounded wait for a killed child process to actually exit.
 *
 * `ChildProcess.kill()` only REQUESTS termination. On POSIX a SIGKILL is
 * reaped within milliseconds; on Windows `kill()` maps to `TerminateProcess`,
 * which returns before the process is gone, so the child can keep holding its
 * cwd and open file handles for a short while. A tool handler that resolves
 * straight after `kill()` therefore returns while the process still lives
 * (observed as intermittent `EBUSY` on `rmdir` of the searched tree, #703).
 *
 * @module agent/tools/handlers/_await-child-exit
 */

import type { ChildProcess } from 'child_process';

/** Default ceiling on how long a handler waits for a killed child to exit. */
export const KILL_EXIT_WAIT_MS = 2_000;

/**
 * Resolve once `child` has emitted `'exit'`, or after `timeoutMs`, whichever
 * comes first. Never rejects and never hangs.
 *
 * Contract: resolves immediately when the child has already exited
 * (`exitCode` or `signalCode` set), because `'exit'` is emitted once and a
 * late listener would otherwise wait out the full timeout. The timer is
 * `unref()`ed so a pending wait cannot keep the event loop alive.
 * `'exit'` (not `'close'`) is the signal: it fires when the process itself
 * has terminated, whereas `'close'` also waits for every stdio pipe to drain,
 * which another holder of the pipe could postpone.
 */
export function awaitChildExit(child: ChildProcess, timeoutMs: number = KILL_EXIT_WAIT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

/**
 * Platform-safe process-group kill.
 *
 * On POSIX: sends `signal` to the entire process group via negative-PID
 * (`process.kill(-pid, signal)`) — killing the shell and all its descendants,
 * including backgrounded grandchildren.
 *
 * On Windows: `process.kill(-pid, …)` throws `EINVAL` because Win32 has no
 * POSIX process groups. Instead, we spawn `taskkill /F /T /PID <pid>` which
 * kills the process tree (the `/T` flag terminates child processes). This is
 * the documented Windows equivalent of a POSIX PGID kill.
 *
 * Guards: pid must be a positive integer (never 0 — `process.kill(-0, …)`
 * would signal THIS process's own group on POSIX). Errors from already-dead
 * processes are silently swallowed.
 *
 * @module utils/kill-process-group
 */

import { execFileSync } from 'node:child_process';

/**
 * Kill an entire process group (POSIX) or process tree (Windows).
 *
 * @param pid - The PID of the group leader / root process. Must be > 0.
 * @param signal - Signal to send on POSIX. Ignored on Windows (`taskkill /F`
 *   always sends an unconditional terminate). Defaults to `'SIGKILL'`.
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
): void {
  if (pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      // /F = force, /T = tree kill (children + grandchildren).
      // Synchronous so the caller can settle immediately after.
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        timeout: 5_000,
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Process (group) already dead; swallow ESRCH / exit-code-128 / EINVAL.
  }
}

/**
 * Platform-safe process-group kill.
 *
 * On POSIX: sends `signal` to the entire process group via negative-PID
 * (`process.kill(-pid, signal)`) — killing the shell and all its descendants,
 * including backgrounded grandchildren.
 *
 * On Windows: `process.kill(-pid, …)` throws `EINVAL` because Win32 has no
 * POSIX process groups. Instead, we spawn `taskkill /F /T /PID <pid>` which
 * requests a best-effort process-tree kill without blocking the event loop.
 * MSYS2 children may not be recorded as Windows descendants, so callers must
 * not rely on pipe EOF as proof that every child was killed.
 *
 * Guards: pid must be a positive integer (never 0 — `process.kill(-0, …)`
 * would signal THIS process's own group on POSIX). Errors from already-dead
 * processes are silently swallowed.
 *
 * @module utils/kill-process-group
 */

import { spawn } from 'node:child_process';
import { isErrnoCode } from './errors.js';

/**
 * Injectable Windows launcher so this branch can be tested on any host.
 * Exported so tests can reference the shape via structural typing explicitly
 * rather than relying on implicit structural compatibility (finding #3210-low).
 */
export interface KillProcessGroupDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
}

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
  deps: KillProcessGroupDeps = {},
): void {
  if (pid <= 0) return;
  try {
    if ((deps.platform ?? process.platform) === 'win32') {
      // /T is best-effort: MSYS2 children may be absent from the Windows tree.
      // Never block the event loop (or abort/settle timers) waiting for taskkill.
      const killer = launchTaskkill(pid, deps);
      killer.unref();
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Process (group) already dead; swallow ESRCH / exit-code-128 / EINVAL.
  }
}

/** Start the shell-free Windows tree walk with the same diagnostics in both APIs. */
function launchTaskkill(pid: number, deps: KillProcessGroupDeps) {
  const killer = (deps.spawn ?? spawn)('taskkill', ['/F', '/T', '/PID', String(pid)], {
    stdio: 'ignore', timeout: 5_000, windowsHide: true,
  });
  killer.on('error', (err) => {
    if (!isErrnoCode(err, 'ESRCH')) {
      console.warn(`[kill-process-group] taskkill error (pid=${pid}):`, err.message);
    }
  });
  return killer;
}

/**
 * Await the Windows tree walk, not merely the root's exit. Always bounded and
 * never throws; callers must keep the root alive (including its stdin) until
 * this settles. POSIX signalling is synchronous and needs no separate wait.
 */
export async function killProcessGroupAndWait(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
  deps: KillProcessGroupDeps = {},
  timeoutMs = 5_000,
): Promise<void> {
  if (pid <= 0) return;
  if ((deps.platform ?? process.platform) !== 'win32') {
    killProcessGroup(pid, signal, deps);
    return;
  }
  try {
    const killer = launchTaskkill(pid, deps);
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        killer.removeListener('close', finish);
        killer.removeListener('error', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      killer.once('close', finish);
      killer.once('error', finish);
    });
    killer.unref();
  } catch { /* unavailable / already gone */ }
}

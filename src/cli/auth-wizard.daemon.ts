import { readFileSync } from 'node:fs';
import { getDaemonLockPath } from '../agent/daemon-instance.lock.js';
import { isErrnoCode } from '../utils/errors.js';

/**
 * True when the daemon lock file names a live process.
 *
 * Used only to decide whether the "restart the daemon" hint is relevant after
 * a credential is saved. Any failure to resolve or read the lock means "no".
 */
export function isDaemonRunning(lockPath?: string): boolean {
  try {
    const raw = readFileSync(lockPath ?? getDaemonLockPath(), 'utf-8');
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: the process exists but this user may not signal it.
      return isErrnoCode(err, 'EPERM');
    }
  } catch {
    return false;
  }
}

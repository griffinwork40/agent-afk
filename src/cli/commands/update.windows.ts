import { readFile } from 'node:fs/promises';
import { readLivePresenceFiles } from '../../agent/awareness/presence.js';
import { getDaemonLockPath } from '../../agent/daemon-instance.lock.js';
import { isProcessAlive } from '../../agent/process-liveness.js';
import { serviceManagerFor, SERVICE_NAMES } from '../../service/index.js';
import { getManagerPaths } from '../../telegram/manager.js';

/** No stop/start side effects: inspect existing per-user registries only. */
export async function findWindowsUpdateBlockers(
  platform: NodeJS.Platform = process.platform,
  ownPid: number = process.pid,
): Promise<string[]> {
  if (platform !== 'win32') return [];
  const blockers = new Set<string>();
  for (const record of await readLivePresenceFiles()) {
    if (record.pid !== ownPid && record.liveness === 'alive') {
      blockers.add(`afk session (PID ${record.pid}) — close its terminal/session`);
    }
  }
  const manager = serviceManagerFor('win32');
  for (const name of SERVICE_NAMES) {
    try {
      const status = manager?.status(name);
      if (status?.running === true && status.pid !== ownPid) {
        blockers.add(`${name} service — stop AFK-${name} in Windows Task Scheduler`);
      }
    } catch {
      // Status is best-effort; npm's EBUSY fallback covers missed processes.
    }
  }
  const markers = [
    { path: getManagerPaths().pidFile, name: 'Telegram bot', action: 'run `afk telegram stop`' },
    { path: getDaemonLockPath(), name: 'daemon', action: 'stop its terminal or AFK-daemon task' },
  ];
  for (const marker of markers) {
    try {
      const raw = (await readFile(marker.path, 'utf8')).trim();
      if (!/^\d+$/.test(raw)) continue;
      const pid = Number(raw);
      if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff && pid !== ownPid && isProcessAlive(pid)) {
        blockers.add(`${marker.name} PID marker (${pid}) — ${marker.action}`);
      }
    } catch {
      // Absent/unreadable markers do not prove that no process is running.
    }
  }
  return [...blockers];
}

export const WINDOWS_UPDATE_LOCK_GUIDANCE =
  'Windows cannot replace a loaded native binary (such as better-sqlite3). ' +
  'Close other afk sessions, stop the Telegram bot (`afk telegram stop`), and stop ' +
  'AFK-telegram / AFK-daemon tasks in Windows Task Scheduler before retrying. ' +
  'For a foreground bot or daemon, stop its terminal process. Restart services after the update.';

/** One bounded matcher per output stream; handles EBUSY split across chunks. */
export function createEbusyDetector(): (chunk: Buffer) => boolean {
  let tail = Buffer.alloc(0);
  return (chunk) => {
    const text = Buffer.concat([tail, chunk]);
    tail = Buffer.from(text.subarray(-4));
    return text.includes(Buffer.from('EBUSY'));
  };
}

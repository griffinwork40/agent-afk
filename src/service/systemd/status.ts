/**
 * systemd status introspection — the Linux analog of
 * `launchd/status.ts`. Parses `systemctl --user show` key=value output.
 *
 * @module service/systemd/status
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import type { ServiceName, ServiceStatus } from '../types.js';
import { SYSTEMCTL_TIMEOUT_MS, serviceLogPath, systemdLabel, unitFileName, unitPath } from './paths.js';

/** Properties we request from `systemctl show` and the parse we extract. */
export interface SystemctlShowResult {
  pid?: number;
  lastExitStatus?: number;
  activeState?: string;
  loadState?: string;
}

/**
 * Parse `systemctl --user show <unit> --property=...` output. The output
 * is newline-separated `Key=Value` lines. A stopped-but-loaded unit
 * reports `MainPID=0` and its last `ExecMainStatus`; a not-found unit
 * reports `LoadState=not-found`.
 *
 * Returns finite `pid` only when `MainPID > 0`.
 */
export function parseSystemctlShow(output: string): SystemctlShowResult {
  const out: SystemctlShowResult = {};
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case 'MainPID': {
        const pid = Number.parseInt(value, 10);
        if (Number.isFinite(pid) && pid > 0) out.pid = pid;
        break;
      }
      case 'ExecMainStatus': {
        const status = Number.parseInt(value, 10);
        if (Number.isFinite(status)) out.lastExitStatus = status;
        break;
      }
      case 'ActiveState':
        if (value) out.activeState = value;
        break;
      case 'LoadState':
        if (value) out.loadState = value;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Read live status from systemctl. Side-effecting; not used in unit tests. */
export function systemdStatus(name: ServiceName): ServiceStatus {
  const path = unitPath(name);
  const snapshot: ServiceStatus = {
    name,
    label: systemdLabel(name),
    installed: existsSync(path),
    configPath: path,
    logFile: serviceLogPath(name),
  };
  if (!snapshot.installed) return snapshot;
  try {
    const output = execFileSync(
      'systemctl',
      ['--user', 'show', unitFileName(name), '--property=MainPID,ExecMainStatus,ActiveState,LoadState'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: SYSTEMCTL_TIMEOUT_MS },
    );
    const parsed = parseSystemctlShow(output);
    if (parsed.pid !== undefined) snapshot.pid = parsed.pid;
    if (parsed.lastExitStatus !== undefined) snapshot.lastExitStatus = parsed.lastExitStatus;
  } catch {
    // systemctl missing, no user manager, timed out, or errored — the
    // installed flag is the source of truth; leave pid undefined.
  }
  return snapshot;
}

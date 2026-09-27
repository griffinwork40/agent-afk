/**
 * Windows Task Scheduler status introspection — the win32 analog of
 * `systemd/status.ts` and `launchd/status.ts`.
 *
 * Parses `schtasks /Query /TN <name> /FO LIST /V` output. The LIST /V
 * format emits one `Key: Value` pair per line. We extract:
 *   - Status (Running / Ready / Queued / Disabled) → installed + pid-like check
 *   - Last Result (0 = clean) → lastExitStatus
 *
 * PID is NOT available from schtasks output — left undefined.
 *
 * @module service/windows/status
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import type { ServiceName, ServiceStatus } from '../types.js';
import { SCHTASKS_TIMEOUT_MS, serviceLogPath, taskName, taskXmlPath } from './paths.js';

/** Parsed fields from `schtasks /Query /FO LIST /V` output. */
export interface SchtasksQueryResult {
  /** True when the status line says "Running". */
  running: boolean;
  /** Last result code (0 = success). */
  lastExitStatus?: number;
}

/**
 * Parse `schtasks /Query /TN ... /FO LIST /V` output.
 * Lines are `Key:       Value` (colon-separated, padded). A stopped task
 * reports Status `Ready` and Last Result is the last exit code. A running
 * task reports Status `Running`.
 */
export function parseSchtasksQuery(output: string): SchtasksQueryResult {
  const result: SchtasksQueryResult = { running: false };
  for (const line of output.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === 'Status' || key === 'TaskStatus') {
      result.running = value === 'Running';
    } else if (key === 'Last Result') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) result.lastExitStatus = n;
    }
  }
  return result;
}

/** Read live status from schtasks. Side-effecting; not used in unit tests. */
export function windowsStatus(name: ServiceName): ServiceStatus {
  const xmlPath = taskXmlPath(name);
  const snapshot: ServiceStatus = {
    name,
    label: taskName(name),
    installed: existsSync(xmlPath),
    configPath: xmlPath,
    logFile: serviceLogPath(name),
  };
  if (!snapshot.installed) return snapshot;
  try {
    const output = execFileSync(
      'schtasks',
      ['/Query', '/TN', taskName(name), '/FO', 'LIST', '/V'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: SCHTASKS_TIMEOUT_MS,
      },
    );
    const parsed = parseSchtasksQuery(output);
    // PID not available from schtasks — leave undefined.
    if (parsed.lastExitStatus !== undefined) snapshot.lastExitStatus = parsed.lastExitStatus;
  } catch {
    // schtasks absent or errored — XML file is source of truth for installed.
  }
  return snapshot;
}

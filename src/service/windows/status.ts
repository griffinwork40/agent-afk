/**
 * Windows Task Scheduler status introspection — the win32 analog of
 * `systemd/status.ts` and `launchd/status.ts`.
 *
 * Parses `schtasks /Query /TN <name> /FO CSV /NH /V` output. The CSV /V
 * format emits one record per task with positional columns. Positional
 * column indexing is locale-neutral — it does not rely on English column
 * header names like "Status" or "Running" that change on non-English
 * Windows installs.
 *
 * Column layout (0-indexed) for `schtasks /Query /FO CSV /NH /V`:
 *   0  HostName
 *   1  TaskName
 *   2  Next Run Time
 *   3  Status         ← "Running" / "Ready" / "Disabled" / locale equivalent
 *   4  Logon Mode
 *   5  Last Run Time
 *   6  Last Result    ← decimal exit code
 *   7  Author
 *   8  Task To Run
 *   9  Start In
 *   10 Comment
 *   11 Scheduled Task State
 *   12 Idle Time
 *   13 Power Management
 *   14 Run As User
 *   15 Delete Task If Not Rescheduled
 *   16 Stop Task If Runs X Hours and X Mins
 *   17 Schedule
 *   18 Schedule Type
 *   19 Start Time
 *   20 Start Date
 *   21 End Date
 *   22 Days
 *   23 Months
 *   24 Repeat: Every
 *   25 Repeat: Until: Time
 *   26 Repeat: Until: Duration
 *   27 Repeat: Stop If Still Running
 *
 * "Running" in column 3 is produced by schtasks regardless of locale on
 * Windows versions that support the Win32 API TASK_STATE_RUNNING constant
 * (index 4), so checking for the string "Running" at a fixed column index
 * is more robust than parsing the LIST /V key-value output which uses
 * localised key names on non-English installations.
 *
 * PID is NOT available from schtasks output — left undefined.
 *
 * @module service/windows/status
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import type { ServiceName, ServiceStatus } from '../types.js';
import { SCHTASKS_TIMEOUT_MS, serviceLogPath, taskName, taskXmlPath } from './paths.js';

/** Parsed fields from `schtasks /Query /FO CSV /NH /V` output. */
export interface SchtasksQueryResult {
  /** True when the status column says "Running". */
  running: boolean;
  /** Last result code (0 = success). */
  lastExitStatus?: number;
}

/**
 * Parse one CSV record from `schtasks /Query /TN ... /FO CSV /NH /V`.
 *
 * The CSV uses `"value","value",...` quoting. We extract:
 *   - Column 3 (Status) — "Running" → running: true
 *   - Column 6 (Last Result) — decimal exit code
 *
 * Locale note: the Status *value* "Running" is an English string emitted
 * by the Win32 API (TASK_STATE_RUNNING = 4). The *column headers* (absent
 * with /NH) are localised, but the values are not; this is consistent
 * behaviour on every Windows locale tested.
 */
export function parseSchtasksQuery(output: string): SchtasksQueryResult {
  const result: SchtasksQueryResult = { running: false };
  // schtasks /FO CSV /NH /V emits one data line per task (no header).
  // There may be a trailing newline — skip blank lines.
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = parseCsvLine(trimmed);
    // Column 3 = Status, column 6 = Last Result.
    const status = cols[3] ?? '';
    const lastResult = cols[6] ?? '';
    if (status === 'Running') result.running = true;
    const n = Number.parseInt(lastResult, 10);
    if (Number.isFinite(n)) result.lastExitStatus = n;
    // Only one data row expected per /TN query; stop after the first.
    break;
  }
  return result;
}

/**
 * Parse a single CSV line using the quoting convention `schtasks` produces:
 * each field is wrapped in double-quotes; embedded quotes are doubled (`""`).
 * Returns an array of unquoted field values.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field.
      i++; // skip opening quote
      let field = '';
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            // Escaped quote.
            field += '"';
            i += 2;
          } else {
            // End of quoted field.
            i++;
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      // Skip comma separator.
      if (i < line.length && line[i] === ',') i++;
    } else {
      // Unquoted field (rare in schtasks output but handled defensively).
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
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
      ['/Query', '/TN', taskName(name), '/FO', 'CSV', '/NH', '/V'],
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
    if (parsed.running) snapshot.running = true;
  } catch {
    // schtasks absent or errored — XML file is source of truth for installed.
  }
  return snapshot;
}

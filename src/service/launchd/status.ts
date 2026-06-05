import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { LAUNCHCTL_TIMEOUT_MS, labelFor, plistPath, serviceLogPath, type ServiceName } from './paths.js';

// ─────────────────────────────────────────────────────────────────────────
// Status introspection
// ─────────────────────────────────────────────────────────────────────────

/** Output of `serviceStatus()`. Decoupled from chalk/rendering. */
export interface ServiceStatusSnapshot {
  name: ServiceName;
  label: string;
  installed: boolean;
  plistPath: string;
  /** Running PID if launchctl reports the job as loaded with an active process. */
  pid?: number;
  /** Last exit status reported by launchctl (0 = clean). */
  lastExitStatus?: number;
  /** Log file path AFK redirects the service's stdout+stderr to. */
  logFile: string;
}

/**
 * Parse `launchctl list` output for a specific label.
 *
 * macOS 13+ (Ventura) can emit JSON from `launchctl list`. macOS 12 and
 * earlier emit a space-separated three-column table. The legacy tab-
 * separated format is still produced by some configurations and on some
 * firmware versions for backwards compatibility. We detect each format
 * in priority order so the parser handles all macOS versions:
 *
 *   1. JSON (macOS 13+): `{ "PID": 123, "LastExitStatus": 0, "Label": "..." }`
 *   2. Space-separated (macOS 12): `  PID  Status  Label` (variable whitespace)
 *   3. Tab-separated (legacy/compat): `PID\tStatus\tLabel`
 *
 * Returns `{ pid?, lastExitStatus? }` when the label is found, or
 * `undefined` when the job is not loaded.
 */
export function parseLaunchctlListRow(
  table: string,
  label: string,
): { pid?: number; lastExitStatus?: number } | undefined {
  const trimmed = table.trim();

  // ── Format 1: JSON output (macOS 13+) ────────────────────────────────
  // launchctl may emit a JSON array or a single object. We handle both.
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (e['Label'] !== label) continue;
        const out: { pid?: number; lastExitStatus?: number } = {};
        if (typeof e['PID'] === 'number' && Number.isFinite(e['PID'])) {
          out.pid = e['PID'] as number;
        }
        if (typeof e['LastExitStatus'] === 'number' && Number.isFinite(e['LastExitStatus'])) {
          out.lastExitStatus = e['LastExitStatus'] as number;
        }
        return out;
      }
    } catch {
      // Not valid JSON — fall through to text formats.
    }
    return undefined;
  }

  // ── Formats 2 & 3: text table (macOS 12 and earlier) ─────────────────
  // Split on tabs first (legacy format). If we get a 3-column result,
  // use it. Otherwise try splitting on runs of whitespace (space format).
  for (const line of trimmed.split('\n')) {
    const tabCols = line.split('\t');
    const cols =
      tabCols.length >= 3
        ? tabCols
        : line.trim().split(/\s+/); // space-separated fallback

    if (cols.length < 3) continue;
    if (cols[2]?.trim() !== label) continue;

    const pidStr = cols[0]?.trim() ?? '-';
    const statusStr = cols[1]?.trim() ?? '0';
    const out: { pid?: number; lastExitStatus?: number } = {};
    if (pidStr !== '-' && pidStr !== '') {
      const pid = Number.parseInt(pidStr, 10);
      if (Number.isFinite(pid)) out.pid = pid;
    }
    const status = Number.parseInt(statusStr, 10);
    if (Number.isFinite(status)) out.lastExitStatus = status;
    return out;
  }
  return undefined;
}

/** Read live status from launchctl. Side-effecting; not used in unit tests. */
export function serviceStatus(name: ServiceName): ServiceStatusSnapshot {
  const path = plistPath(name);
  const snapshot: ServiceStatusSnapshot = {
    name,
    label: labelFor(name),
    installed: existsSync(path),
    plistPath: path,
    logFile: serviceLogPath(name),
  };
  if (!snapshot.installed) return snapshot;
  try {
    const table = execFileSync('launchctl', ['list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: LAUNCHCTL_TIMEOUT_MS,
    });
    const row = parseLaunchctlListRow(table, snapshot.label);
    if (row) {
      if (row.pid !== undefined) snapshot.pid = row.pid;
      if (row.lastExitStatus !== undefined) snapshot.lastExitStatus = row.lastExitStatus;
    }
  } catch {
    // launchctl missing, timed out, or errored — installed flag is the
    // source of truth, leave pid undefined.
  }
  return snapshot;
}



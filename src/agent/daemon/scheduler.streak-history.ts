// Durable streak snapshots shared by the scheduler and schedule health/list.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import type { TelemetryRecord } from './scheduler.js';

/** Persisted consecutive-failure state; exact: false makes count a lower bound. */
export interface StreakSnapshot {
  count: number;
  failingSince?: string;
  /** An escalation decision has been issued (not a delivery guarantee). */
  escalated: boolean;
  extraFailures: number;
  lastError?: string;
  /** False means count is a lower bound from legacy/incomplete history. */
  exact: boolean;
}

/** Recent task history; !hasRuns with !snapshot.exact does not prove the task never ran. */
export interface StreakHistory {
  snapshot: StreakSnapshot;
  hasRuns: boolean;
  lastStatus?: TelemetryRecord['status'];
}

/** Maximum bytes read per history lookup, including any partial oldest line. */
export const STREAK_HISTORY_BYTE_CAP = 2 * 1024 * 1024;

/** Create an independent, exact empty streak for a known fresh history or success boundary. */
export const emptyStreak = (): StreakSnapshot => ({
  count: 0,
  escalated: false,
  extraFailures: 0,
  exact: true,
});

/** Accept run rows (including legacy rows) but never notification-delivery records. */
export function isRunRecord(value: unknown): value is TelemetryRecord {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return r['recordType'] !== 'notification-delivery'
    && typeof r['taskId'] === 'string'
    && ['success', 'error', 'blocked', 'skipped'].includes(String(r['status']));
}

function isSnapshot(value: unknown): value is StreakSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return Number.isInteger(s['count']) && Number(s['count']) >= 0
    && typeof s['escalated'] === 'boolean' && typeof s['exact'] === 'boolean'
    && Number.isInteger(s['extraFailures']) && Number(s['extraFailures']) >= 0
    && (s['count'] === 0 || typeof s['failingSince'] === 'string');
}

/**
 * Seek backwards up to STREAK_HISTORY_BYTE_CAP, parsing only candidate task lines.
 * Stop at the newest snapshot or success; only legacy history needs replay.
 * A capped scan without a boundary is inexact, even if no recent runs were found.
 * Missing files mean no runs; unreadable files are explicitly indeterminate.
 */
export function readStreakHistory(path: string, taskId: string): StreakHistory {
  const legacy: TelemetryRecord[] = [];
  const taskNeedle = JSON.stringify(taskId);
  let fd: number | undefined;
  let base = emptyStreak();
  let lastStatus: TelemetryRecord['status'] | undefined;
  try {
    fd = openSync(path, 'r');
    let pos = fstatSync(fd).size;
    const stopAt = Math.max(0, pos - STREAK_HISTORY_BYTE_CAP);
    let suffix = '';
    while (pos > stopAt) {
      const size = Math.min(pos - stopAt, 65536);
      pos -= size;
      const buf = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const n = readSync(fd, buf, read, size - read, pos + read);
        if (n === 0) throw new Error('Short telemetry read');
        read += n;
      }
      // latin1 preserves split UTF-8 bytes until a complete line is assembled.
      const lines = (buf.toString('latin1') + suffix).split('\n');
      suffix = pos > 0 ? (lines.shift() ?? '') : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = Buffer.from(lines[i] ?? '', 'latin1').toString('utf8');
        if (!line.includes(taskNeedle)) continue;
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRunRecord(row) || row.taskId !== taskId) continue;
        lastStatus ??= row.status;
        if (isSnapshot(row.failureStreak)) {
          return replayLegacy(row.failureStreak, legacy, lastStatus);
        }
        if (row.status === 'success') return replayLegacy(base, legacy, lastStatus);
        legacy.push(row);
      }
    }
    // A cap or legacy rows without a success/snapshot boundary leave a lower bound.
    if (stopAt > 0 || legacy.length > 0) base = { ...base, exact: false };
    return replayLegacy(base, legacy, lastStatus);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return replayLegacy({ ...base, exact: missing && legacy.length === 0 }, legacy, lastStatus);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function replayLegacy(
  base: StreakSnapshot,
  rows: TelemetryRecord[],
  lastStatus?: TelemetryRecord['status'],
): StreakHistory {
  const snapshot = { ...base };
  for (const row of rows.reverse()) {
    if (row.status === 'skipped') continue;
    snapshot.count++;
    snapshot.failingSince ??= row.triggeredAt;
    if (snapshot.escalated) snapshot.extraFailures++;
    if (row.notifySent === 'escalation' || row.notifySent === 're-escalation') {
      snapshot.escalated = true;
      snapshot.extraFailures = 0;
    }
    if (row.errorMessage !== undefined) snapshot.lastError = row.errorMessage;
  }
  return {
    snapshot,
    hasRuns: lastStatus !== undefined,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
  };
}

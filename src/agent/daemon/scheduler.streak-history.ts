// Durable streak snapshots shared by the scheduler and schedule health/list.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import type { TelemetryRecord } from './scheduler.js';
import { isValidIsoDate } from '../../utils/iso-date.js';

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

/** Maximum oldest complete lines examined for a usable lifetime boundary. */
export const STREAK_HISTORY_BOUNDARY_LINE_CAP = 256;

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

function windowCoversLifetime(oldestLines: string[], createdAt: unknown): boolean {
  if (!isValidIsoDate(createdAt) || !createdAt.includes('T')) return false;
  for (const line of oldestLines) {
    let row: unknown;
    try {
      row = JSON.parse(Buffer.from(line, 'latin1').toString('utf8'));
    } catch {
      continue;
    }
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const timestamp = r['recordType'] === 'notification-delivery' ? r['settledAt'] : r['triggeredAt'];
    if (!isValidIsoDate(timestamp) || !timestamp.includes('T')) continue;
    let completedAt = Date.parse(timestamp);
    if (r['recordType'] !== 'notification-delivery') {
      const duration = r['durationMs'];
      if (!isRunRecord(row) || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        continue;
      }
      completedAt += duration;
    }
    if (!Number.isFinite(completedAt)) continue;
    // A usable completion/settlement bounds earlier appended rows, even after unusable lines.
    // A task created strictly after that completion cannot have run before this row.
    // All later rows are in the fully scanned window, so an absent task has exact empty history.
    // Use the oldest usable boundary within the line cap; equality remains conservative.
    // Guard: a future createdAt (hand-edited or imported) or a backwards clock step must not
    // produce a false "no runs yet" for a task that may have rows older than the window.
    const createdAtMs = Date.parse(createdAt);
    return createdAtMs <= Date.now() && createdAtMs > completedAt;
  }
  return false;
}

/**
 * Seek backwards up to STREAK_HISTORY_BYTE_CAP, parsing only candidate task lines
 * and, for an absent task with createdAt, a bounded prefix of complete window lines.
 * Stop at the newest snapshot or success; only legacy history needs replay.
 * A cap is inexact unless the empty window covers the task's whole lifetime.
 * Missing files mean no runs; unreadable files are explicitly indeterminate.
 */
export function readStreakHistory(path: string, taskId: string, createdAt?: string): StreakHistory {
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
    let oldestLines: string[] = [];
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
      oldestLines = lines.concat(oldestLines).slice(0, STREAK_HISTORY_BOUNDARY_LINE_CAP);
      for (let i = lines.length - 1; i >= 0; i--) {
        const rawLine = lines[i] ?? '';
        const line = Buffer.from(rawLine, 'latin1').toString('utf8');
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
    const exactEmptyWindow = stopAt > 0 && lastStatus === undefined && windowCoversLifetime(oldestLines, createdAt);
    // Legacy rows still need their own success/snapshot boundary.
    if ((stopAt > 0 && !exactEmptyWindow) || legacy.length > 0) base = { ...base, exact: false };
    return replayLegacy(base, legacy, lastStatus);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return replayLegacy({ ...base, exact: missing && legacy.length === 0 }, legacy, lastStatus);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Per-task mutable state accumulated during a single backward scan. */
interface TaskScanState {
  legacy: TelemetryRecord[];
  base: StreakSnapshot;
  lastStatus: TelemetryRecord['status'] | undefined;
  done: boolean;
  result: StreakHistory | undefined;
  createdAt: string | undefined;
}

/**
 * Read bounded history for a set of tasks in one pass over the telemetry tail.
 * Equivalent to calling readStreakHistory once per task but opens the file only once.
 * Missing files mean no runs for all tasks; unreadable files are explicitly indeterminate.
 */
export function readAllStreakHistories(
  path: string,
  tasks: ReadonlyArray<{ id: string; createdAt?: string }>,
): Map<string, StreakHistory> {
  if (tasks.length === 0) return new Map();

  // Build per-task state; key on id.
  const states = new Map<string, TaskScanState>();
  for (const t of tasks) {
    states.set(t.id, {
      legacy: [],
      base: emptyStreak(),
      lastStatus: undefined,
      done: false,
      result: undefined,
      createdAt: t.createdAt,
    });
  }

  // Pre-compute JSON needles once.
  const needles = new Map<string, string>();
  for (const t of tasks) needles.set(t.id, JSON.stringify(t.id));

  let fd: number | undefined;
  let missing = false;
  try {
    fd = openSync(path, 'r');
    let pos = fstatSync(fd).size;
    const stopAt = Math.max(0, pos - STREAK_HISTORY_BYTE_CAP);
    let suffix = '';
    let oldestLines: string[] = [];
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
      const lines = (buf.toString('latin1') + suffix).split('\n');
      suffix = pos > 0 ? (lines.shift() ?? '') : '';
      oldestLines = lines.concat(oldestLines).slice(0, STREAK_HISTORY_BOUNDARY_LINE_CAP);
      for (let i = lines.length - 1; i >= 0; i--) {
        const rawLine = lines[i] ?? '';
        // Quick check: does this line contain any task id needle?
        let matchedId: string | undefined;
        for (const [id, needle] of needles) {
          if (rawLine.includes(needle)) { matchedId = id; break; }
        }
        if (matchedId === undefined) continue;
        const st = states.get(matchedId);
        if (st === undefined || st.done) continue;
        const line = Buffer.from(rawLine, 'latin1').toString('utf8');
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; }
        if (!isRunRecord(row) || row.taskId !== matchedId) continue;
        st.lastStatus ??= row.status;
        if (isSnapshot(row.failureStreak)) {
          st.result = replayLegacy(row.failureStreak, st.legacy, st.lastStatus);
          st.done = true;
          continue;
        }
        if (row.status === 'success') {
          st.result = replayLegacy(st.base, st.legacy, st.lastStatus);
          st.done = true;
          continue;
        }
        st.legacy.push(row);
      }
    }
    // Finalise tasks not resolved to a snapshot/success boundary.
    for (const [, st] of states) {
      if (st.done) continue;
      const exactEmptyWindow = stopAt > 0 && st.lastStatus === undefined
        && windowCoversLifetime(oldestLines, st.createdAt);
      if ((stopAt > 0 && !exactEmptyWindow) || st.legacy.length > 0) {
        st.base = { ...st.base, exact: false };
      }
      st.result = replayLegacy(st.base, st.legacy, st.lastStatus);
    }
  } catch (err) {
    missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    for (const [, st] of states) {
      if (st.done) continue;
      const base = { ...st.base, exact: missing && st.legacy.length === 0 };
      st.result = replayLegacy(base, st.legacy, st.lastStatus);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const out = new Map<string, StreakHistory>();
  for (const [id, st] of states) {
    out.set(id, st.result ?? replayLegacy({ ...emptyStreak(), exact: false }, [], undefined));
  }
  return out;
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

/**
 * Handlers for schedule management tools.
 *
 * Four tools: create_schedule, list_schedules, get_schedule_history,
 * cancel_schedule. All call schedule-store.ts for persistence. Write ops
 * also attempt to live-sync to a running daemon via the port file and
 * surface the outcome as `daemonSynced`/`syncDetail` in the result — a
 * daemon that booted before the change will NOT see it until restarted,
 * and callers must be able to tell.
 *
 * Pattern: follows send-telegram.ts — manual input validation, isError: true
 * on failure, no thrown exceptions.
 *
 * @module agent/tools/handlers/schedules
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolHandler } from '../types.js';
import {
  loadSchedules,
  saveSchedules,
  addSchedule,
  removeSchedule,
  getSchedule,
} from '../../daemon/schedule-store.js';
import { getTelemetryPath, getDaemonStateDir } from '../../../paths.js';

/** Outcome of a live-sync attempt against a running daemon. */
export interface DaemonSyncResult {
  /** True when the running daemon's state matches the store after the call. */
  synced: boolean;
  /** Machine-readable detail, e.g. 'synced', 'already-registered', 'daemon-not-detected (no port file)'. */
  detail: string;
}

// TODO: extract to src/agent/daemon/http-client.ts when shared with CLI
/**
 * Attempt to notify the running daemon of a task change and report the
 * outcome. Never throws — the file store is the source of truth and a
 * failed sync must not fail the write — but the result is surfaced to the
 * caller so a daemon that will not see the change until restart is visible
 * instead of silently assumed in sync.
 *
 * End-state semantics: a 409 on POST (already registered) and a 404 on
 * DELETE (not registered) both mean the daemon already matches the desired
 * outcome, so they count as synced.
 */
async function trySyncToDaemon(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<DaemonSyncResult> {
  let port: number;
  try {
    const portFile = join(getDaemonStateDir('default'), 'port');
    if (!existsSync(portFile)) {
      return { synced: false, detail: 'daemon-not-detected (no port file)' };
    }
    const portStr = readFileSync(portFile, 'utf-8').trim();
    port = parseInt(portStr, 10);
    if (Number.isNaN(port)) {
      return { synced: false, detail: 'daemon-not-detected (invalid port file)' };
    }
  } catch {
    return { synced: false, detail: 'daemon-not-detected (unreadable port file)' };
  }
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return { synced: true, detail: 'synced' };
    if (method === 'POST' && res.status === 409) {
      return { synced: true, detail: 'already-registered' };
    }
    if (method === 'DELETE' && res.status === 404) {
      return { synced: true, detail: 'not-registered' };
    }
    return { synced: false, detail: `daemon-rejected (HTTP ${res.status})` };
  } catch {
    // STALE-FILE NOTE: port file may be stale after SIGKILL; fetch fails here.
    return { synced: false, detail: 'daemon-unreachable (stale port file or network error)' };
  }
}

/** Human-actionable note attached to results when live-sync did not land. */
const SYNC_FAILED_NOTE =
  'Change saved to schedules.json, but a running daemon (if any) did not pick it up — ' +
  'it will apply on the next daemon (re)start.';

export const createScheduleHandler: ToolHandler = async (input, _signal) => {
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected object', isError: true };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj['name'] !== 'string' || !obj['name']) {
    return { content: 'Invalid input: name required', isError: true };
  }
  if (typeof obj['command'] !== 'string' || !obj['command']) {
    return { content: 'Invalid input: command required', isError: true };
  }
  if (typeof obj['cron'] !== 'string' || !obj['cron']) {
    return { content: 'Invalid input: cron required', isError: true };
  }

  // Basic cron validation: must have 5 or 6 space-separated fields
  const cronParts = obj['cron'].trim().split(/\s+/);
  if (cronParts.length !== 5 && cronParts.length !== 6) {
    return {
      content: 'Invalid input: cron must be a 5 or 6-field expression',
      isError: true,
    };
  }

  const config = addSchedule({
    name: obj['name'] as string,
    command: obj['command'] as string,
    cron: obj['cron'] as string,
    trigger:
      (obj['trigger'] as 'cron' | 'sessionstart' | 'both' | undefined) ?? 'cron',
    notifyOn: obj['notifyOn'] as 'failure' | 'always' | 'never' | undefined,
    enabled: typeof obj['enabled'] === 'boolean' ? obj['enabled'] : true,
  });

  // Attempt live-sync to daemon. Disabled tasks are deliberately NOT
  // registered — the daemon only loads enabled tasks at boot, and live-
  // registering a disabled task would make it fire anyway.
  const sync = config.enabled
    ? await trySyncToDaemon('POST', '/tasks', {
        taskId: config.id,
        command: config.command,
        cron: config.cron,
        trigger: config.trigger,
        notifyOn: config.notifyOn,
      })
    : { synced: true, detail: 'not-applicable (task disabled)' };

  return {
    content: JSON.stringify({
      id: config.id,
      name: config.name,
      cron: config.cron,
      enabled: config.enabled,
      daemonSynced: sync.synced,
      syncDetail: sync.detail,
      ...(sync.synced ? {} : { syncNote: SYNC_FAILED_NOTE }),
    }),
  };
};

export const listSchedulesHandler: ToolHandler = async (_input, _signal) => {
  const schedules = loadSchedules();
  return {
    content: JSON.stringify(
      schedules.map((s) => ({
        id: s.id,
        name: s.name,
        cron: s.cron,
        trigger: s.trigger,
        enabled: s.enabled,
        notifyOn: s.notifyOn,
      })),
    ),
  };
};

export const getScheduleHistoryHandler: ToolHandler = async (input, _signal) => {
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected object', isError: true };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj['taskId'] !== 'string' || !obj['taskId']) {
    return { content: 'Invalid input: taskId required', isError: true };
  }
  const taskId = obj['taskId'] as string;
  const limit =
    typeof obj['limit'] === 'number' ? Math.min(Math.max(1, obj['limit']), 50) : 10;

  const telemetryPath = getTelemetryPath();
  if (!existsSync(telemetryPath)) {
    return { content: JSON.stringify([]) };
  }

  let content: string;
  try {
    // 1MB tail cap to avoid reading huge files.
    // Async read keeps the event loop responsive — telemetry files can be
    // multi-MB on long-running daemons.
    const buf = await readFile(telemetryPath);
    const tailBuf = buf.length > 1_048_576 ? buf.subarray(buf.length - 1_048_576) : buf;
    content = tailBuf.toString('utf-8');
  } catch {
    return { content: JSON.stringify([]) };
  }

  const lines = content.split('\n');
  const matching: unknown[] = [];
  // Reverse scan (newest first) — mirror gates.ts pattern exactly
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue; // noUncheckedIndexedAccess guard
    try {
      const record = JSON.parse(line) as { taskId?: string };
      if (record.taskId !== taskId) continue;
      matching.push(record);
      if (matching.length >= limit) break;
    } catch {
      continue;
    }
  }

  // Return in chronological order (oldest first)
  return { content: JSON.stringify(matching.reverse()) };
};

export const cancelScheduleHandler: ToolHandler = async (input, _signal) => {
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected object', isError: true };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj['taskId'] !== 'string' || !obj['taskId']) {
    return { content: 'Invalid input: taskId required', isError: true };
  }
  const taskId = obj['taskId'] as string;
  const permanent = obj['permanent'] === true;

  const existing = getSchedule(taskId);
  if (!existing) {
    return { content: JSON.stringify({ error: 'task not found' }) };
  }

  let sync: DaemonSyncResult;
  if (permanent) {
    removeSchedule(taskId);
    sync = await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
  } else {
    const schedules = loadSchedules();
    const updated = schedules.map((s) =>
      s.id === taskId ? { ...s, enabled: false, updatedAt: new Date().toISOString() } : s,
    );
    saveSchedules(updated);
    // Unregister from running daemon — task won't auto-restart unless daemon restarts
    sync = await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
  }

  return {
    content: JSON.stringify({
      ok: true,
      taskId,
      permanent,
      daemonSynced: sync.synced,
      syncDetail: sync.detail,
      ...(sync.synced ? {} : { syncNote: SYNC_FAILED_NOTE }),
    }),
  };
};

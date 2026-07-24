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

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ToolHandler } from '../types.js';
import {
  loadSchedules,
  saveSchedules,
  addSchedule,
  removeSchedule,
  getSchedule,
} from '../../daemon/schedule-store.js';
import { getTelemetryPath } from '../../../paths.js';
import {
  type DaemonSyncResult,
  trySyncToDaemon,
  SYNC_FAILED_NOTE,
} from '../../daemon/http-client.js';

export type { DaemonSyncResult };

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

  const notifyChat = obj['notifyChat'];
  if (notifyChat !== undefined && typeof notifyChat !== 'number' && typeof notifyChat !== 'string') {
    return {
      content: 'Invalid input: notifyChat must be a number (chat id) or string (chat id or alias name)',
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
    ...(notifyChat !== undefined ? { notifyChat: notifyChat as number | string } : {}),
    enabled: typeof obj['enabled'] === 'boolean' ? obj['enabled'] : true,
  });

  // Attempt live-sync to daemon. Enabled tasks are POST-registered. Disabled
  // tasks send an idempotent DELETE so any stale live registration (e.g. a
  // re-create-as-disabled over an existing enabled id) is removed — a 404
  // (not registered) counts as synced under end-state semantics.
  const sync = config.enabled
    ? await trySyncToDaemon('POST', '/tasks', {
        taskId: config.id,
        command: config.command,
        cron: config.cron,
        trigger: config.trigger,
        notifyOn: config.notifyOn,
        ...(config.notifyChat !== undefined ? { notifyChat: config.notifyChat } : {}),
      })
    : await trySyncToDaemon('DELETE', `/tasks/${config.id}`);

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

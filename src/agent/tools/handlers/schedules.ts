/**
 * Handlers for schedule management tools.
 *
 * Four tools: create_schedule, list_schedules, get_schedule_history,
 * cancel_schedule. All call schedule-store.ts for persistence. Write ops
 * also attempt to live-sync to a running daemon via the port file.
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

// TODO: extract to src/agent/daemon/http-client.ts when shared with CLI
/**
 * Attempt to notify the running daemon of a task change.
 * Swallows all errors silently — file store is the source of truth.
 * STALE-FILE NOTE: port file may be stale after SIGKILL; fetch will fail
 * and be silently swallowed.
 */
async function trySyncToDaemon(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<void> {
  try {
    const portFile = join(getDaemonStateDir('default'), 'port');
    if (!existsSync(portFile)) return;
    const portStr = readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(portStr, 10);
    if (Number.isNaN(port)) return;
    await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Daemon not running or unreachable — silent failure
  }
}

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

  // Attempt live-sync to daemon
  await trySyncToDaemon('POST', '/tasks', {
    taskId: config.id,
    command: config.command,
    cron: config.cron,
    trigger: config.trigger,
    notifyOn: config.notifyOn,
  });

  return {
    content: JSON.stringify({
      id: config.id,
      name: config.name,
      cron: config.cron,
      enabled: config.enabled,
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

  if (permanent) {
    removeSchedule(taskId);
    await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
  } else {
    const schedules = loadSchedules();
    const updated = schedules.map((s) =>
      s.id === taskId ? { ...s, enabled: false, updatedAt: new Date().toISOString() } : s,
    );
    saveSchedules(updated);
    // Unregister from running daemon — task won't auto-restart unless daemon restarts
    await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
  }

  return { content: JSON.stringify({ ok: true, taskId, permanent }) };
};

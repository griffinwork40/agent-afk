/**
 * Handlers for schedule management tools.
 *
 * Five tools: create_schedule, update_schedule, list_schedules,
 * get_schedule_history, cancel_schedule. All call schedule-store.ts for persistence. Write ops
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

import type { ToolHandler } from '../types.js';
import {
  loadSchedules,
  addSchedule,
  removeSchedule,
  getSchedule,
  toggleScheduleEnabled,
  updateSchedule,
  toScheduledTask,
} from '../../daemon/schedule-store.js';
import { validateScheduleCwd } from '../../daemon/cwd-validator.js';
import { getTelemetryPath } from '../../../paths.js';
import {
  type DaemonSyncResult,
  trySyncToDaemon,
  SYNC_FAILED_NOTE,
} from '../../daemon/http-client.js';
import { readTelemetryHistory } from '../../daemon/telemetry-reader.js';
import { parseTaskRetryFields } from '../../daemon/task-retry.js';

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

  // Basic cron validation: must have exactly 5 space-separated fields (no year)
  const cronParts = obj['cron'].trim().split(/\s+/);
  if (cronParts.length !== 5) {
    return {
      content: 'Invalid input: cron must be a 5-field expression (no year field)',
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

  const executor = obj['executor'] as 'agent' | 'shell' | undefined;
  if (executor !== undefined && executor !== 'agent' && executor !== 'shell') {
    return {
      content: 'Invalid input: executor must be "agent" or "shell"',
      isError: true,
    };
  }

  const retry = parseTaskRetryFields(obj);
  if (!retry.ok) return { content: `Invalid input: ${retry.error}`, isError: true };

  // Validate runAt when supplied.
  const rawRunAt = obj['runAt'];
  let resolvedRunAt: string | undefined;
  if (rawRunAt !== undefined) {
    if (typeof rawRunAt !== 'string') {
      return { content: 'Invalid input: runAt must be an ISO 8601 string', isError: true };
    }
    if (isNaN(Date.parse(rawRunAt))) {
      return { content: 'Invalid input: runAt must be a valid ISO 8601 date string', isError: true };
    }
    resolvedRunAt = rawRunAt;
  }

  // Validate expiresAt when supplied.
  const rawExpiresAt = obj['expiresAt'];
  let resolvedExpiresAt: string | undefined;
  if (rawExpiresAt !== undefined) {
    if (typeof rawExpiresAt !== 'string') {
      return { content: 'Invalid input: expiresAt must be an ISO 8601 string', isError: true };
    }
    if (isNaN(Date.parse(rawExpiresAt))) {
      return { content: 'Invalid input: expiresAt must be a valid ISO 8601 date string', isError: true };
    }
    resolvedExpiresAt = rawExpiresAt;
  }

  // Validate per-task cwd when supplied.
  const rawCwd = obj['cwd'];
  let resolvedCwd: string | undefined;
  if (rawCwd !== undefined) {
    if (typeof rawCwd !== 'string' || !rawCwd) {
      return { content: 'Invalid input: cwd must be a non-empty string', isError: true };
    }
    const cwdResult = validateScheduleCwd(rawCwd);
    if (!cwdResult.ok) {
      return { content: `Invalid input: ${cwdResult.error}`, isError: true };
    }
    resolvedCwd = cwdResult.resolved;
  }

  const config = addSchedule({
    name: obj['name'] as string,
    command: obj['command'] as string,
    cron: obj['cron'] as string,
    ...(executor !== undefined ? { executor } : {}),
    trigger:
      (obj['trigger'] as 'cron' | 'sessionstart' | 'both' | undefined) ?? 'cron',
    notifyOn: obj['notifyOn'] as 'failure' | 'always' | 'never' | undefined,
    ...(notifyChat !== undefined ? { notifyChat: notifyChat as number | string } : {}),
    ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
    ...(resolvedRunAt !== undefined ? { runAt: resolvedRunAt } : {}),
    ...(resolvedExpiresAt !== undefined ? { expiresAt: resolvedExpiresAt } : {}),
    ...retry.value,
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
        ...(config.executor !== undefined ? { executor: config.executor } : {}),
        trigger: config.trigger,
        notifyOn: config.notifyOn,
        ...(config.notifyChat !== undefined ? { notifyChat: config.notifyChat } : {}),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
        ...(config.retryDelayMs !== undefined ? { retryDelayMs: config.retryDelayMs } : {}),
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

export const updateScheduleHandler: ToolHandler = async (input, _signal) => {
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected object', isError: true };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj['taskId'] !== 'string' || !obj['taskId']) {
    return { content: 'Invalid input: taskId required', isError: true };
  }
  const taskId = obj['taskId'] as string;

  // Validate taskId is a slug-safe identifier before using it in daemon sync URLs
  if (!/^[a-z0-9-]+$/.test(taskId)) {
    return { content: 'Invalid input: taskId must be a valid slug (lowercase alphanumeric and hyphens)', isError: true };
  }

  // Validate optional fields when present
  const cron = obj['cron'];
  if (cron !== undefined) {
    if (typeof cron !== 'string') {
      return { content: 'Invalid input: cron must be a string', isError: true };
    }
    const cronParts = cron.trim().split(/\s+/);
    if (cronParts.length !== 5) {
      return {
        content: 'Invalid input: cron must be a 5-field expression (no year field)',
        isError: true,
      };
    }
  }

  const executor = obj['executor'];
  if (executor !== undefined && executor !== 'agent' && executor !== 'shell') {
    return {
      content: 'Invalid input: executor must be "agent" or "shell"',
      isError: true,
    };
  }

  const trigger = obj['trigger'];
  if (trigger !== undefined && trigger !== 'cron' && trigger !== 'sessionstart' && trigger !== 'both') {
    return {
      content: 'Invalid input: trigger must be "cron", "sessionstart", or "both"',
      isError: true,
    };
  }

  const notifyOn = obj['notifyOn'];
  if (notifyOn !== undefined && notifyOn !== 'failure' && notifyOn !== 'always' && notifyOn !== 'never') {
    return {
      content: 'Invalid input: notifyOn must be "failure", "always", or "never"',
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

  const retry = parseTaskRetryFields(obj);
  if (!retry.ok) return { content: `Invalid input: ${retry.error}`, isError: true };

  // Validate per-task cwd when supplied.
  // null or "" means "unset" — removes the per-task cwd so the task falls back
  // to the daemon-wide default. A non-empty string is validated as a directory.
  const rawCwd = obj['cwd'];
  let resolvedCwd: string | null | undefined;
  if (rawCwd !== undefined) {
    if (rawCwd === null || rawCwd === '') {
      // Explicit clear: remove the per-task cwd pin.
      resolvedCwd = null;
    } else if (typeof rawCwd !== 'string') {
      return { content: 'Invalid input: cwd must be a string, null, or "" to clear', isError: true };
    } else {
      const cwdResult = validateScheduleCwd(rawCwd);
      if (!cwdResult.ok) {
        return { content: `Invalid input: ${cwdResult.error}`, isError: true };
      }
      resolvedCwd = cwdResult.resolved;
    }
  }

  // Validate runAt when supplied (string = set, null = clear).
  const rawRunAt = obj['runAt'];
  let patchRunAt: string | null | undefined;
  if (rawRunAt !== undefined) {
    if (rawRunAt === null) {
      patchRunAt = null;
    } else if (typeof rawRunAt !== 'string') {
      return { content: 'Invalid input: runAt must be an ISO 8601 string or null to clear', isError: true };
    } else if (isNaN(Date.parse(rawRunAt))) {
      return { content: 'Invalid input: runAt must be a valid ISO 8601 date string', isError: true };
    } else {
      patchRunAt = rawRunAt;
    }
  }

  // Validate expiresAt when supplied (string = set, null = clear).
  const rawExpiresAt = obj['expiresAt'];
  let patchExpiresAt: string | null | undefined;
  if (rawExpiresAt !== undefined) {
    if (rawExpiresAt === null) {
      patchExpiresAt = null;
    } else if (typeof rawExpiresAt !== 'string') {
      return { content: 'Invalid input: expiresAt must be an ISO 8601 string or null to clear', isError: true };
    } else if (isNaN(Date.parse(rawExpiresAt))) {
      return { content: 'Invalid input: expiresAt must be a valid ISO 8601 date string', isError: true };
    } else {
      patchExpiresAt = rawExpiresAt;
    }
  }

  // Build the patch from supplied fields only
  type Patch = Parameters<typeof updateSchedule>[1];
  const patch: Patch = {};
  if (typeof obj['name'] === 'string' && obj['name']) patch.name = obj['name'];
  if (typeof obj['command'] === 'string' && obj['command']) patch.command = obj['command'];
  if (typeof cron === 'string') patch.cron = cron;
  if (executor !== undefined) patch.executor = executor as Patch['executor'];
  if (trigger !== undefined) patch.trigger = trigger as Patch['trigger'];
  if (notifyOn !== undefined) patch.notifyOn = notifyOn as Patch['notifyOn'];
  if (notifyChat !== undefined) patch.notifyChat = notifyChat as number | string;
  if (typeof obj['enabled'] === 'boolean') patch.enabled = obj['enabled'];
  if (resolvedCwd !== undefined) patch.cwd = resolvedCwd;
  if (patchRunAt !== undefined) patch.runAt = patchRunAt;
  if (patchExpiresAt !== undefined) patch.expiresAt = patchExpiresAt;
  Object.assign(patch, retry.value);

  const updated = updateSchedule(taskId, patch);
  if (!updated) {
    return { content: JSON.stringify({ error: 'task not found' }) };
  }

  // Daemon sync: if enabled, DELETE stale registration then re-register;
  // if disabled, just DELETE.
  let sync: DaemonSyncResult;
  if (updated.enabled) {
    await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
    sync = await trySyncToDaemon('POST', '/tasks', toScheduledTask(updated));
  } else {
    sync = await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
  }

  return {
    content: JSON.stringify({
      id: updated.id,
      name: updated.name,
      cron: updated.cron,
      enabled: updated.enabled,
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
        executor: s.executor ?? 'agent',
        trigger: s.trigger,
        enabled: s.enabled,
        notifyOn: s.notifyOn,
        ...(s.maxAttempts !== undefined ? { maxAttempts: s.maxAttempts } : {}),
        ...(s.retryDelayMs !== undefined ? { retryDelayMs: s.retryDelayMs } : {}),
        ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
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
  const matching = await readTelemetryHistory(telemetryPath, { taskId, limit });
  return { content: JSON.stringify(matching) };
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
  const enable = obj['enable'] === true;

  // Invariant: pre-existing TOCTOU window — the store is checked for existence
  // here via getSchedule and then mutated below via toggleScheduleEnabled / removeSchedule.
  // A concurrent writer could delete the schedule between these two calls, which would
  // make toggleScheduleEnabled return undefined (handled: updated! is safe because
  // existing was confirmed) or removeSchedule silently no-op. This window is
  // pre-existing and not a regression; the store is a local file accessed from a
  // single-process daemon, so concurrent mutations are rare in practice.
  const existing = getSchedule(taskId);
  if (!existing) {
    return { content: JSON.stringify({ error: 'task not found' }) };
  }

  let sync: DaemonSyncResult;
  if (permanent) {
    removeSchedule(taskId);
    sync = await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
  } else if (enable) {
    // Re-enable a previously disabled task and register with daemon
    const updated = toggleScheduleEnabled(taskId, true);
    // updated is always defined here: existing was confirmed above and the
    // store is consistent, so the id will be found.
    sync = await trySyncToDaemon('POST', '/tasks', toScheduledTask(updated!));
  } else {
    toggleScheduleEnabled(taskId, false);
    // Unregister from running daemon — task won't auto-restart unless daemon restarts
    sync = await trySyncToDaemon('DELETE', `/tasks/${taskId}`);
  }

  return {
    content: JSON.stringify({
      ok: true,
      taskId,
      permanent,
      enabled: permanent ? undefined : enable ? true : false,
      daemonSynced: sync.synced,
      syncDetail: sync.detail,
      ...(sync.synced ? {} : { syncNote: SYNC_FAILED_NOTE }),
    }),
  };
};

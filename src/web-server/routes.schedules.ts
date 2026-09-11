/**
 * Schedule CRUD routes for the `afk web` surface.
 *
 * Contract: these handlers are dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. They read/write `schedules.json` via
 * the same store functions the CLI and agent tools use, and attempt live-sync
 * to a running daemon via `http-client.ts`. The file store is the source of
 * truth; a failed sync is surfaced, never thrown.
 */

import type { ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  addSchedule,
  getSchedule,
  loadSchedules,
  removeSchedule,
  saveSchedules,
  toScheduledTask,
  type ScheduledTaskConfig,
} from '../agent/daemon/schedule-store.js';
import { trySyncToDaemon, SYNC_FAILED_NOTE, parsePortFile } from '../agent/daemon/http-client.js';
import { getTelemetryPath, getDaemonStateDir } from '../paths.js';
import { sendJson } from './routes.js';
import { join } from 'node:path';

const VALID_TRIGGERS = new Set(['cron', 'sessionstart', 'both']);
const VALID_NOTIFY_ON = new Set(['failure', 'always', 'never']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const VALID_ID_RE = /^[a-z0-9-]+$/;

/** Return true if `id` is a valid slugified schedule identifier. */
function isValidId(id: string): boolean {
  return VALID_ID_RE.test(id);
}

// ---- helpers ---------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const v = body[field];
  return typeof v === 'string' ? v : undefined;
}

function bool(body: unknown, field: string): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const v = body[field];
  return typeof v === 'boolean' ? v : undefined;
}

/** Minimal cron expression validation: 5 or 6 space-separated fields. */
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

// ---- route handlers --------------------------------------------------------

/** `GET /api/schedules` — list all scheduled tasks. */
export async function handleListSchedules(res: ServerResponse): Promise<void> {
  const schedules = loadSchedules();
  sendJson(res, 200, { schedules });
}

/** `POST /api/schedules` — create a new scheduled task. */
export async function handleCreateSchedule(
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const name = str(body, 'name');
  const command = str(body, 'command');
  const cron = str(body, 'cron');
  if (!name || !command || !cron) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: 'body must include name (string), command (string), and cron (string)',
    });
    return;
  }
  if (!isValidCron(cron)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: 'cron must be a valid 5- or 6-field cron expression',
    });
    return;
  }

  const trigger = str(body, 'trigger');
  const notifyOn = str(body, 'notifyOn');
  if (trigger !== undefined && !VALID_TRIGGERS.has(trigger)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: `trigger must be one of: ${[...VALID_TRIGGERS].join(', ')}`,
    });
    return;
  }
  if (notifyOn !== undefined && !VALID_NOTIFY_ON.has(notifyOn)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: `notifyOn must be one of: ${[...VALID_NOTIFY_ON].join(', ')}`,
    });
    return;
  }
  const enabled = bool(body, 'enabled') ?? true;

  const config = addSchedule({
    name,
    command,
    cron,
    trigger: trigger as ScheduledTaskConfig['trigger'],
    notifyOn: notifyOn as ScheduledTaskConfig['notifyOn'],
    enabled,
  });

  let daemonSynced = false;
  let syncDetail = '';
  if (config.enabled) {
    const sync = await trySyncToDaemon('POST', '/tasks', toScheduledTask(config));
    daemonSynced = sync.synced;
    syncDetail = sync.detail;
  }

  sendJson(res, 201, {
    schedule: config,
    daemonSynced,
    syncDetail,
    ...(!daemonSynced && config.enabled ? { syncNote: SYNC_FAILED_NOTE } : {}),
  });
}

/** `PATCH /api/schedules/:id` — update fields on an existing task. */
export async function handleUpdateSchedule(
  res: ServerResponse,
  id: string,
  body: unknown,
): Promise<void> {
  if (!isValidId(id)) {
    sendJson(res, 400, { error: 'bad_request', message: 'invalid schedule id format' });
    return;
  }
  const schedules = loadSchedules();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) {
    sendJson(res, 404, { error: 'not_found', message: `schedule ${id} not found` });
    return;
  }

  const existing = schedules[idx] as ScheduledTaskConfig;
  const name = str(body, 'name');
  const command = str(body, 'command');
  const cron = str(body, 'cron');
  const trigger = str(body, 'trigger');
  const notifyOn = str(body, 'notifyOn');
  const enabled = bool(body, 'enabled');

  if (trigger !== undefined && !VALID_TRIGGERS.has(trigger)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: `trigger must be one of: ${[...VALID_TRIGGERS].join(', ')}`,
    });
    return;
  }
  if (notifyOn !== undefined && !VALID_NOTIFY_ON.has(notifyOn)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: `notifyOn must be one of: ${[...VALID_NOTIFY_ON].join(', ')}`,
    });
    return;
  }

  if (cron !== undefined && !isValidCron(cron)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: 'cron must be a valid 5- or 6-field cron expression',
    });
    return;
  }

  const updated: ScheduledTaskConfig = {
    ...existing,
    ...(name !== undefined ? { name } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(cron !== undefined ? { cron } : {}),
    ...(trigger !== undefined ? { trigger: trigger as ScheduledTaskConfig['trigger'] } : {}),
    ...(notifyOn !== undefined ? { notifyOn: notifyOn as ScheduledTaskConfig['notifyOn'] } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    updatedAt: new Date().toISOString(),
  };

  schedules[idx] = updated;
  saveSchedules(schedules);

  // Sync: if enabled, re-register; if disabled, unregister.
  let daemonSynced = false;
  let syncDetail = '';
  if (updated.enabled) {
    // Delete first to clear stale registration, then re-register.
    await trySyncToDaemon('DELETE', `/tasks/${id}`);
    const sync = await trySyncToDaemon('POST', '/tasks', toScheduledTask(updated));
    daemonSynced = sync.synced;
    syncDetail = sync.detail;
  } else {
    const sync = await trySyncToDaemon('DELETE', `/tasks/${id}`);
    daemonSynced = sync.synced;
    syncDetail = sync.detail;
  }

  sendJson(res, 200, {
    schedule: updated,
    daemonSynced,
    syncDetail,
    ...(daemonSynced ? {} : { syncNote: SYNC_FAILED_NOTE }),
  });
}

/** `DELETE /api/schedules/:id` — permanently remove a scheduled task. */
export async function handleDeleteSchedule(
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (!isValidId(id)) {
    sendJson(res, 400, { error: 'bad_request', message: 'invalid schedule id format' });
    return;
  }
  const removed = removeSchedule(id);
  if (!removed) {
    sendJson(res, 404, { error: 'not_found', message: `schedule ${id} not found` });
    return;
  }

  const sync = await trySyncToDaemon('DELETE', `/tasks/${id}`);
  sendJson(res, 200, {
    ok: true,
    daemonSynced: sync.synced,
    syncDetail: sync.detail,
    ...(sync.synced ? {} : { syncNote: SYNC_FAILED_NOTE }),
  });
}

/** `POST /api/schedules/:id/toggle` — quick enable/disable. */
export async function handleToggleSchedule(
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (!isValidId(id)) {
    sendJson(res, 400, { error: 'bad_request', message: 'invalid schedule id format' });
    return;
  }
  const existing = getSchedule(id);
  if (!existing) {
    sendJson(res, 404, { error: 'not_found', message: `schedule ${id} not found` });
    return;
  }

  const newEnabled = !existing.enabled;
  const schedules = loadSchedules();
  const updated = schedules.map((s) =>
    s.id === id ? { ...s, enabled: newEnabled, updatedAt: new Date().toISOString() } : s,
  );
  saveSchedules(updated);

  let sync;
  if (newEnabled) {
    sync = await trySyncToDaemon(
      'POST',
      '/tasks',
      toScheduledTask({ ...existing, enabled: true }),
    );
  } else {
    sync = await trySyncToDaemon('DELETE', `/tasks/${id}`);
  }

  sendJson(res, 200, {
    ok: true,
    enabled: newEnabled,
    daemonSynced: sync.synced,
    syncDetail: sync.detail,
    ...(sync.synced ? {} : { syncNote: SYNC_FAILED_NOTE }),
  });
}

/** `GET /api/schedules/:id/history` — recent execution history. */
export async function handleScheduleHistory(
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (!isValidId(id)) {
    sendJson(res, 400, { error: 'bad_request', message: 'invalid schedule id format' });
    return;
  }
  const telemetryPath = getTelemetryPath();
  if (!existsSync(telemetryPath)) {
    sendJson(res, 200, { history: [] });
    return;
  }

  let content: string;
  try {
    const buf = await readFile(telemetryPath);
    const tailBuf = buf.length > 1_048_576 ? buf.subarray(buf.length - 1_048_576) : buf;
    content = tailBuf.toString('utf-8');
  } catch {
    sendJson(res, 200, { history: [] });
    return;
  }

  const lines = content.split('\n');
  const matching: unknown[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { taskId?: string };
      if (record.taskId !== id) continue;
      matching.push(record);
      if (matching.length >= 20) break;
    } catch {
      continue;
    }
  }

  sendJson(res, 200, { history: matching.reverse() });
}

/** `GET /api/daemon/status` — probe whether the daemon is reachable. */
export async function handleDaemonStatus(res: ServerResponse): Promise<void> {
  // Reuse the same port-file + HTTP discovery the sync client uses, but
  // target /health instead of /tasks.
  try {
    const portFile = join(getDaemonStateDir('default'), 'port');
    if (!existsSync(portFile)) {
      sendJson(res, 200, { running: false, detail: 'no port file' });
      return;
    }

    const raw = (await readFile(portFile, 'utf-8')).trim();
    const parsed = parsePortFile(raw);
    if (!parsed) {
      sendJson(res, 200, { running: false, detail: 'invalid port file' });
      return;
    }

    // SSRF guard: only connect to loopback addresses.
    if (!LOOPBACK_HOSTS.has(parsed.host.toLowerCase())) {
      sendJson(res, 200, { running: false, detail: 'non-loopback host in port file rejected' });
      return;
    }

    const hostInUrl = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host;
    const response = await fetch(`http://${hostInUrl}:${parsed.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const data = (await response.json()) as { status?: string; tasks?: number };
      sendJson(res, 200, { running: true, tasks: data.tasks ?? 0 });
    } else {
      sendJson(res, 200, { running: false, detail: `HTTP ${response.status}` });
    }
  } catch {
    sendJson(res, 200, { running: false, detail: 'unreachable' });
  }
}

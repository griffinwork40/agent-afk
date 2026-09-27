/**
 * Persistent store for scheduled task configurations.
 *
 * Persists to `~/.afk/config/schedules.json` (default). All writes are
 * atomic (temp + rename) to avoid leaving a half-written file. Missing file
 * returns an empty array. JSON parse failures log to stderr and return [].
 *
 * Read-modify-write operations (`addSchedule`, `removeSchedule`,
 * `updateSchedule`) are guarded by an `O_EXCL` advisory lockfile so that
 * concurrent callers (parallel agents, CLI + daemon HTTP handler, or two
 * REPL sessions) cannot silently drop each other's changes.
 *
 * @module agent/daemon/schedule-store
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getSchedulesPath } from '../../paths.js';
import type { ScheduledTask, TaskExecutor } from './triggers.js';
import { errorMessage } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Advisory file lock (O_EXCL)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 15_000;

/**
 * Run `fn` under an O_EXCL advisory lock on `storePath + ".lock"`.
 * Stale locks (older than LOCK_STALE_MS) are removed and retried.
 * Throws if the lock cannot be acquired within LOCK_TIMEOUT_MS.
 */
function withFileLock<T>(storePath: string, fn: () => T): T {
  const lp = `${storePath}.lock`;
  mkdirSync(dirname(lp), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // Acquire: open with O_EXCL — fails EEXIST if already held.
  while (Date.now() < deadline) {
    try {
      closeSync(openSync(lp, 'wx'));
      break; // lock acquired
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;
      // Remove stale lock left by a killed process.
      try {
        if (Date.now() - statSync(lp).mtimeMs > LOCK_STALE_MS) unlinkSync(lp);
      } catch { /* removed concurrently — retry */ }
      const wait = Math.min(LOCK_POLL_MS, deadline - Date.now());
      if (wait <= 0) throw new Error(`[schedule-store] lock timeout: ${lp}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lp); } catch { /* best effort */ }
  }
}

export interface ScheduledTaskConfig {
  /** Slug ID, e.g. "nightly-forge". Auto-generated from `name` via `slugify`. */
  id: string;
  /** Human-readable label, e.g. "Nightly forge friction". */
  name: string;
  /**
   * Meaning depends on `executor`:
   * - `'agent'` (default): prompt sent as a user message (e.g. "/forge-friction --auto").
   * - `'shell'`: shell command run via `/bin/sh -c` (e.g. "pg_dump mydb > /backups/nightly.sql").
   */
  command: string;
  /** 5- or 6-field cron expression, e.g. "0 2 * * *". */
  cron: string;
  /**
   * Per-task working directory (absolute path). When set, the spawned session's
   * cwd is pinned to this directory instead of the daemon-wide `AFK_DAEMON_CWD`.
   * Precedence: task.cwd ?? AFK_DAEMON_CWD ?? process.cwd().
   * Must be an existing directory; tilde (~) is expanded at save time.
   */
  cwd?: string;
  /**
   * Execution strategy. Default: `'agent'` (spawn an AgentSession).
   * `'shell'` runs the command as a raw shell command with no agent session.
   * Builtins are not user-creatable -- they are registered internally.
   */
  executor?: Exclude<TaskExecutor, 'builtin'>;
  /** Trigger mode. Default: 'cron'. */
  trigger?: 'cron' | 'sessionstart' | 'both';
  /** Whether the task is active. */
  enabled: boolean;
  /**
   * Controls when out-of-band notifications fire for this task.
   * 'always'  — notify on every completion
   * 'failure' — notify only when status === 'error'
   * 'never'   — never notify
   * Omitting preserves legacy behavior (callback always fires).
   */
  notifyOn?: 'failure' | 'always' | 'never';
  /**
   * Optional explicit chat target for this task's completion notification.
   * A number is a raw Telegram chat id; a string is either a numeric id or a
   * name resolved via afk.config.json `telegram.chatAliases`. Threaded through
   * to `ScheduledTask.notifyChat`; the daemon resolves + allowlist-gates it at
   * completion-push time. Omitting it preserves default routing.
   */
  notifyChat?: number | string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * Load all scheduled task configs from the store.
 * Returns [] when the file is missing or contains invalid JSON.
 */
export function loadSchedules(path?: string): ScheduledTaskConfig[] {
  const storePath = path ?? getSchedulesPath();
  if (!existsSync(storePath)) return [];
  try {
    const raw = readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as ScheduledTaskConfig[];
  } catch (err) {
    const msg = errorMessage(err);
    // eslint-disable-next-line no-console
    console.error(`[schedule-store] failed to parse ${storePath}: ${msg}`);
    return [];
  }
}

/**
 * Atomically write a schedule list to the store.
 * Creates parent directories if needed.
 */
export function saveSchedules(configs: ScheduledTaskConfig[], path?: string): void {
  const storePath = path ?? getSchedulesPath();
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = join(
    dirname(storePath),
    `.schedules.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const payload = JSON.stringify(configs, null, 2);
  try {
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, storePath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/**
 * Add a new schedule. Generates the slug ID, resolves collisions, and
 * timestamps createdAt/updatedAt. Returns the completed config.
 *
 * If `notifyOn` is omitted, defaults to `'failure'` — schedules created
 * through this entry point (user CLI + model tools) are quiet-by-default.
 * The runtime guard in `CronScheduler.fireOnTaskComplete` treats `undefined`
 * as legacy pass-through (= always notify), so we materialize the default
 * here at write time. Tasks registered through other paths (e.g. the
 * built-in `worktree-prune` task) intentionally retain legacy behavior.
 *
 * The read-modify-write is wrapped in an advisory lockfile so concurrent
 * callers cannot silently clobber each other's additions.
 */
export function addSchedule(
  config: Omit<ScheduledTaskConfig, 'id' | 'createdAt' | 'updatedAt'>,
  path?: string,
): ScheduledTaskConfig {
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedules(storePath);
    const existing = schedules.map((s) => s.id);
    const base = slugify(config.name);
    const id = resolveSlugCollision(base, existing);
    const now = new Date().toISOString();
    const newConfig: ScheduledTaskConfig = {
      ...config,
      notifyOn: config.notifyOn ?? 'failure',
      id,
      createdAt: now,
      updatedAt: now,
    };
    schedules.push(newConfig);
    saveSchedules(schedules, storePath);
    return newConfig;
  });
}

/**
 * Remove a schedule by ID. Returns true if removed, false if not found.
 *
 * The read-modify-write is wrapped in an advisory lockfile so concurrent
 * callers cannot silently clobber each other's removals.
 */
export function removeSchedule(id: string, path?: string): boolean {
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedules(storePath);
    const before = schedules.length;
    const filtered = schedules.filter((s) => s.id !== id);
    if (filtered.length === before) return false;
    saveSchedules(filtered, storePath);
    return true;
  });
}

/**
 * Get a single schedule by ID. Returns undefined if not found.
 */
export function getSchedule(id: string, path?: string): ScheduledTaskConfig | undefined {
  return loadSchedules(path).find((s) => s.id === id);
}

/** Patchable fields for `updateSchedule`. Excludes `id` and `createdAt`. */
export type SchedulePatch = Partial<Omit<ScheduledTaskConfig, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Patch one or more fields on an existing schedule. Atomically loads,
 * merges only the supplied fields, stamps `updatedAt`, and saves.
 *
 * Returns the updated config, or undefined if the ID is not found.
 *
 * This is the canonical update primitive — the agent tool handler, the
 * web-server PATCH route, and `toggleScheduleEnabled` all delegate here
 * so field-merge logic stays in one place.
 *
 * The read-modify-write is wrapped in an advisory lockfile so concurrent
 * callers cannot silently clobber each other's patches.
 */
export function updateSchedule(
  id: string,
  patch: SchedulePatch,
  path?: string,
): ScheduledTaskConfig | undefined {
  const storePath = path ?? getSchedulesPath();
  return withFileLock(storePath, () => {
    const schedules = loadSchedules(storePath);
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    const existing = schedules[idx]!;
    const updated: ScheduledTaskConfig = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.executor !== undefined ? { executor: patch.executor } : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
      ...(patch.notifyOn !== undefined ? { notifyOn: patch.notifyOn } : {}),
      ...(patch.notifyChat !== undefined ? { notifyChat: patch.notifyChat } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      updatedAt: new Date().toISOString(),
    };
    schedules[idx] = updated;
    saveSchedules(schedules, storePath);
    return updated;
  });
}

/**
 * Toggle a schedule's enabled state. Atomically loads, updates, and saves.
 *
 * Returns the updated config, or undefined if the ID is not found.
 *
 * This is the single source of truth for enable/disable persistence — the CLI
 * commands and the cancel_schedule tool handler all delegate here so the
 * toggle logic stays in one place and no fields are silently dropped.
 */
export function toggleScheduleEnabled(
  id: string,
  enabled: boolean,
  path?: string,
): ScheduledTaskConfig | undefined {
  return updateSchedule(id, { enabled }, path);
}

/**
 * Convert a human-readable name into a URL/file-safe slug.
 * Lowercases, replaces non-alphanumeric chars with hyphens, collapses
 * consecutive hyphens, and strips leading/trailing hyphens.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Given a base slug and the set of existing IDs, return a unique slug.
 * Appends `-2`, `-3`, etc. until the slug is unique.
 */
export function resolveSlugCollision(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

/**
 * Map a `ScheduledTaskConfig` to a `ScheduledTask` (daemon trigger shape).
 */
export function toScheduledTask(config: ScheduledTaskConfig): ScheduledTask {
  return {
    taskId: config.id,
    command: config.command,
    trigger: config.trigger ?? 'cron',
    ...(config.executor !== undefined ? { executor: config.executor } : {}),
    ...(config.cron !== undefined ? { cronExpression: config.cron } : {}),
    ...(config.notifyOn !== undefined ? { notifyOn: config.notifyOn } : {}),
    ...(config.notifyChat !== undefined ? { notifyChat: config.notifyChat } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  };
}
